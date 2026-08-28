#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createReviewState,
  readReviewState,
  writeReviewState,
} from '@adcp/ladon-reviewer/state'
import { materializeBundle } from '../bundle.mjs'
import { validateFixture } from '../replay.mjs'

const serverName = 'ladon-findings'
const finalizationPrompt = `Finalize the existing Ladon review now. Do not inspect files, run commands,
add findings, or repeat the review. Call finalize_review exactly once with a
concise 1-3 sentence summary of the completed analysis. Set analysis_complete
true only if the prior session completed all required coverage; otherwise set
it false so the review remains fail-closed. Stop immediately after the tool
call.`

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolvePromise(JSON.parse(input)))
    process.stdin.on('error', rejectPromise)
  })
}

function positiveNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return number
}

function sanitizedEnvironment(home) {
  const environment = { HOME: home }
  for (const key of [
    'CI',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'NO_PROXY',
    'PATH',
    'SSL_CERT_FILE',
    'TMPDIR',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

function runGemini(binary, args, { cwd, home, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now()
    const detached = process.platform !== 'win32'
    const child = spawn(binary, args, {
      cwd,
      detached,
      env: sanitizedEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    const timeout = setTimeout(() => {
      timedOut = true
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }, timeoutMs)
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      let payload = null
      try {
        payload = stdout.trim().length === 0 ? null : JSON.parse(stdout)
      } catch {
        payload = null
      }
      resolvePromise({
        status,
        signal,
        stdout,
        stderr,
        payload,
        timedOut,
        measured_duration_ms: Date.now() - startedAt,
      })
    })
  })
}

function statsTotal(payload, field) {
  const models = Object.values(payload?.stats?.models ?? {})
  let total = 0
  let observed = false
  for (const model of models) {
    const value = model?.api?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      observed = true
    }
  }
  return observed ? total : null
}

function resultTelemetry(run) {
  const payload = run.payload ?? {}
  const failed = run.timedOut || run.status !== 0 || payload.error
  const diagnostic = [
    typeof payload.error === 'string'
      ? payload.error
      : (payload.error?.message ?? payload.error?.type),
    run.stderr,
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
  return {
    subtype: run.timedOut
      ? 'adapter_timeout'
      : failed
        ? 'cli_error'
        : 'success',
    ...(failed && diagnostic.length > 0 ? { diagnostic } : {}),
    num_turns: statsTotal(payload, 'totalRequests'),
    duration_ms:
      statsTotal(payload, 'totalLatencyMs') ?? run.measured_duration_ms,
    total_cost_usd: null,
    permission_denials_count:
      payload?.stats?.tools?.totalDecisions?.reject ?? null,
    exit_code: run.status,
  }
}

function readToolCalls(tracePath) {
  try {
    return readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function policy(finalizationOnly) {
  const rules = [
    `[[rule]]
toolName = "*"
decision = "deny"
priority = 100`,
  ]
  if (!finalizationOnly) {
    rules.push(`[[rule]]
toolName = "read_file"
decision = "allow"
priority = 200`)
    rules.push(`[[rule]]
mcpName = "${serverName}"
toolName = "record_finding"
decision = "allow"
priority = 300`)
  }
  rules.push(`[[rule]]
mcpName = "${serverName}"
toolName = "finalize_review"
decision = "allow"
priority = 300`)
  return `${rules.join('\n\n')}\n`
}

function geminiArguments({ model, prompt, policyPath, resume }) {
  const args = [
    '--model',
    model,
    '--prompt',
    prompt,
    '--output-format',
    'json',
    '--skip-trust',
    '--approval-mode',
    'default',
    '--allowed-mcp-server-names',
    serverName,
    '--policy',
    policyPath,
  ]
  if (resume) args.push('--resume', resume)
  return args
}

export async function runGeminiAdapter(
  request,
  {
    binary = process.env.LADON_EVAL_GEMINI_BIN ?? 'gemini',
    timeoutMs = Number(process.env.LADON_EVAL_GEMINI_TIMEOUT_MS ?? 900000),
  } = {},
) {
  const validatedTimeoutMs = positiveNumber(timeoutMs, 'Gemini timeout')
  const maxTurns = positiveNumber(
    process.env.LADON_EVAL_GEMINI_MAX_TURNS ?? 60,
    'Gemini max turns',
  )
  const fixture = validateFixture(request.fixture)
  if (fixture.input === undefined) {
    throw new Error(
      'Gemini live eval requires an immutable fixture input bundle',
    )
  }
  if (request.fixture.id !== fixture.id) {
    throw new Error('fixture validation changed its identity')
  }
  const root = mkdtempSync(join(tmpdir(), 'ladon-gemini-eval-'))
  try {
    const materialized = materializeBundle(fixture, root)
    const home = join(root, '.home')
    const configDirectory = join(home, '.gemini')
    const statePath = join(root, 'review-state.json')
    const tracePath = join(root, 'tool-calls.jsonl')
    const policyPath = join(root, 'review-policy.toml')
    const serverPath = resolve(
      fileURLToPath(
        new URL('../../../reviewer/src/server.mjs', import.meta.url),
      ),
    )
    mkdirSync(configDirectory, { recursive: true })
    writeReviewState(statePath, createReviewState())
    writeFileSync(
      join(configDirectory, 'settings.json'),
      `${JSON.stringify({
        mcpServers: {
          [serverName]: {
            command: process.execPath,
            args: [serverPath],
            env: {
              LADON_REVIEW_STATE_PATH: statePath,
              LADON_REVIEW_TRACE_PATH: tracePath,
              LADON_REVIEW_GEMINI_SCHEDULER_ARGUMENTS: '1',
            },
          },
        },
        model: { maxSessionTurns: maxTurns },
        security: { disableYoloMode: true, disableAlwaysAllow: true },
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    writeFileSync(policyPath, policy(false), { encoding: 'utf8', mode: 0o600 })

    const initialRun = await runGemini(
      binary,
      geminiArguments({
        model: request.model,
        prompt: materialized.prompt,
        policyPath,
      }),
      { cwd: root, home, timeoutMs: validatedTimeoutMs },
    )
    const initialCalls = readToolCalls(tracePath)
    const attempts = [
      {
        kind: 'review',
        result: resultTelemetry(initialRun),
        tool_calls: initialCalls,
      },
    ]

    const state = readReviewState(statePath)
    const sessionId = initialRun.payload?.session_id
    if (state.finalization === null && sessionId) {
      writeFileSync(policyPath, policy(true), {
        encoding: 'utf8',
        mode: 0o600,
      })
      const retryRun = await runGemini(
        binary,
        geminiArguments({
          model: request.model,
          prompt: finalizationPrompt,
          policyPath,
          resume: sessionId,
        }),
        { cwd: root, home, timeoutMs: validatedTimeoutMs },
      )
      attempts.push({
        kind: 'finalization',
        result: resultTelemetry(retryRun),
        tool_calls: readToolCalls(tracePath).slice(initialCalls.length),
      })
    }

    const finalState = readReviewState(statePath)
    return {
      schema_version: 1,
      fixture_id: fixture.id,
      provider: request.provider,
      model: request.model,
      trial: request.trial,
      bundle_digest: materialized.digest,
      adapter:
        process.env.LADON_EVAL_GEMINI_ADAPTER_ID ?? 'gemini-cli-v1-unpinned',
      attempts,
      outcome:
        materialized.outcome ??
        (finalState.findings.length === 0 ? 'approve' : 'comment'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const trace = await runGeminiAdapter(await readStdin())
    process.stdout.write(`${JSON.stringify(trace)}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
