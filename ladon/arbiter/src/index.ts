import { readFile } from 'node:fs/promises'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { DECISION_RULES, SEVERITY_RULES } from './_rules.generated.js'
import { decideViaAnthropic } from './anthropic.js'
import { buildArbiterPrompt } from './decision.js'
import { computeDiffStatsFromFile } from './diff-stats.js'
import { enforceDecisionGuards } from './enforce.js'
import { parseFindings } from './findings.js'
import {
  addLabel,
  dismissSupersededChangeRequests,
  ensureLabel,
  fetchReviewDecision,
  hasHumanApproval,
  mapOutcomeToReviewEvent,
  postReview,
  requestReviewers,
} from './post.js'
import { parsePriorDecisionInput } from './prior-decision.js'
import { renderReviewBody } from './render.js'
import { findNoAutoApproveTeams } from './teams.js'

function csv(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function changeRequestIds(input: string): number[] {
  try {
    const parsed = JSON.parse(input)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) =>
        typeof item === 'object' && item !== null
          ? (item as { id?: unknown }).id
          : undefined,
      )
      .filter(
        (id): id is number => typeof id === 'number' && Number.isFinite(id),
      )
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const anthropicApiKey = core.getInput('anthropic-api-key', { required: true })
  const githubToken = core.getInput('github-token', { required: true })
  const findingsRaw = core.getInput('findings-json', { required: true })
  const repoContextRaw = core.getInput('ladon-md-body')
  const highRisk = core.getInput('high-risk') === 'true'
  const highRiskReasons = (() => {
    try {
      return JSON.parse(core.getInput('high-risk-reasons') || '[]') as string[]
    } catch {
      return []
    }
  })()
  const gatedPaths = core.getInput('gated-paths') === 'true'
  const gatedPathsReasons = (() => {
    try {
      return JSON.parse(
        core.getInput('gated-paths-reasons') || '[]',
      ) as string[]
    } catch {
      return []
    }
  })()
  let reviewDecision = core.getInput('review-decision')
  const escalationReviewers = csv(core.getInput('escalation-reviewers'))
  const noAutoApproveTeams = csv(core.getInput('no-auto-approve-teams'))
  const protectedBranches = csv(core.getInput('protected-branches'))
  const priorDecisionInput = core.getInput('prior-decision')
  const activeChangeRequestsPath = core.getInput('active-change-requests-path')
  const prNumber = Number(core.getInput('pr-number', { required: true }))
  const headSha = core.getInput('head-sha', { required: true })
  const baseSha = core.getInput('base-sha', { required: true })
  const diffFullPath = core.getInput('diff-full-path', { required: true })
  const model = core.getInput('model') || 'claude-sonnet-4-6'
  const decisionLabel =
    core.getInput('decision-label') || 'ladon/needs-human-review'
  const ladonBotLogin = core.getInput('ladon-bot-login') || 'ladon[bot]'

  const findings = parseFindings(findingsRaw)
  const priorDecision = parsePriorDecisionInput(priorDecisionInput)
  const diffStats = await computeDiffStatsFromFile(diffFullPath)
  let activeChangeRequestIds: number[] = []
  if (activeChangeRequestsPath) {
    try {
      activeChangeRequestIds = changeRequestIds(
        await readFile(activeChangeRequestsPath, 'utf8'),
      )
    } catch (err) {
      core.warning(
        `Could not read active Ladon change-request context: ${err instanceof Error ? err.message : String(err)}. Superseded reviews will not be dismissed.`,
      )
    }
  }

  const ctx = github.context
  const { owner, repo } = ctx.repo
  const octokit = github.getOctokit(githubToken)

  const authorLogin = (ctx.payload.pull_request?.user?.login as string) ?? ''
  const baseRef = (ctx.payload.pull_request?.base?.ref as string) ?? ''

  const authorTeamMatches = await findNoAutoApproveTeams({
    octokit,
    org: owner,
    username: authorLogin,
    teamSlugs: noAutoApproveTeams,
  })

  const hasBlockingFindings = findings.findings.some(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  )
  let reviewCleanupWarning: string | null = null
  if (
    reviewDecision === 'CHANGES_REQUESTED' &&
    !hasBlockingFindings &&
    activeChangeRequestIds.length > 0
  ) {
    const cleanup = await dismissSupersededChangeRequests({
      octokit,
      owner,
      repo,
      prNumber,
      ladonBotLogin,
      expectedHeadSha: headSha,
      recheckedReviewIds: activeChangeRequestIds,
    })
    if (cleanup.headChanged) {
      core.info(
        `Skipping stale arbiter run for ${headSha}; the PR head changed before review cleanup.`,
      )
      return
    }
    if (cleanup.dismissed > 0) {
      core.info(
        `Dismissed ${cleanup.dismissed} superseded Ladon change-request review(s).`,
      )
    }
    reviewCleanupWarning = cleanup.warning
    reviewDecision =
      (await fetchReviewDecision({ octokit, owner, repo, prNumber })) ??
      reviewDecision
  }
  if (
    gatedPaths &&
    reviewDecision === 'APPROVED' &&
    !(await hasHumanApproval({
      octokit,
      owner,
      repo,
      prNumber,
      ladonBotLogin,
    }))
  ) {
    core.info(
      'Ignoring aggregate APPROVED state for the gated-path check because no active human approval exists.',
    )
    reviewDecision = 'REVIEW_REQUIRED'
  }

  const prompt = buildArbiterPrompt({
    repoSlug: `${owner}/${repo}`,
    prNumber,
    baseRef,
    headSha,
    baseSha,
    findings,
    diffStats,
    highRisk,
    highRiskReasons,
    gatedPaths,
    gatedPathsReasons,
    reviewDecision,
    protectedBranches,
    noAutoApproveTeams,
    authorTeamMatches,
    priorDecision,
    repoContext: repoContextRaw.trim() ? repoContextRaw : null,
    severityRules: SEVERITY_RULES,
    decisionRules: DECISION_RULES,
  })

  const llmDecision = await decideViaAnthropic({
    apiKey: anthropicApiKey,
    model,
    prompt,
  })

  const enforced = enforceDecisionGuards(llmDecision, {
    authorTeamMatches,
    gatedPaths,
    gatedPathsReasons,
    reviewDecision,
  })
  let decision = enforced.decision
  for (const message of enforced.overrides) {
    core.warning(`Decision override applied: ${message}`)
  }
  if (
    reviewCleanupWarning &&
    decision.outcome === 'escalate' &&
    !decision.escalation_reasons.includes(reviewCleanupWarning)
  ) {
    decision = {
      ...decision,
      escalation_reasons: [
        ...decision.escalation_reasons,
        reviewCleanupWarning,
      ],
    }
  } else if (reviewCleanupWarning && decision.outcome === 'comment') {
    decision = {
      ...decision,
      summary: `${decision.summary}\n\n${reviewCleanupWarning}`,
    }
  }

  const body = renderReviewBody({
    decision,
    findings,
    headSha,
    highRisk,
    highRiskReasons,
  })

  await postReview({
    octokit,
    owner,
    repo,
    prNumber,
    headSha,
    event: mapOutcomeToReviewEvent(decision.outcome),
    body,
  })

  if (decision.outcome === 'escalate') {
    await ensureLabel({ octokit, owner, repo, name: decisionLabel })
    await addLabel({ octokit, owner, repo, prNumber, label: decisionLabel })
    if (escalationReviewers.length > 0) {
      await requestReviewers({
        octokit,
        owner,
        repo,
        prNumber,
        reviewers: escalationReviewers,
      })
    }
  }

  core.setOutput('outcome', decision.outcome)
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
