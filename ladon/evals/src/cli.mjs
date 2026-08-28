#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gradeReplay, summarizeReports, validateFixture } from './replay.mjs'

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function writeJson(path, value) {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
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

function runAdapter(command, request) {
  const result = spawnSync(command, [], {
    input: `${JSON.stringify(request)}\n`,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(
      `adapter failed (${result.status ?? 'signal'}): ${result.stderr.trim()}`,
    )
  }
  return JSON.parse(result.stdout)
}

export function runCli(args = process.argv.slice(2)) {
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
  if (command === 'run') {
    const fixture = validateFixture(readJson(requireOption(parsed, 'fixture')))
    const adapter = requireOption(parsed, 'adapter')
    const provider = requireOption(parsed, 'provider')
    const models = requireOption(parsed, 'models').split(',')
    const repetitions = Number(parsed.repetitions ?? 1)
    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error('--repetitions must be a positive integer')
    }
    const reports = []
    for (const model of models) {
      for (let trial = 1; trial <= repetitions; trial += 1) {
        const trace = runAdapter(adapter, { fixture, provider, model, trial })
        reports.push(gradeReplay(fixture, trace))
      }
    }
    const output = { reports, summary: summarizeReports(reports) }
    writeJson(requireOption(parsed, 'out'), output)
    return output
  }
  throw new Error(
    'usage: cli.mjs grade --fixture FILE --traces FILE[,FILE] [--out FILE] | run --fixture FILE --adapter COMMAND --provider NAME --models ID[,ID] [--repetitions N] --out FILE',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
