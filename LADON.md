# Ladon configuration

## Repo Context

`adcontextprotocol/actions` is a TypeScript monorepo of reusable GitHub Actions
for the Ad Context Protocol (npm workspaces + Turborepo, Biome, Vitest). Each
action is a workspace; the node actions (`ladon/setup`, `ladon/arbiter`) ship a
committed `dist/index.js` that GitHub Actions runs directly. Reviews weigh the
action input/output contract, the committed-bundle invariant, and the
`pull_request_target` security posture above style.

### Mandatory: dist stays in sync with source

`dist/index.js` is a generated `ncc` bundle, not hand-written. Any PR that
changes `ladon/setup/src/**` or `ladon/arbiter/src/**` (or their build config)
without a matching rebuild of that action's `dist/` ships stale runtime code.
Treat a source change with no corresponding `dist/` change as a `high` finding.
`dist/` must never be hand-edited.

### Mandatory: action contract changes

`action.yml` is the public surface consumers pin to. Renaming or removing an
`inputs`/`outputs` key, or changing a default, breaks consuming workflows
silently. Treat any such change without a note in the PR body as a `high`
finding.

### Mandatory: review-system security posture

`ladon/review` runs under `pull_request_target`. The PR head is never checked
out or executed; setup reads head content via the GitHub API. Any change that
would fetch, check out, or execute PR-head code, or that widens the token
permissions, is a `critical` finding.

## High-Risk Paths

- `ladon/setup/src/**`
- `ladon/arbiter/src/**`
- `ladon/reviewer/rules/**`
- `**/action.yml`
- `.github/workflows/**`

## Escalation Reviewers

<!-- Add repo maintainer GitHub logins (or org/team-slug) here, one per bullet. -->

## Trivial Paths

- `package-lock.json`
- `**/dist/**`
- `**/*.md`

## Skip Bot Authors

- `dependabot[bot]`
- `renovate[bot]`
- `github-actions[bot]`
