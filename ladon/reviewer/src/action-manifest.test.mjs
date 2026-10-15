import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { createMcpHandler } from './server.mjs'
import {
  buildFindingsPayload,
  createReviewState,
  readReviewState,
  recordFinding,
  writeReviewState,
} from './state.mjs'
import { inspectReviewState } from './state-cli.mjs'

const CLAUDE_CODE_ACTION_V1_0_217 =
  'anthropics/claude-code-action@9c5ddab2e6d17b83ea679153b31f1d5f023cf636'

describe('Ladon reviewer action manifest', () => {
  const manifest = readFileSync(
    resolve(import.meta.dirname, '../action.yml'),
    'utf8',
  )

  test('allows the pull request author to trigger reviews from a fork', () => {
    const authorExpression = `${'$'}{{ github.event.pull_request.user.login }}`
    const allowedUserLines = manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allowed_non_write_users:'))

    expect(allowedUserLines).toEqual([
      `allowed_non_write_users: ${authorExpression}`,
      `allowed_non_write_users: ${authorExpression}`,
    ])
    expect(manifest).not.toContain('allowed_non_write_users: fgranata')
  })

  test('uses a verified immutable Claude Code installer for every execution', () => {
    const claudeSteps = manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses: anthropics/claude-code-action@'))
      .map((line) => line.split(' #')[0])

    expect(claudeSteps).toEqual([
      `uses: ${CLAUDE_CODE_ACTION_V1_0_217}`,
      `uses: ${CLAUDE_CODE_ACTION_V1_0_217}`,
    ])
    expect(manifest).not.toContain('/home/runner/.local/bin/claude')
  })

  test('passes the findings server as inline JSON on the review and retry', () => {
    // claude-code-action prepends its built-in servers as inline JSON. Its
    // config merger discards file paths when any inline servers are present.
    const outputLine = manifest
      .split('\n')
      .find((line) => line.trim().startsWith('echo "mcp-config-json='))
    expect(outputLine).toBeDefined()

    const directory = mkdtempSync(resolve(tmpdir(), 'ladon-mcp-config-'))
    try {
      const configPath = resolve(directory, 'findings.json')
      const config = {
        mcpServers: {
          ladon_findings: {
            command: '/usr/bin/node',
            args: ['/action/src/server.mjs'],
            env: { LADON_REVIEW_STATE_PATH: '/tmp/review-state.json' },
          },
        },
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      const output = execFileSync('bash', ['-c', outputLine.trim()], {
        env: { ...process.env, MCP_CONFIG_PATH: configPath },
        encoding: 'utf8',
      }).trim()
      const inline = output.slice('mcp-config-json='.length)
      expect(JSON.parse(inline)).toEqual(config)
      expect(inline).not.toContain('\n')

      const configArguments = manifest
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('--mcp-config '))
      const expression = `${'$'}{{ steps.prompt.outputs.mcp-config-json }}`
      expect(configArguments).toEqual([
        `--mcp-config '${expression}'`,
        `--mcp-config '${expression}'`,
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the orchestrator pins every Ladon stage to the same immutable revision', () => {
    const orchestrator = readFileSync(
      resolve(import.meta.dirname, '../../review/action.yml'),
      'utf8',
    )
    const stages = [
      ...orchestrator.matchAll(
        /uses: adcontextprotocol\/actions\/ladon\/(setup|reviewer|arbiter)@([^\s]+)/g,
      ),
    ]
    expect(stages.map(([, stage]) => stage)).toEqual([
      'setup',
      'reviewer',
      'arbiter',
    ])
    for (const [, , revision] of stages) {
      expect(revision).toMatch(/^[a-f0-9]{40}$/)
    }
    expect(new Set(stages.map(([, , revision]) => revision)).size).toBe(1)
  })

  const actionPath = resolve(import.meta.dirname, '..')
  const steps = parse(manifest).runs.steps
  const step = (id) => steps.find((candidate) => candidate.id === id)

  // Runs one composite `run:` block the way the runner would: expressions
  // that reference the action path are substituted, step env is applied, and
  // GITHUB_OUTPUT is captured. Returns the parsed outputs.
  function runStep(id, env, directory) {
    const script = step(id).run.replaceAll(
      `${'$'}{{ github.action_path }}`,
      actionPath,
    )
    const outputPath = resolve(directory, 'github-output')
    writeFileSync(outputPath, '')
    execFileSync('bash', ['-c', script], {
      env: {
        ...process.env,
        ...env,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: outputPath,
      },
      encoding: 'utf8',
    })
    const outputs = {}
    const lines = readFileSync(outputPath, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const heredoc = line.match(/^([\w-]+)<<(.+)$/)
      if (heredoc) {
        const body = []
        while (lines[++index] !== heredoc[2]) body.push(lines[index])
        outputs[heredoc[1]] = body.join('\n')
      } else if (line.includes('=')) {
        const [key, ...value] = line.split('=')
        outputs[key] = value.join('=')
      }
    }
    return outputs
  }

  test('the finalization retry is a fresh session, never a resume', () => {
    const retry = step('finalization-retry')
    const prepare = step('finalization-prompt')

    // A resumed session in this second step ended without a model call
    // (num_turns 0, $0) on adcp-go#558, so the retry must not depend on it.
    for (const candidate of steps) {
      expect(candidate.with?.claude_args ?? '').not.toContain('--resume')
    }
    expect(manifest).not.toContain('outputs.session_id')
    expect(retry.with.prompt).toBe(
      `${'$'}{{ steps.finalization-prompt.outputs.prompt }}`,
    )
    expect(retry.with.claude_args).toContain('--max-turns 4')
    expect(retry.with.claude_args).toContain(
      '--allowedTools "mcp__ladon_findings__finalize_review"',
    )
    expect(retry.if).toContain("steps.finalization-prompt.outcome == 'success'")
    expect(prepare.if).toContain(
      "steps.inspect.outputs.needs-finalization == 'true'",
    )
    expect(prepare.env.EXECUTION_FILE).toBe(
      `${'$'}{{ steps.inspect.outputs.execution-file }}`,
    )
  })

  test('an unfinalized review gets a retry prompt that can finalize it', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'ladon-finalize-'))
    try {
      const statePath = resolve(directory, 'state.json')
      const executionPath = resolve(directory, 'execution.json')
      writeReviewState(
        statePath,
        recordFinding(createReviewState(), {
          severity: 'medium',
          title: 'Unbounded retry loop',
          rationale: 'The loop never stops retrying a permanent failure.',
          file: 'router/retry.go',
          line: 12,
          category: 'operability',
          posted_inline: true,
        }),
      )
      // The adcp-go#558 shape: a successful 17-turn run that never finalized.
      writeFileSync(
        executionPath,
        JSON.stringify([
          {
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              content: [
                {
                  type: 'text',
                  text: 'Reviewed every changed file. One medium finding.',
                },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 17,
            result: 'Reviewed every changed file. One medium finding.',
            permission_denials: [],
          },
        ]),
      )
      expect(inspectReviewState(statePath, executionPath)).toMatchObject({
        status: 'needs_finalization',
        turns: 17,
      })

      const { prompt } = runStep(
        'finalization-prompt',
        { REVIEW_STATE_PATH: statePath, EXECUTION_FILE: executionPath },
        directory,
      )
      expect(prompt).toContain(
        'Reviewed every changed file. One medium finding.',
      )
      expect(prompt).toContain(
        '- [medium] router/retry.go:12 — Unbounded retry loop',
      )

      // Stand in for the finalizer: the only tool it may call.
      const handle = createMcpHandler(statePath)
      const response = await handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'finalize_review',
          arguments: {
            summary: 'The reviewer covered every changed file.',
            analysis_complete: true,
          },
        },
      })
      expect(response.result.isError).toBe(false)
      expect(inspectReviewState(statePath, executionPath).status).toBe(
        'complete',
      )
      expect(buildFindingsPayload(readReviewState(statePath))).toMatchObject({
        summary: 'The reviewer covered every changed file.',
        findings: [{ file: 'router/retry.go' }],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function assemblePrompt(diff, directory) {
    const bin = resolve(directory, 'bin')
    mkdirSync(bin)
    // The constitution fetch is fail-open; keep the test offline.
    writeFileSync(resolve(bin, 'curl'), '#!/bin/sh\nexit 1\n')
    chmodSync(resolve(bin, 'curl'), 0o755)
    const diffPath = resolve(directory, 'diff-full.patch')
    writeFileSync(diffPath, diff)
    const outputs = runStep(
      'prompt',
      {
        PATH: `${bin}:${process.env.PATH}`,
        PR_NUMBER: '558',
        REPO: 'adcontextprotocol/adcp-go',
        BASE_SHA: 'base',
        HEAD_SHA: 'head',
        DELTA_PATH: diffPath,
        FULL_PATH: diffPath,
        MAX_TURNS: '60',
        LADON_MD_BODY: '',
        PRIOR_DECISION: '',
        ACTIVE_CHANGE_REQUESTS_PATH: '',
        GATED_PATHS: 'false',
        GATED_PATHS_REASONS: '[]',
        REVIEW_DECISION: '',
      },
      directory,
    )
    return outputs.prompt
  }

  function fileDiff(path, lines) {
    const body = Array.from({ length: lines }, (_, index) => `+line ${index}`)
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines} @@`,
      ...body,
      '',
    ].join('\n')
  }

  test('the review prompt makes finalization mandatory', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'ladon-prompt-'))
    try {
      const prompt = assemblePrompt(fileDiff('a.go', 10), directory)
      expect(prompt).toContain(
        'Diff sizes: delta 14 lines across 1 files; full 14 lines across 1 files.',
      )
      expect(prompt).toContain('This call is mandatory')
      expect(prompt).toContain('the 60-turn budget')
      expect(prompt).toContain(
        'Your last action must be the `mcp__ladon_findings__finalize_review` call.',
      )
      expect(prompt).not.toContain('# Large diff')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a large diff gets paging guidance and a per-file line index', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'ladon-prompt-'))
    try {
      const prompt = assemblePrompt(
        fileDiff('router/big.go', 1200) + fileDiff('adcp/types_gen.go', 800),
        directory,
      )
      expect(prompt).toContain('# Large diff')
      expect(prompt).toContain('pages of at most 1000 lines')
      expect(prompt).toContain('- lines 1-1204: router/big.go')
      expect(prompt).toContain('- lines 1205-2008: adcp/types_gen.go')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
