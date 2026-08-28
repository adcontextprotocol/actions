#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gradeReplay, summarizeReports, validateFixture } from './replay.mjs'

const defaultMaxBuffer = 20 * 1024 * 1024

class AdapterError extends Error {
  constructor(subtype, message) {
    super(message)
    this.name = 'AdapterError'
    this.subtype = subtype
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function writeJson(path, value) {
  const absolute = resolve(path)
  const temporary = `${absolute}.tmp`
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, absolute)
}

function options(args) {
  const parsed = { _: [] }
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (!item.startsWith('--')) parsed._.push(item)
    else {
      const value = args[index + 1]
      if (!value || value.startsWith('--'))
        throw new Error(`${item} needs a value`)
      parsed[item.slice(2)] = value
      index += 1
    }
  }
  return parsed
}

function requireOption(parsed, name) {
  const value = parsed[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function positiveInteger(value, name, defaultValue) {
  const parsed = Number(value ?? defaultValue)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function compactError(value) {
  const message = value instanceof Error ? value.message : String(value)
  return message.replaceAll(/\s+/g, ' ').trim().slice(0, 2000)
}

function runAdapter(command, request, { timeoutMs, maxBuffer }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [], {
      encoding: 'utf8',
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let overflowed = false

    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const append = (current, chunk) => {
      const next = current + chunk
      if (next.length > maxBuffer) {
        overflowed = true
        child.kill('SIGKILL')
      }
      return next.slice(0, maxBuffer)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => {
      finish(() =>
        rejectPromise(
          new AdapterError('adapter_spawn_error', compactError(error)),
        ),
      )
    })
    child.on('close', (status, signal) => {
      finish(() => {
        if (timedOut) {
          rejectPromise(
            new AdapterError(
              'adapter_timeout',
              `adapter exceeded ${timeoutMs}ms`,
            ),
          )
          return
        }
        if (overflowed) {
          rejectPromise(
            new AdapterError(
              'adapter_output_limit',
              `adapter output exceeded ${maxBuffer} bytes`,
            ),
          )
          return
        }
        if (status !== 0) {
          const detail = compactError(stderr) || `signal ${signal ?? 'unknown'}`
          rejectPromise(
            new AdapterError(
              'adapter_process_error',
              `adapter failed (${status ?? 'signal'}): ${detail}`,
            ),
          )
          return
        }
        try {
          resolvePromise(JSON.parse(stdout))
        } catch (error) {
          rejectPromise(
            new AdapterError(
              'adapter_invalid_json',
              `adapter returned invalid JSON: ${compactError(error)}`,
            ),
          )
        }
      })
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

function adapterFailureTrace(request, error) {
  const subtype =
    error instanceof AdapterError ? error.subtype : 'adapter_invalid_trace'
  return {
    schema_version: 1,
    fixture_id: request.fixture.id,
    provider: request.provider,
    model: request.model,
    attempts: [
      {
        kind: 'review',
        result: {
          subtype,
          error: compactError(error),
        },
        tool_calls: [],
      },
    ],
  }
}

async function executeTask(task, adapterOptions) {
  const request = {
    fixture: task.fixture,
    provider: task.provider,
    model: task.model,
    trial: task.trial,
  }
  try {
    const trace = await runAdapter(task.adapter, request, adapterOptions)
    if (
      trace?.fixture_id !== request.fixture.id ||
      trace?.provider !== request.provider ||
      trace?.model !== request.model
    ) {
      throw new AdapterError(
        'adapter_identity_mismatch',
        'adapter trace identity does not match its requested fixture, provider, and model',
      )
    }
    const report = gradeReplay(task.fixture, trace)
    return {
      ...report,
      trial: task.trial,
      checks: { ...report.checks, adapter_execution: true },
      metrics: { ...report.metrics, runner_errors: 0 },
    }
  } catch (error) {
    const trace = adapterFailureTrace(request, error)
    const report = gradeReplay(task.fixture, trace)
    return {
      ...report,
      trial: task.trial,
      passed: false,
      checks: { ...report.checks, adapter_execution: false },
      metrics: { ...report.metrics, runner_errors: 1 },
      runner_error: trace.attempts[0].result,
    }
  }
}

export async function runWithConcurrency(items, concurrency, worker, onResult) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const result = await worker(items[index], index)
      results[index] = result
      if (onResult) await onResult(results.filter(Boolean), items.length)
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  )
  await Promise.all(workers)
  return results
}

function outputFor(reports, total) {
  return {
    status: reports.length === total ? 'complete' : 'running',
    completed: reports.length,
    total,
    reports,
    summary: reports.length > 0 ? summarizeReports(reports) : [],
  }
}

function fixturesFor(parsed) {
  if (parsed.fixture && parsed.fixtures) {
    throw new Error('use either --fixture or --fixtures, not both')
  }
  const paths = (parsed.fixture ?? requireOption(parsed, 'fixtures')).split(',')
  return paths.map((path) => validateFixture(readJson(path)))
}

export async function runCli(args = process.argv.slice(2)) {
  const parsed = options(args)
  const command = parsed._[0]
  if (command === 'grade') {
    const fixture = readJson(requireOption(parsed, 'fixture'))
    const traces = requireOption(parsed, 'traces')
      .split(',')
      .map((path) => readJson(path))
    const reports = traces.map((trace) => gradeReplay(fixture, trace))
    const output = { reports, summary: summarizeReports(reports) }
    if (parsed.out) writeJson(parsed.out, output)
    else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return output
  }
  if (command === 'merge') {
    const reports = requireOption(parsed, 'reports')
      .split(',')
      .flatMap((path) => {
        const input = readJson(path)
        if (!Array.isArray(input.reports)) {
          throw new Error(`${path} does not contain a reports array`)
        }
        return input.reports
      })
    const output = outputFor(reports, reports.length)
    writeJson(requireOption(parsed, 'out'), output)
    return output
  }
  if (command === 'run') {
    const fixtures = fixturesFor(parsed)
    const adapter = requireOption(parsed, 'adapter')
    const provider = requireOption(parsed, 'provider')
    const models = requireOption(parsed, 'models')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
    if (models.length === 0) throw new Error('--models must not be empty')
    const repetitions = positiveInteger(parsed.repetitions, 'repetitions', 1)
    const concurrency = positiveInteger(parsed.concurrency, 'concurrency', 1)
    const timeoutMs = positiveInteger(
      parsed['timeout-ms'],
      'timeout-ms',
      900000,
    )
    const outputPath = requireOption(parsed, 'out')
    const tasks = fixtures.flatMap((fixture) =>
      models.flatMap((model) =>
        Array.from({ length: repetitions }, (_, index) => ({
          fixture,
          adapter,
          provider,
          model,
          trial: index + 1,
        })),
      ),
    )
    const reports = await runWithConcurrency(
      tasks,
      concurrency,
      (task) => executeTask(task, { timeoutMs, maxBuffer: defaultMaxBuffer }),
      (partialReports, total) =>
        writeJson(outputPath, outputFor(partialReports, total)),
    )
    const output = outputFor(reports, tasks.length)
    writeJson(outputPath, output)
    return output
  }
  throw new Error(
    'usage: cli.mjs grade --fixture FILE --traces FILE[,FILE] [--out FILE] | merge --reports FILE[,FILE] --out FILE | run (--fixture FILE | --fixtures FILE[,FILE]) --adapter COMMAND --provider NAME --models ID[,ID] [--repetitions N] [--concurrency N] [--timeout-ms N] --out FILE',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runCli()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
