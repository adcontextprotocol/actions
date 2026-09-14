# AdCP human approval adoption

This change provides an opt-in no-approval boundary. **It does not by itself fix
branch protection.** Both consuming workflows must adopt it, existing approvals
and in-flight old runs must be accounted for, and maintainers must audit the
rulesets. Keep the actions PR Draft and auto-merge off during coordination.

## Incident and audited revisions

On 2026-09-14, [adcp-client #2911](https://github.com/adcontextprotocol/adcp-client/pull/2911)
merged with only an AAO Secretariat App approval at head
`a6834d67870253674178d099447af36dd6640b11`; `bmilekic` remained requested and had
not reviewed. The PR author enabled auto-merge. REST evidence records review
5200764177 at `17:23:07Z` and merge `8ba12c2ace85a88533ce1d56efd35badea51a97c`
at `17:23:15Z`. Green source CI and an independent agent audit were not human
approval. The incident report records no package release;
[Version Packages #2912](https://github.com/adcontextprotocol/adcp-client/pull/2912)
was confirmed open, Draft, and without auto-merge during this audit. Its
quarantine is outside this change.

Complete consuming workflows were read at these current-main snapshots:

| Repository  | Main commit                                | Tree                                       |
| ----------- | ------------------------------------------ | ------------------------------------------ |
| actions     | `a64a17ba369122d6b3401f614a31df7b8607f043` | `0029081e46f388904c186c3402a0a4eb9dd523cc` |
| adcp        | `36a86d6c4ae5c42e5e2e783d95bdb97b5cb6f614` | `c285d352a02be51e4a787d6208d52230dea81330` |
| adcp-client | `8ba12c2ace85a88533ce1d56efd35badea51a97c` | `1771a8ef743b4ddcd89c836cee39563096dac82e` |

Sources: [adcp workflow](https://github.com/adcontextprotocol/adcp/blob/36a86d6c4ae5c42e5e2e783d95bdb97b5cb6f614/.github/workflows/ai-review.yml),
[adcp-client workflow](https://github.com/adcontextprotocol/adcp-client/blob/8ba12c2ace85a88533ce1d56efd35badea51a97c/.github/workflows/ai-review.yml).
Both use `pull_request_target`, a trusted base checkout, `code_review`, the
review-workflow-modification gate, and `@ladon/review/v1`. The client workflow
explicitly says App reviews count toward “1 review required.” Neither supplies
an approval control at the audited revision.

At audit time, review/setup/arbiter floating v1 tags resolved to
`ab7c8394702dad2244b48143c78b6651cd5215ed`; reviewer v1 resolved to the actions
base commit above. No tag was moved by this work.

## Follow-up incident evidence and global hold (2026-09-14 UTC)

The original snapshots above are historical. Consumer adoption was refreshed to
adcp `1467e46117e8d329f4116e548e9290be75d8e3b3` (tree
`023fac83c8812e6148519ba8a4cfe2a49fbb3070`) and client
`55829081dae2673f73615af2a4f6f029cddff813` (tree
`75aa2d649b3234643ec4619ea7b65a8b86d44320`). Existing open PR evidence, including
adcp #7450/#7462, remains on its recorded older base until independently
refreshed; this change does not recompute their merge trees.

[adcp #7521](https://github.com/adcontextprotocol/adcp/pull/7521) demonstrates a
**second, distinct bypass**. Base was
`36a86d6c4ae5c42e5e2e783d95bdb97b5cb6f614`; head was
`e680c97e05e69cf3d7b6bf60aed07c42657c420c`. Its only review, Secretariat
`5200346889`, was COMMENTED at `16:38:41Z` with an explicit Ladon human/CODEOWNERS
escalation for modified
`static/schemas/source/compliance/comply-test-controller-{request,response}.json`
and `REVIEW_REQUIRED`. There were **zero APPROVED reviews**. Author `bokelley`
merged it himself at `18:02:02Z` as
`1467e46117e8d329f4116e548e9290be75d8e3b3`; final `auto_merge` was null.
An escalation comment or optional check cannot stop an author with effective
merge permission. The precise bypass rule still requires administrator audit.

[adcp-client #2913](https://github.com/adcontextprotocol/adcp-client/pull/2913)
had only bot approval at exact head
`bfacfeb66178d161254830faef48f36a5a6a629e`: Secretariat review `5201034616`
APPROVED at `17:51:07Z`, while `bmilekic` remained requested without reviewing.
After the coordinator disabled auto-merge and placed it Draft, author `bokelley`
re-enabled auto-merge at `17:57:24Z`. It merged at `17:59:28Z` as
`55829081dae2673f73615af2a4f6f029cddff813` (base
`8ba12c2ace85a88533ce1d56efd35badea51a97c`). Secretariat review `5201137108`
APPROVED that same head at `18:01:40Z`, **after merge**. The later approval
cannot supply human evidence or explain the earlier merge; it confirms older
approval-capable runs can continue writing. Draft/auto-off comments are
advisory against an author/admin and are not a protection boundary.

Generated #2912 advanced to `1be6b25e8083601f8bf08f1b701435181f33215f` on
base `55829081dae2673f73615af2a4f6f029cddff813`, and was still Draft/auto-off.
Coordinator evidence reports npm dist-tags unchanged at rc.36 / latest 13.0.4,
with no new package published. **Maintain a global release/merge hold** until
both human-reviewed immutable consumer pins land and an authorized human
configures and validates an actually required, trusted exact-head human gate.
PR #29 alone cannot prevent manual author/admin bypass or older runs.

Consumer runtime pins stay at reviewed orchestrator
`85284cbc297875aa04b2d5afcf7ae833b29f329c`, nested setup/arbiter
`292a0da93b25c3e9ecfcf5a05763a4206c472c3a`, and reviewer
`a64a17ba369122d6b3401f614a31df7b8607f043`. Documentation-only updates to this
PR do not require moving those runtime pins. The consumer configuration tests
reject missing approval inputs; the shared compatible default remains true.

## Approval paths and the new boundary

1. The arbiter maps an `approve` model outcome to an `APPROVE` review API call.
   Its own-PR 422 fallback tries approval **before** posting COMMENT; a fallback
   is not a no-approval guarantee. Disabled mode converts the decision to
   `comment` before rendering its Ladon body/marker and also clamps APPROVE to
   COMMENT at the final API boundary, before the first write.
2. Setup can signal `reapprove=true` on an empty/trivial delta or pure rebase,
   using a previous Ladon `approve` marker plus aggregate `REVIEW_REQUIRED`.
   The orchestrator then POSTs `APPROVE` directly, bypassing the arbiter's team,
   gated-path and high-risk checks. The compatible mode retains that legacy
   behavior; it must not be used as a human-only gate. Disabled mode suppresses
   renewal in setup, the orchestrator condition, and the shell itself. It
   reviews the full PR surface on every run so a prior failed/escalated result
   cannot silently become a successful skip or lose an unresolved medium finding
   outside an incremental delta. This costs more review work than legacy mode.
3. The reviewer has inline-comment and finding-persistence tools, read-only gh
   commands, and one finalization-only retry. It has no permitted top-level
   review/gh write tool. Incomplete review state fails before the arbiter runs.
   Workflow-modification notices use COMMENT. Bot-author/self-trigger skips
   never produce approval.

Set `auto-approve: 'false'` in the **trusted consuming workflow**, not in PR
prose or LADON.md. The manifest default stays `'true'` for existing consumers.
Explicit empty, malformed, or unsupported values fail before posting. The
same input is available on setup and arbiter for direct users; they must apply
it consistently and remove/guard any approval code in their own orchestrator.

In disabled mode:

| Result                                          | Review event                                 | Action result                                      |
| ----------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Clean or nonblocking findings                   | COMMENT, with Ladon body and decision marker | Success after complete review                      |
| Critical/high findings                          | REQUEST_CHANGES                              | Failure                                            |
| Governance/high-risk escalation                 | COMMENT, escalation label/reviewer request   | Failure                                            |
| Incomplete reviewer, API failure, invalid input | No approving review                          | Failure                                            |
| Existing configured author/event skip           | No approving review                          | Existing skip behavior; **not evidence of review** |

Known blocking policy rows are enforced in code in disabled mode even if the
model returns approve/comment. Renames count as modifications, and bounded
path diagnostics retain change-kind facts even when individual reasons exceed
the input budget. An escalation remains failed until its reason
is resolved; a human approval alone does not turn a destructive-change
escalation green. Maintainers must explicitly handle an intentional high-risk
change under their audited human exception procedure, not add
`continue-on-error` or an unconditional successful check. The original mode's
review/check semantics remain compatible.

The orchestrator pins setup/arbiter to an immutable implementation commit with
this control and reviewer to the audited base commit. Otherwise an old nested
floating action could ignore `auto-approve` and create approval before any
post-action capability check. Future sub-action updates require an explicit
orchestrator pin update, tests, and review. Preserve the referenced commits
when landing this series; do not discard the implementation commit while
retaining its pin.

## Auto-merge race and limits

An approving review is a durable GitHub write. Posting APPROVE and subsequently
dismissing it or failing a check leaves a merge window, especially if the
review job is optional, skipped, or an older successful check is accepted.
This implementation never emits that initial approval in disabled mode. Tests
inspect every review API call and execute the reapproval shell with a fake gh;
cleanup is not the control.

COMMENT does **not** erase an existing active approval. Nor can this action
stop a run using an older workflow/action revision, another App, a machine
account typed as `User`, or a bypass actor. A required job that skips may count
as successful; a path-filtered workflow may remain pending. See
[GitHub's required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
The legacy `hasHumanApproval` helper is a supplemental gated-path check, not an
exact-head, authorized-human gate: it does not verify latest per-user review,
commit, author exclusion, or reviewer authority. Do not use it as that gate.

## Coordinated landing order

1. **Hold merges during migration.** Human maintainers keep affected PRs Draft
   or auto-merge disabled, identify/cancel/drain old approval-capable runs, and
   inspect active Ladon approvals. Dismiss obsolete bot approvals while the
   hold is in place. Never depend on racing a cleanup against auto-merge.
2. Obtain exact-head CI and independent security review for the actions Draft
   PR, then explicit human review. Record base/head/tree, immutable sub-action
   pins, tests, and review evidence in the PR. No publishing or tag movement
   is authorized by this preparation.
3. Open **separate human-reviewed follow-up PRs in adcp and adcp-client**. In
   each `.github/workflows/ai-review.yml`, pin `Run Ladon` to the human-reviewed
   actions PR head SHA (replace `REVIEWED_ACTIONS_SHA` below), and add the input:

   ```yaml
   - name: Run Ladon
     if: steps.workflow-mod.outputs.modified != 'true'
     uses: adcontextprotocol/actions/ladon/review@REVIEWED_ACTIONS_SHA
     with:
       auto-approve: "false"
       # Retain each repository's existing credentials, model, and bot list.
   ```

   Remove the client's claim that Ladon satisfies “1 review required.” State
   in both workflows that Ladon provides automated findings and human approval
   is separate. Preserve `pull_request_target`, base-SHA checkout, `code_review`,
   permissions and the workflow-modification gate. Preserve each bot list
   (`aao-release-bot[bot]` in adcp; `aao-ipr-bot[bot]` in adcp-client).
   Do not relax the gate to test the new workflow against its own PR head.
   Pure workflow edits are path-filtered; mixed PRs get only the base
   workflow's COMMENT and skip Ladon. Neither follow-up can self-approve.
   If filtered required checks stay pending, a maintainer must resolve that
   through the audited human procedure; do not manufacture a green result.

4. **Land both consumer PRs with real human approval before moving
   `ladon/review/v1`.** Pinning the reviewed implementation makes the new mode
   effective without waiting for a tag. Confirm both default-branch workflows
   contain the pin/input and inspect runs at those revisions. Keep old runs
   and pre-existing approvals under the migration hold until accounted for.
5. Complete the ruleset audit below. Only after both consumers have landed and
   verification is recorded may maintainers authorize merging/publishing the
   actions change. **Merging this PR to actions/main automatically invokes
   `merge-publish.yml`**, which advances affected patch and floating major tags;
   `manual-version-publish.yml` can also move them. Thus merging the actions PR
   first would violate the required order even without a manual tag command.
   No tag, merge, deployment, or publication is performed in this task.
6. Keep the consumer SHA pins for reproducibility, or human-review a later
   switch to the promoted `@ladon/review/v1`, retaining `auto-approve: 'false'`.
   A later workflow change is subject to the same human-only modification gate.

## Required manual ruleset audit

Read-only ruleset inspection was available. Both repositories inherit active
organization ruleset `8519441` (one approval, CODEOWNERS required, admin/role
and integration bypasses). Their active repository rulesets `15545291` (adcp)
and `15545837` (client) additionally dismiss stale approvals and require
last-push approval. These are **approval-count rules**, not proof of a human.
The visible required-check lists include source CI and IPR, but neither
`code_review` nor a separate human-review check. The classic branch-protection
API returned **403** for both; therefore this is not a complete effective-rule
audit. No settings were changed.

An authorized maintainer must inspect repository **and inherited organization**
rulesets, classic protection, CODEOWNERS coverage, App permissions and all
bypass actors. Confirm which exact check contexts and expected App identities
are required, including skipped/path-filtered cases. Record the actual rules
and verification evidence; requesting a reviewer is not approval.

If a human-only approval requirement is not already independently enforced,
add a trusted required check (for example `Human review / exact head`) with
these properties before lifting the hold:

- Read live PR head and paginated reviews using trusted base code. Count only
  the latest effective non-dismissed approval from an authorized maintainer or
  required owner at that exact head; exclude the PR author, all Apps/bots and
  explicitly identified automation accounts, including those typed as User.
- Verify current reviewer authority and CODEOWNERS/required-team policy; fail
  closed on unknown identity, permissions, incomplete data, or API failure.
- Recompute on synchronize, ready-for-review, review submission/dismissal and
  other policy-affecting events. Tie status to the live head, reject stale
  workers, and reset on head/approval changes. Review-only events must not
  execute PR-head code or expose write credentials to it.
- Publish a uniquely named required status/check from a trusted producer,
  configure the expected App where supported, and cover workflow-modifying,
  bot-authored, fork, rebase, and merge-queue cases. Skips must never mean
  “human approved.” Audit bypasses and concurrent review dismissal behavior.
- Verify on controlled PRs: bot-only approval stays blocked, requested-but-no-
  review stays blocked, dismissed/old-head/self approval stays blocked, an
  authorized exact-head human approval lifts only the human gate, and blocking
  Ladon findings still prevent merging under the repository's policy.

[GitHub documents required reviews, bypass behavior, and expected check sources](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
This separate gate must itself be installed through human-reviewed workflow
and ruleset changes. The shared action cannot supply repository-wide human
identity enforcement with its current workflow permissions and event coverage.
Do not report branch protection fixed until consumer adoption and the
applicable tag/ruleset changes are actually complete.

### Administrator action and controlled validation after #7521/#2913

An explicitly authorized administrator must export the effective rules for
main from repository Settings → Rules → Rulesets, inherited organization
rules, classic protection, CODEOWNERS and every role/App/direct-push bypass.
Determine the exact permission that allowed #7521's author to merge without any
approval. Install the separately human-reviewed trusted producer and require
`Human review / exact head` from its specific App identity; require blocking
Ladon results under an explicit workflow-modification/high-risk exception
policy as well. The new consumer `Ladon approval policy` CI job is only a
configuration/regression check, not this human gate.

The human gate must exclude the PR author, verify **current** collaborator and
CODEOWNER/team authority, and reject bots/Apps and known automation accounts
masquerading as users. Make it non-bypassable by ordinary authors, including
the author role implicated by #7521. Remove broad role/App bypasses or confine
any emergency override to an independently controlled, logged procedure;
prevent direct pushes and alternative merge entrypoints from bypassing it.
No settings change is authorized by this preparation or by green CI.

Recompute and invalidate on head, review/dismissal, base/CODEOWNERS and
membership/permission changes. Serialize workers and re-read live head,
review state and authority before publishing; use native stale-dismissal and
last-push rules too. Status webhooks are asynchronous: do not assert atomic
review-dismissal/merge safety without evidence. Retain the operational hold
and an authorized trusted merge procedure if that race is not closed.

Start controlled validation on a non-production branch with matching effective
protection and no deployment/release hooks. Actual merge attempts require
separate explicit administrator authority. Prove rejection under ordinary
author credentials for no review, bot-only approval, COMMENT-only escalation
(#7521), requested-but-absent review, self/old-head/dismissed approval, lost
collaborator/CODEOWNER authority, missing/skipped/failed status, API failure,
stale worker, fork, workflow modification, rebase and merge queue. Exercise
concurrent push, dismissal and auto-merge. A current-head authorized non-author
human approval satisfies only the human gate; blocking Ladon findings must
remain blocking. Then verify actual main's effective rules and producer App;
a sandbox-only result does not prove main enforcement. Record rule exports,
exact heads/statuses/reviewer authority, denied merge attempts and a named
administrator's acceptance before lifting the global hold or promoting tags.
