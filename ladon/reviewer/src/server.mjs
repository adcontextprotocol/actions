import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  finalizeReview,
  readReviewState,
  recordFinding,
  writeReviewState,
} from './state.mjs'

const findingProperties = {
  severity: { enum: ['critical', 'high', 'medium', 'low'] },
  title: { type: 'string', maxLength: 120 },
  rationale: { type: 'string', maxLength: 1500 },
  file: { type: 'string' },
  line: { type: ['integer', 'null'], minimum: 1 },
  category: {
    enum: [
      'correctness',
      'security',
      'performance',
      'data-loss',
      'schema',
      'infra',
      'tests',
      'operability',
      'style',
      'other',
    ],
  },
  posted_inline: { type: 'boolean' },
}

export const tools = [
  {
    name: 'record_finding',
    description:
      'Persist one confirmed review finding. Call once per finding after attempting its inline comment. Repeated identical findings are deterministically upserted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'severity',
        'title',
        'rationale',
        'file',
        'category',
        'posted_inline',
      ],
      properties: findingProperties,
    },
  },
  {
    name: 'finalize_review',
    description:
      'Finalize the persisted review. Set analysis_complete true only after all required coverage is complete; false keeps the run fail-closed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'analysis_complete'],
      properties: {
        summary: { type: 'string', maxLength: 1500 },
        analysis_complete: { type: 'boolean' },
      },
    },
  },
]

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function createMcpHandler(statePath) {
  if (!statePath) throw new Error('a review state path is required')

  return async function handle(message) {
    if (message?.method?.startsWith('notifications/')) return null
    if (message?.method === 'initialize') {
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ladon-findings', version: '1.0.0' },
      })
    }
    if (message?.method === 'ping') return response(message.id, {})
    if (message?.method === 'tools/list') {
      return response(message.id, { tools })
    }
    if (message?.method !== 'tools/call') {
      return errorResponse(message?.id ?? null, -32601, 'method not found')
    }

    const name = message.params?.name
    const input = message.params?.arguments ?? {}
    try {
      const state = readReviewState(statePath)
      if (name === 'record_finding') {
        const next = recordFinding(state, input)
        writeReviewState(statePath, next)
        return response(
          message.id,
          toolResult(`Recorded finding ${next.findings.length}.`),
        )
      }
      if (name === 'finalize_review') {
        const next = finalizeReview(state, input)
        writeReviewState(statePath, next)
        return response(
          message.id,
          toolResult(
            input.analysis_complete
              ? `Finalized review with ${next.findings.length} finding(s).`
              : 'Recorded incomplete review; the run will fail closed.',
          ),
        )
      }
      return response(
        message.id,
        toolResult(`Unknown tool: ${String(name)}`, true),
      )
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      return response(message.id, toolResult(messageText, true))
    }
  }
}

export async function runServer(
  statePath = process.env.LADON_REVIEW_STATE_PATH,
) {
  const handle = createMcpHandler(statePath)
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const line of lines) {
    if (line.trim().length === 0) continue
    let output
    try {
      output = await handle(JSON.parse(line))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output = errorResponse(null, -32700, message)
    }
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runServer().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
