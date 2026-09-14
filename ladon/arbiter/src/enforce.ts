import type { ArbiterDecision } from './anthropic.js'
import type { Finding } from './findings.js'
import type { PriorDecision } from './prior-decision.js'

export interface EnforcementContext {
  authorTeamMatches: string[]
  autoApprove?: boolean
  findings?: Finding[]
  highRisk?: boolean
  highRiskReasons?: string[]
  priorDecision?: PriorDecision | null
  gatedPaths?: boolean
  gatedPathsReasons?: string[]
  reviewDecision?: string
}

export interface EnforcementResult {
  decision: ArbiterDecision
  overrides: string[]
}

const NO_AUTO_APPROVE_OVERRIDE_PREFIX =
  '> **[Override: forced from `approve` to `comment` by post-LLM enforcement]**'
const GATED_PATH_OVERRIDE_PREFIX =
  '> **[Override: forced from `approve` to `escalate` by post-LLM enforcement]**'

export function enforceDecisionGuards(
  decision: ArbiterDecision,
  ctx: EnforcementContext,
): EnforcementResult {
  const overrides: string[] = []
  let result = decision

  // In findings-only mode the action result is a policy check, so enforce the
  // blocking rows of arbiter-decision.md before suppressing approval. An LLM
  // "approve" or "comment" must not turn a known blocker into a green check.
  if (ctx.autoApprove === false) {
    const findings = ctx.findings ?? []
    const blockers = findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'high',
    )
    const mediums = findings.filter((f) => f.severity === 'medium')
    const reasons: string[] = []
    if (
      ctx.highRisk &&
      ctx.highRiskReasons?.some((r) => r.includes('(deleted)'))
    ) {
      reasons.push('Deletion in a high-risk path requires human review.')
    }
    if (
      mediums.some((f) => ['data-loss', 'schema', 'infra'].includes(f.category))
    ) {
      reasons.push(
        'Medium finding in a sensitive category requires human review.',
      )
    }
    if (
      ctx.highRisk &&
      ctx.highRiskReasons?.some(
        (r) => r.includes('(modified)') || r.includes('(renamed)'),
      ) &&
      mediums.length > 0
    ) {
      reasons.push(
        'Medium finding with a modified high-risk path requires human review.',
      )
    }
    if (
      ctx.priorDecision?.outcome === 'escalate' &&
      findings.some((f) => f.severity !== 'low')
    ) {
      reasons.push('Prior escalation still has actionable findings.')
    }
    if (ctx.gatedPaths && ctx.reviewDecision !== 'APPROVED') {
      reasons.push('Gated paths require human/CODEOWNERS approval.')
    }
    if (blockers.length > 0) {
      result = {
        ...result,
        outcome: 'request-changes',
        blocking_findings: blockers.map(
          (f) => `${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}`,
        ),
      }
      overrides.push(
        'Critical/high findings require changes regardless of the model verdict.',
      )
    } else if (reasons.length > 0 && result.outcome !== 'request-changes') {
      result = {
        ...result,
        outcome: 'escalate',
        escalation_reasons: [...result.escalation_reasons, ...reasons],
      }
      overrides.push(...reasons)
    }
  }

  // Gated-paths mirrors the decision table's row 2 (see arbiter-decision.md):
  // the LLM is expected to apply that row directly and choose `escalate`
  // itself, exactly like the author-team HARD RULE below. This block is the
  // same dual-layer code-level backstop that HARD RULE already documents for
  // author-team gates — not the sole place the gate is evaluated.
  //
  // It runs BEFORE the author-team check: it is the stronger, more
  // restrictive outcome (escalate implies request-reviewers + label, which
  // comment does not trigger). If both gates fail on the same PR, escalate
  // must win — checking author-team first would downgrade to comment and
  // the author-team block's own `outcome === 'approve'` guard would then
  // no-op, silently dropping the gated-paths signal.
  const gateUnsatisfied =
    Boolean(ctx.gatedPaths) && ctx.reviewDecision !== 'APPROVED'
  if (gateUnsatisfied) {
    const reason = `This PR touches a path under a hard, non-overridable approval gate (${ctx.gatedPathsReasons?.join('; ') || 'gated path matched'}) and the current GitHub review decision is '${ctx.reviewDecision || 'unknown'}', not APPROVED. This is a hard gate enforced in code — Ladon cannot auto-approve until a human/CODEOWNERS approval is recorded, regardless of how clean the diff is.`

    if (result.outcome === 'approve') {
      overrides.push(reason)
      result = {
        ...result,
        outcome: 'escalate',
        escalation_reasons: [...result.escalation_reasons, reason],
        summary: `${GATED_PATH_OVERRIDE_PREFIX}\n>\n> ${reason}\n\n${result.summary}`,
      }
    } else if (
      result.outcome === 'escalate' &&
      !result.escalation_reasons.includes(reason)
    ) {
      // The LLM already escalated — for this row or an unrelated one (rows
      // 1, 3-6 in the decision table all also produce `escalate`). Ensure
      // the gated-paths reason is visible regardless: a human reading only
      // the LLM's own reasons should never conclude the PR is clear to merge
      // once whatever else triggered the escalation is resolved, when the
      // approval gate is independently still unsatisfied.
      overrides.push(reason)
      result = {
        ...result,
        escalation_reasons: [...result.escalation_reasons, reason],
      }
    }
  }

  if (result.outcome === 'approve' && ctx.authorTeamMatches.length > 0) {
    const reason = `PR author belongs to no-auto-approve team(s): ${ctx.authorTeamMatches.join(', ')}. This is a hard gate enforced in code — Ladon cannot auto-approve PRs from these teams regardless of how clean the diff is.`
    overrides.push(reason)
    result = {
      ...result,
      outcome: 'comment',
      summary: `${NO_AUTO_APPROVE_OVERRIDE_PREFIX}\n>\n> ${reason}\n\n${result.summary}`,
    }
  }

  if (ctx.autoApprove === false && result.outcome === 'approve') {
    const reason =
      'Automatic approval is disabled (auto-approve=false). Ladon findings do not satisfy the required human review.'
    overrides.push(reason)
    result = {
      ...result,
      outcome: 'comment',
      summary: `${reason}\n\n${result.summary}`,
    }
  }

  return { decision: result, overrides }
}
