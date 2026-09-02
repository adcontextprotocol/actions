#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const finalizationPrompt = `Finalize the existing Ladon review now. Do not inspect files, run commands,
add findings, or repeat the review. Call mcp__ladon_findings__finalize_review
exactly once with a concise 1-3 sentence summary of the completed analysis.
Set analysis_complete true only if the prior session completed all required
coverage; otherwise set it false so the review remains fail-closed. Stop
immediately after the tool call.`

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

function sanitizedEnvironment() {
  const environment = {}
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CI',
    'HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'NO_PROXY',
    'PATH',
    'SSL_CERT_FILE',
    'TMPDIR',
    'XDG_CONFIG_HOME',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

function runClaude(binary, args, { cwd, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now()
    const detached = process.platform !== 'win32'
    const child = spawn(binary, args, {
      cwd,
      detached,
      env: sanitizedEnvironment(),
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

function resultTelemetry(run) {
  const payload = run.payload ?? {}
  const permissionDenials = payload.permission_denials
  const diagnostic = [
    payload.result,
    ...(Array.isArray(payload.errors) ? payload.errors : []),
    run.stderr,
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
  const failed =
    run.timedOut ||
    run.status !== 0 ||
    payload.is_error === true ||
    payload.error
  return {
    subtype: run.timedOut
      ? 'adapter_timeout'
      : failed
        ? (payload.terminal_reason ?? payload.subtype ?? 'cli_error')
        : (payload.subtype ?? 'success'),
    ...(failed && diagnostic.length > 0 ? { diagnostic } : {}),
    num_turns: payload.num_turns ?? null,
    duration_ms: payload.duration_ms ?? run.measured_duration_ms,
    total_cost_usd: payload.total_cost_usd ?? null,
    permission_denials_count: Array.isArray(permissionDenials)
      ? permissionDenials.length
      : (payload.permission_denials_count ?? null),
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

function claudeArguments({
  model,
  prompt,
  root,
  mcpConfigPath,
  maxTurns,
  maxBudgetUsd,
  resume,
  finalizationOnly,
}) {
  const allowedTools = finalizationOnly
    ? 'mcp__ladon_findings__finalize_review'
    : 'Read,mcp__ladon_findings__record_finding,mcp__ladon_findings__finalize_review'
  const args = [
    '--bare',
    '--print',
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--tools',
    finalizationOnly ? '' : 'Read',
    '--allowedTools',
    allowedTools,
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'json',
    '--add-dir',
    root,
  ]
  if (resume) args.push('--resume', resume)
  args.push(prompt)
  return args
}

export async function runClaudeAdapter(
  request,
  {
    binary = process.env.LADON_EVAL_CLAUDE_BIN ?? 'claude',
    timeoutMs = Number(process.env.LADON_EVAL_CLAUDE_TIMEOUT_MS ?? 900000),
  } = {},
) {
  const validatedTimeoutMs = positiveNumber(timeoutMs, 'Claude timeout')
  const maxTurns = positiveNumber(
    process.env.LADON_EVAL_CLAUDE_MAX_TURNS ?? 60,
    'Claude max turns',
  )
  const maxBudgetUsd = positiveNumber(
    process.env.LADON_EVAL_CLAUDE_MAX_BUDGET_USD ?? 2,
    'Claude max budget',
  )
  const retryMaxBudgetUsd = positiveNumber(
    process.env.LADON_EVAL_CLAUDE_RETRY_MAX_BUDGET_USD ?? 0.25,
    'Claude retry max budget',
  )
  const fixture = validateFixture(request.fixture)
  if (fixture.input === undefined) {
    throw new Error(
      'Claude live eval requires an immutable fixture input bundle',
    )
  }
  if (request.fixture.id !== fixture.id) {
    throw new Error('fixture validation changed its identity')
  }
  const root = mkdtempSync(join(tmpdir(), 'ladon-claude-eval-'))
  try {
    const materialized = materializeBundle(fixture, root)
    const statePath = join(root, 'review-state.json')
    const tracePath = join(root, 'tool-calls.jsonl')
    const mcpConfigPath = join(root, 'mcp.json')
    const serverPath = resolve(
      fileURLToPath(
        new URL('../../../reviewer/src/server.mjs', import.meta.url),
      ),
    )
    writeReviewState(statePath, createReviewState())
    writeFileSync(
      mcpConfigPath,
      `${JSON.stringify({
        mcpServers: {
          ladon_findings: {
            command: process.execPath,
            args: [serverPath],
            env: {
              LADON_REVIEW_STATE_PATH: statePath,
              LADON_REVIEW_TRACE_PATH: tracePath,
            },
          },
        },
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    const initialRun = await runClaude(
      binary,
      claudeArguments({
        model: request.model,
        prompt: materialized.prompt,
        root,
        mcpConfigPath,
        maxTurns,
        maxBudgetUsd,
        finalizationOnly: false,
      }),
      { cwd: root, timeoutMs: validatedTimeoutMs },
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
      const retryRun = await runClaude(
        binary,
        claudeArguments({
          model: request.model,
          prompt: finalizationPrompt,
          root,
          mcpConfigPath,
          maxTurns: 4,
          maxBudgetUsd: retryMaxBudgetUsd,
          resume: sessionId,
          finalizationOnly: true,
        }),
        { cwd: root, timeoutMs: validatedTimeoutMs },
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
        process.env.LADON_EVAL_CLAUDE_ADAPTER_ID ?? 'claude-cli-v1-unpinned',
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
    const trace = await runClaudeAdapter(await readStdin())
    process.stdout.write(`${JSON.stringify(trace)}\n`)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
