import { describe, expect, test } from 'vitest'
import { parseLadonMd } from './ladon-md.js'

describe('parseLadonMd', () => {
  test('returns all-empty config when input is null', () => {
    const result = parseLadonMd(null)
    expect(result).toEqual({
      repoContext: null,
      highRiskPaths: [],
      gatedPaths: [],
      escalationReviewers: [],
      noAutoApproveTeams: [],
      protectedBranches: [],
      trivialPaths: [],
      releaseStackBranches: [],
      skipBotAuthors: [],
    })
  })

  test('returns all-empty config when input is empty string', () => {
    const result = parseLadonMd('')
    expect(result).toEqual({
      repoContext: null,
      highRiskPaths: [],
      gatedPaths: [],
      escalationReviewers: [],
      noAutoApproveTeams: [],
      protectedBranches: [],
      trivialPaths: [],
      releaseStackBranches: [],
      skipBotAuthors: [],
    })
  })
})

describe('parseLadonMd — H2 bulleted lists', () => {
  test('extracts High-Risk Paths section', () => {
    const md = `# Ladon configuration

## High-Risk Paths
- \`terraform/**/*.tf\`
- \`**/schema.prisma\`
`
    expect(parseLadonMd(md).highRiskPaths).toEqual([
      'terraform/**/*.tf',
      '**/schema.prisma',
    ])
  })

  test('extracts Escalation Reviewers as a list', () => {
    const md = `## Escalation Reviewers
- nastassiafulconis
- EmmaLouise2018
`
    expect(parseLadonMd(md).escalationReviewers).toEqual([
      'nastassiafulconis',
      'EmmaLouise2018',
    ])
  })

  test('extracts No-Auto-Approve Teams as list', () => {
    const md = `## No-Auto-Approve Teams
- example-org/security
- example-org/finance
`
    expect(parseLadonMd(md).noAutoApproveTeams).toEqual([
      'example-org/security',
      'example-org/finance',
    ])
  })

  test('extracts Protected Branches', () => {
    const md = `## Protected Branches
- main
- release/next
`
    expect(parseLadonMd(md).protectedBranches).toEqual(['main', 'release/next'])
  })

  test('extracts Trivial Paths', () => {
    const md = `## Trivial Paths
- \`**/*.md\`
- \`.changeset/**\`
`
    expect(parseLadonMd(md).trivialPaths).toEqual(['**/*.md', '.changeset/**'])
  })

  test('extracts Release Stack Branches', () => {
    const md = `## Release Stack Branches
- release/next
`
    expect(parseLadonMd(md).releaseStackBranches).toEqual(['release/next'])
  })

  test('extracts Skip Bot Authors', () => {
    const md = `## Skip Bot Authors
- \`dependabot[bot]\`
- \`example-bot[bot]\`
`
    expect(parseLadonMd(md).skipBotAuthors).toEqual([
      'dependabot[bot]',
      'example-bot[bot]',
    ])
  })

  test('extracts Gated Paths section', () => {
    const md = `## Gated Paths
- \`.github/workflows/deploy.yml\`
- \`.github/workflows/hotfix.yml\`
`
    expect(parseLadonMd(md).gatedPaths).toEqual([
      '.github/workflows/deploy.yml',
      '.github/workflows/hotfix.yml',
    ])
  })

  test('strips backtick wrappers around bullet entries', () => {
    const md = `## High-Risk Paths
- \`**/version.yml\`
`
    expect(parseLadonMd(md).highRiskPaths).toEqual(['**/version.yml'])
  })

  test('ignores unknown sections', () => {
    const md = `## Some Other Section
- not parsed
`
    expect(parseLadonMd(md)).toEqual({
      repoContext: null,
      highRiskPaths: [],
      gatedPaths: [],
      escalationReviewers: [],
      noAutoApproveTeams: [],
      protectedBranches: [],
      trivialPaths: [],
      releaseStackBranches: [],
      skipBotAuthors: [],
    })
  })

  test('extracts repo context as everything under ## Repo Context until next H2', () => {
    const md = `## Repo Context

This is the repo context.

It can have multiple paragraphs.

## High-Risk Paths
- terraform/**
`
    const parsed = parseLadonMd(md)
    expect(parsed.repoContext?.trim()).toBe(
      'This is the repo context.\n\nIt can have multiple paragraphs.',
    )
    expect(parsed.highRiskPaths).toEqual(['terraform/**'])
  })
})
