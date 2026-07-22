export interface LadonConfig {
  repoContext: string | null
  highRiskPaths: string[]
  gatedPaths: string[]
  escalationReviewers: string[]
  noAutoApproveTeams: string[]
  protectedBranches: string[]
  trivialPaths: string[]
  releaseStackBranches: string[]
  skipBotAuthors: string[]
}

const EMPTY_CONFIG: LadonConfig = {
  repoContext: null,
  highRiskPaths: [],
  gatedPaths: [],
  escalationReviewers: [],
  noAutoApproveTeams: [],
  protectedBranches: [],
  trivialPaths: [],
  releaseStackBranches: [],
  skipBotAuthors: [],
}

const SECTION_TO_KEY = new Map<string, keyof LadonConfig>([
  ['repo context', 'repoContext'],
  ['high-risk paths', 'highRiskPaths'],
  ['gated paths', 'gatedPaths'],
  ['escalation reviewers', 'escalationReviewers'],
  ['no-auto-approve teams', 'noAutoApproveTeams'],
  ['protected branches', 'protectedBranches'],
  ['trivial paths', 'trivialPaths'],
  ['release stack branches', 'releaseStackBranches'],
  ['skip bot authors', 'skipBotAuthors'],
])

interface ParsedSection {
  key: keyof LadonConfig
  body: string
}

function splitSections(input: string): ParsedSection[] {
  const lines = input.split(/\r?\n/)
  const sections: ParsedSection[] = []
  let current: { key: keyof LadonConfig; body: string[] } | null = null

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      if (current) {
        sections.push({ key: current.key, body: current.body.join('\n') })
      }
      const key = SECTION_TO_KEY.get(h2[1].toLowerCase())
      current = key ? { key, body: [] } : null
      continue
    }
    if (current) current.body.push(line)
  }
  if (current)
    sections.push({ key: current.key, body: current.body.join('\n') })
  return sections
}

function parseBullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').trim())
    .map((l) => l.replace(/^`(.+)`$/, '$1'))
    .filter((l) => l.length > 0)
}

export function parseLadonMd(input: string | null): LadonConfig {
  if (!input) return { ...EMPTY_CONFIG }
  const result: LadonConfig = { ...EMPTY_CONFIG }
  for (const { key, body } of splitSections(input)) {
    switch (key) {
      case 'repoContext':
        result.repoContext = body.trim().length > 0 ? body : null
        break
      case 'escalationReviewers':
      case 'highRiskPaths':
      case 'gatedPaths':
      case 'noAutoApproveTeams':
      case 'protectedBranches':
      case 'trivialPaths':
      case 'releaseStackBranches':
      case 'skipBotAuthors':
        result[key] = parseBullets(body)
        break
    }
  }
  return result
}
