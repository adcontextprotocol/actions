# AdCP human approval adoption

**Branch protection is not fixed by this PR. Maintain the global release/merge
hold.** Reviews default to findings without approval; the shared action still
cannot prevent author/admin bypass, other Apps, or old approval-capable runs.
Keep #29 and all four external adoption PRs Draft/auto-off. Requesting a human
reviewer or obtaining an agent audit does not satisfy human approval.

## Complete intended Ladon consumer inventory

The original two-repository inventory was incomplete. All **five** consumers
are in scope; none has explicit human risk acceptance for an exclusion.
Snapshots below record the unsafe pre-adoption state, not an enforcement claim.

| Repository         | Exact main snapshot                        | Existing invocation                                               |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| actions            | `a64a17ba369122d6b3401f614a31df7b8607f043` | local `./ladon/review`, approving default                         |
| adcp               | `1467e46117e8d329f4116e548e9290be75d8e3b3` | floating `@ladon/review/v1`, missing input                        |
| adcp-client        | `55829081dae2673f73615af2a4f6f029cddff813` | floating `@ladon/review/v1`, missing input, claims App counts     |
| adcp-go            | `2f99fb0e8ede3639cc367577decfc5a544af297a` | floating `@ladon/review/v1`, missing input, claims App counts     |
| adcp-client-python | `09382bb47e8c03f340c6cf4370f9f65be09dce62` | old pin `48c0dfef96594f74f9606d68597c0f7062a5a337`, missing input |

All invocation sites are `.github/workflows/ai-review.yml`. Exact code search
`org:adcontextprotocol "ladon/review" path:.github/workflows` returned six
files: these five invocations plus actions' `merge-publish.yml` release metadata
(a string reference, not a review invocation). The audit additionally enumerates
all visible active organization repositories and reads their workflow blobs at
exact default-branch commits because search indexing can lag. A human must
confirm the credential can see the entire intended organization.

`ladon/consumer-policy.json` is the explicit inventory. The deterministic tests
reject a sixth consumer, missing expected consumers, added invocation sites,
wrong/local/floating pins, missing/nonliteral/true inputs, malformed YAML,
partial search results and incomplete enumeration. No approving consumer is
accepted. Explicit true compatibility is tested solely as a supported opt-in;
adding an approving consumer would require separate human policy acceptance,
recorded inventory and a reviewed change to this enforcement contract.

## Reviewed immutable implementation

- Orchestrator and approval-boundary regression suite:
  `3d180c9b365c201d4cd4cfd93d0c2a7e8790da70`.
- Nested setup/arbiter manifests, source and executable bundles:
  `02db55f54f39f93c683c2031887b735aea0ecba2`.
- Nested reviewer: `a64a17ba369122d6b3401f614a31df7b8607f043`.

All five proposed workflows pin that orchestrator and set `auto-approve: 'false'`
explicitly. Actions' own workflow changes as part of #29, retains the trusted
base checkout and original `ladon/*`/workflow/LADON.md human modification gate,
and cannot approve itself. All four external PRs preserve their existing human
modification gates. Python removes its legacy post-review retirement invocation,
which trusted a bot approval; the reviewed arbiter handles superseded findings
after complete review. The old retirement script remains protected by Python's
existing modification gate. Do not revive it as a cleanup-based approval guard.

Unlike superseded head `85284cbc297875aa04b2d5afcf7ae833b29f329c`, this artifact
**defaults false in all three manifests**. Direct helper omissions also deny
approval/shortcuts. Raw empty/malformed/nonliteral inputs fail before reviews;
composite validation precedes App token minting. Tests cover runner-injected
omission defaults and missing raw input, with zero APPROVE/reapprove API calls.
The new default is a behavior change: legacy approval requires explicit true.
No existing floating tag or published action has been changed by this PR.

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
prose or LADON.md. The review/setup/arbiter manifest defaults are now `'false'`: omission
cannot enable approval. Only explicit `'true'` opts into compatibility behavior,
and the intended organization inventory rejects that mode.
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

## Three incidents, two distinct bypasses (2026-09-14 UTC)

1. [adcp-client #2911](https://github.com/adcontextprotocol/adcp-client/pull/2911)
   had only `aao-secretariat[bot]` APPROVED at exact head
   `a6834d67870253674178d099447af36dd6640b11`. Requested `bmilekic` never reviewed.
   REST review `5200764177` was submitted at `17:23:07Z`; author-enabled
   auto-merge completed at `17:23:15Z` as
   `8ba12c2ace85a88533ce1d56efd35badea51a97c`. No package release was recorded.
2. [adcp #7521](https://github.com/adcontextprotocol/adcp/pull/7521)
   had **zero APPROVED reviews**. Its only review, `5200346889`, was
   `aao-secretariat[bot]` COMMENTED at `16:38:41Z` on exact head
   `e680c97e05e69cf3d7b6bf60aed07c42657c420c`, explicitly escalating changes to
   `static/schemas/source/compliance/comply-test-controller-{request,response}.json`
   for human/CODEOWNERS approval with `REVIEW_REQUIRED`. Base was
   `36a86d6c4ae5c42e5e2e783d95bdb97b5cb6f614`. Author `bokelley` nevertheless
   merged it himself at `18:02:02Z` as
   `1467e46117e8d329f4116e548e9290be75d8e3b3`; final `auto_merge` was null.
   This demonstrates author self-merge despite an explicit human escalation;
   disabling bot APPROVE addresses only the first incident's approval path.
   It does not prove which effective bypass permission enabled the second.

3. [adcp-client #2913](https://github.com/adcontextprotocol/adcp-client/pull/2913)
   had only bot approval at exact head
   `bfacfeb66178d161254830faef48f36a5a6a629e`: Secretariat review `5201034616`
   APPROVED at `17:51:07Z`; `bmilekic` remained requested without reviewing.
   After the coordinator disabled auto-merge and put the PR in Draft, author
   `bokelley` re-enabled auto-merge at `17:57:24Z` and it merged at `17:59:28Z`
   as `55829081dae2673f73615af2a4f6f029cddff813` (base
   `8ba12c2ace85a88533ce1d56efd35badea51a97c`). Bot review `5201137108`
   APPROVED the same head at `18:01:40Z`, **after merge**; it cannot be human
   evidence or a cause of that merge. Old approval-capable runs can still write
   approvals, and Draft/auto-off comments are advisory against an author/admin.

Initial inspection found inherited organization ruleset `8519441` and repository
rulesets `15545291` (adcp) / `15545837` (client). Approval-count/CODEOWNERS rules
and stale/last-push rules were visible, with role/admin/integration bypasses.
Visible required checks did not include `code_review` or a separate human gate.
Classic protection returned 403, so this was **not a complete effective audit**.
An escalation comment or an optional failed check does not enforce a merge hold.

## Exact organization audit before and after publication

Run from a trusted checkout with read-only GitHub access after the four external
pins land and the actions candidate has exact CI, independent audit and human
approval:

```sh
npm ci --ignore-scripts
node scripts/audit-ladon-consumers.cjs --actions-head EXACT_REVIEWED_ACTIONS_PR_HEAD > candidate-inventory.json
```

The option accepts only an immutable actions SHA and replaces **only** actions'
workflow snapshot; all four external consumers must already be safe on their
live default branches. The report explicitly says it is a pre-publication
candidate, **not live enforcement**. This avoids pretending actions/main is
already safe before #29 lands. Any unsafe/unknown site, partial API data or
head movement returns nonzero and keeps the hold. Do not use a PR head override
for an external consumer to bypass landing order.

After separately authorized publication, repeat without the option to audit all
five live defaults:

```sh
node scripts/audit-ladon-consumers.cjs > live-inventory.json
```

Neither command modifies GitHub, tags or rulesets, and neither replaces the
administrator's human-gate audit. Current live runs are expected to fail while
unsafe old workflows remain; do not turn that into an unconditional green CI.

## Coordinated dependency order and quarantine

1. Maintain the operational human merge hold. Inventory active bot approvals and
   all older runs (including reruns, queued jobs, other review entrypoints and
   App/machine users). Authorized maintainers must cancel/drain them and dismiss
   obsolete approvals under the hold. COMMENT never revokes an old approval;
   this pin cannot stop an in-flight older action. Do not race cleanup against
   auto-merge. No such cancellation/dismissal is performed by this PR.
2. Obtain exact-head CI and independent audit, then actual human review of
   **all four** separate external consumer PRs. Land all four external immutable pins through the audited
   human procedure. External consumers may land in any order; all four precede actions
   promotion. Do not loosen the workflow-modification gate for testing.
3. Complete the administrator audit/controlled validation below before lifting
   the hold or merging actions #29. Merging actions/main invokes automatic tag
   publication. **Do not merge #29 or move `ladon/review/v1` until all four
   human-reviewed external consumer pins have landed and the effective human gate is
   verified.** Keep consumer SHA pins after promotion.
4. Keep [Version Packages #2912](https://github.com/adcontextprotocol/adcp-client/pull/2912)
   quarantined Draft/auto-off. Its generated head advanced to
   `1be6b25e8083601f8bf08f1b701435181f33215f` on base
   `55829081dae2673f73615af2a4f6f029cddff813` after #2913 merged externally.
   Coordinator evidence reports npm dist-tags still at rc.36 / latest 13.0.4,
   with no new package published. Maintain a **global release/merge hold**
   until all four external consumer pins land and an authorized human configures and
   validates the actually required trusted human-approval gate. This work does
   not undo #2913's merge, authorize a release, or change either PR.

Main snapshots are evidence at a point in time, not moving claims. The consumer
bases were refreshed to adcp `1467e46117e8d329f4116e548e9290be75d8e3b3` and
client `55829081dae2673f73615af2a4f6f029cddff813`. PR bodies record their exact
base/head/tree and CI/audit evidence. Other open PRs, including adcp #7450/#7462,
retain their older-base evidence until individually refreshed; this adoption
makes no claim to have recomputed their merge trees.

## Required administrator action (not executed here)

An explicitly authorized repository/organization administrator must:

1. Export the **effective** main rules from repository Settings → Rules →
   Rulesets, inherited organization rules, classic branch protection, and all
   bypass lists. Record rule IDs, branch patterns, enforcement, expected check
   producer App IDs, CODEOWNERS coverage and current permissions. Determine
   exactly how #7521's author was permitted to merge. Inspect admin/custom-role,
   write/maintain-role, integration, merge-queue and direct-push bypasses.
2. Install a separately reviewed, trusted producer for required status
   `Human review / exact head`. Run trusted base or independent App code only;
   never PR-head code with write credentials. Require its specific producer
   App identity, not just a spoofable context name. Require the policy's Ladon
   blocking result as well, with explicit handling of workflow-modification
   human holds and high-risk exceptions; optional failures do not block merge.
3. The human producer must paginate reviews, resolve the latest effective
   non-dismissed review per person, and count only APPROVED at the **live exact
   head** from currently authorized collaborators/required CODEOWNERS. Exclude
   the PR author, all Apps/bots, and known automation accounts typed as User.
   Check current collaborator permissions, required teams and CODEOWNERS at the
   trusted base; fail closed on unknown identities, missing authority, partial
   data or API failure. Requested reviewers alone never count.
4. Recompute on push/synchronize, ready-for-review, review submission/dismissal,
   base/policy/CODEOWNERS and membership/permission changes; handle merge queues
   explicitly. Serialize per PR, re-read head and review/authority state before
   publishing, reject stale workers, and invalidate success when any input
   changes. Combine with native stale-review dismissal and last-push approval.
   Status webhooks are asynchronous: document and test the dismissal/merge
   race; if atomic enforcement is not established, retain the operational hold
   and use an authorized, trusted merge procedure that revalidates immediately.
5. Make the requirement **non-bypassable by ordinary authors**, including the
   author role implicated by #7521. Remove broad role/App bypasses or constrain
   them to an independently controlled, logged emergency procedure unavailable
   to ordinary authors. Prevent direct-push and alternative merge entrypoints
   from evading the same requirement. Settings changes require explicit human
   authority; neither this PR nor green CI grants that authority.
6. Record controlled validation under both ordinary author and maintainer roles.
   Begin on a non-production branch with matching effective protections and no
   deployment/release hooks; any actual merge attempts need separate explicit
   administrator authorization. Prove rejection for no reviews, bot-only
   approval, COMMENT-only escalation (#7521), requested-but-absent review,
   self/old-head/dismissed approval, lost collaborator/CODEOWNER authority,
   failed/skipped/missing human status, API failure, stale worker, fork,
   workflow-modifying PR, rebase and merge queue. Exercise concurrent push,
   dismissal and auto-merge; an obsolete success must not permit merge. A
   valid current-head authorized **non-author human** approval may satisfy only
   the human gate; unresolved blocking Ladon findings must remain blocking.
7. Verify the actual main branch's effective rules and producer identity after
   the controlled tests. Record settings exports, exact PR/head/status/reviewer
   evidence and permission-denied merge results, including denial of the
   #7521 author scenario. A sandbox-only test is not proof of main enforcement.
   Lift the hold only with a named human administrator's recorded acceptance.

No ruleset, branch setting, tag, merge, deployment or release mutation is part of
these Draft adoption PRs. Do not report branch protection fixed until the
consumer deployments and administrator enforcement/validation are complete.
