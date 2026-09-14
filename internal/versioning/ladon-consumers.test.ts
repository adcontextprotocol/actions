import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const { validateInventory, invocations } = createRequire(import.meta.url)(
  '../../scripts/audit-ladon-consumers.cjs',
)
const policy = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../ladon/consumer-policy.json'),
    'utf8',
  ),
)
const workflow = (
  uses = `adcontextprotocol/actions/ladon/review@${policy.review}`,
  input: unknown = 'false',
) =>
  JSON.stringify({
    jobs: { review: { steps: [{ uses, with: { 'auto-approve': input } }] } },
  })
const report = () => ({
  complete: true,
  search: { incomplete_results: false, total_count: 0, items: [] },
  repositories: policy.repositories.map((name: string) => ({
    name,
    head: 'a'.repeat(40),
    workflows: [
      { path: '.github/workflows/ai-review.yml', content: workflow() },
    ],
  })),
})

describe('organization Ladon release inventory is fail closed', () => {
  test('all five intended consumers are explicitly inventoried with an immutable review pin', () => {
    expect(policy.repositories).toEqual([
      'adcontextprotocol/actions',
      'adcontextprotocol/adcp',
      'adcontextprotocol/adcp-client',
      'adcontextprotocol/adcp-go',
      'adcontextprotocol/adcp-client-python',
    ])
    expect(policy.review).toMatch(/^[a-f0-9]{40}$/)
    expect(validateInventory(report())).toEqual([])
  })
  test('a sixth consumer fails even if pinned and disabled', () => {
    const value = report()
    value.repositories.push({
      name: 'adcontextprotocol/new-sdk',
      head: 'b'.repeat(40),
      workflows: [
        { path: '.github/workflows/review.yml', content: workflow() },
      ],
    })
    expect(validateInventory(value)).toContain(
      'Uninventoried Ladon consumer: adcontextprotocol/new-sdk',
    )
  })
  test.each([
    undefined,
    null,
    '',
    true,
    false,
    'true',
    'False',
    '${{ inputs.auto-approve }}',
  ])('missing or nonliteral disabled input %j blocks promotion', (input) => {
    const value = report()
    value.repositories[0].workflows[0].content = JSON.stringify({
      jobs: {
        r: {
          steps: [
            {
              uses: `adcontextprotocol/actions/ladon/review@${policy.review}`,
              with: input === undefined ? {} : { 'auto-approve': input },
            },
          ],
        },
      },
    })
    expect(validateInventory(value).join('\n')).toContain(
      "auto-approve must be literal 'false'",
    )
  })
  test.each([
    './ladon/review',
    'adcontextprotocol/actions/ladon/review@ladon/review/v1',
    `adcontextprotocol/actions/ladon/review@${'f'.repeat(40)}`,
  ])('local/floating/wrong pin %s blocks promotion', (pin) => {
    const value = report()
    value.repositories[0].workflows[0].content = workflow(pin)
    expect(validateInventory(value).join('\n')).toContain(
      'missing/wrong immutable pin',
    )
  })
  test('missing consumer and additional invocation fail closed', () => {
    const value = report()
    value.repositories.pop()
    value.repositories[0].workflows.push({
      path: '.github/workflows/second.yml',
      content: workflow(),
    })
    expect(validateInventory(value).length).toBe(2)
  })
  test('partial search and incomplete enumeration cannot certify rollout', () => {
    const value = report()
    value.complete = false
    value.search.incomplete_results = true
    value.search.total_count = 1
    expect(validateInventory(value).length).toBe(3)
  })
  test('a search hit not reconciled to an exact-head workflow blocks rollout', () => {
    const value = report()
    const search = {
      incomplete_results: false,
      total_count: 1,
      items: [
        {
          repository: { full_name: 'adcontextprotocol/unknown' },
          path: '.github/workflows/review.yml',
        },
      ],
    }
    expect(validateInventory({ ...value, search }).join('\n')).toContain(
      'Unreconciled code-search result',
    )
  })
  test('comments and release tag strings are not invocation sites', () => {
    expect(
      invocations({
        jobs: { publish: { steps: [{ run: 'echo ladon/review/v1' }] } },
      }),
    ).toEqual([])
  })
  test('malformed workflow parsing throws rather than blessing a partial inventory', () => {
    const value = report()
    value.repositories[0].workflows[0].content = 'jobs: [broken'
    expect(() => validateInventory(value)).toThrow()
  })
  test('actions own trusted workflow is pinned and disabled with the original human modification gate', () => {
    const value = report()
    value.repositories[0].workflows[0].content = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/ai-review.yml'),
      'utf8',
    )
    expect(validateInventory(value)).toEqual([])
    expect(value.repositories[0].workflows[0].content).toContain(
      "if: steps.workflow-mod.outputs.modified != 'true'",
    )
    expect(value.repositories[0].workflows[0].content).toContain(
      'ladon/*|.github/workflows/ai-review.yml|LADON.md)',
    )
    expect(value.repositories[0].workflows[0].content).toContain(
      "event: 'COMMENT'",
    )
  })
})

test('the Contents API cap cannot hide a sixth consumer beyond a truncated listing', () => {
  const { checkedWorkflowFiles } = createRequire(import.meta.url)(
    '../../scripts/audit-ladon-consumers.cjs',
  )
  const files = Array.from({ length: 1000 }, (_, i) => ({
    path: `.github/workflows/non-yaml-${i}`,
  }))
  expect(() => checkedWorkflowFiles(files, 'adcontextprotocol/sixth')).toThrow(
    'Possibly truncated',
  )
  expect(
    checkedWorkflowFiles(files.slice(0, 999), 'adcontextprotocol/sixth'),
  ).toEqual([])
})
