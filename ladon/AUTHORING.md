# Authoring a `LADON.md` for a repo

This guide is the reference for creating a `LADON.md` file in any repo that uses
the Ladon review actions. The audience is engineers and AI agents seeding a new
repo into the Ladon review flow.

**Treat this document as the spec for what the setup action parses.** If
something here disagrees with the parser at `ladon/setup/src/ladon-md.ts`, the
parser wins and this doc has a bug: flag it in a PR.

---

## What LADON.md is

A pure-Markdown configuration file at the repo root that:

1. **Tunes the review flow for this repo specifically** (high-risk paths,
   escalation reviewers, trivial paths, and so on). The setup action parses the
   H2 sections listed below into typed config.
2. **Carries repo-specific narrative rules.** The entire `## Repo Context`
   section is injected verbatim into the reviewer's system prompt under a
   `# Repo-specific context` header. This is where repo-specific mandatory
   coverage rules, internal jargon, or product-area concerns live.

The action enforces one hard rule: **LADON.md can only EXTEND the baseline
rules, never replace them.** The baseline rules at `ladon/reviewer/rules/*.md`
always apply. LADON.md sits on top.

---

## File location

```
<repo-root>/LADON.md
```

The setup action reads from `$GITHUB_WORKSPACE/LADON.md`. If the file is
missing, the action logs a warning and falls back to the defaults baked into the
orchestrator. The review still runs; it just won't have repo-specific context.

---

## Quickstart: minimum viable LADON.md

```markdown
# Ladon configuration

## Repo Context

One paragraph describing what this repo does, its stack, and any conventions a
reviewer should weigh.

## Escalation Reviewers

- some-username
```

That's the floor. Every section beyond these is optional and falls back to the
action-input default (or empty).

---

## Section reference

The parser recognizes the following H2 headings (case-insensitive match on the
heading text). Unknown sections are ignored: they don't fail the parse, they're
just skipped.

| Section                     | Parsed shape                                       | What it does                                                                                                                                                              |
| --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## Repo Context`           | string (free-form Markdown body)                   | Injected verbatim into the reviewer's system prompt. Carries narrative context and mandatory-coverage rules the reviewer should weigh.                                    |
| `## High-Risk Paths`        | string[] (bullet list of globs)                    | Setup flags `high_risk=true` when any changed file matches a glob. The arbiter uses this signal alongside change-kind (added/modified/deleted) to decide whether to escalate. |
| `## Gated Paths`            | string[] (bullet list of globs)                    | Setup flags `gated-paths=true` when any changed file matches a glob: a deterministic, path-based hard block. The arbiter cannot approve until GitHub's `review_decision` for the PR is `APPROVED`. |
| `## Escalation Reviewers`   | string[] (GitHub user logins or `org/team-slug`)   | When the arbiter chooses `escalate`, it requests these reviewers via the GitHub API and applies the `ladon/needs-human-review` label. Mixed users + teams are supported.  |
| `## No-Auto-Approve Teams`  | string[] (`org/team-slug`)                          | If the PR author is a member of any of these teams, the arbiter cannot auto-approve. Enforced both as a prompt rule and a code-level backstop. Membership check fails safe. |
| `## Release Stack Branches` | string[] (branch names)                            | If the PR's HEAD branch is in this list, setup skips the review entirely with reason `release-stack-branch`.                                                              |
| `## Trivial Paths`          | string[] (globs)                                   | Files matching these globs are stripped from the constrained delta on `synchronize` events. A push that touches only trivial paths produces an `empty-delta` skip.        |
| `## Skip Bot Authors`       | string[] (GitHub bot logins, e.g. `dependabot[bot]`) | If the PR author matches one of these logins, setup skips with reason `bot-author`.                                                                                       |

### Format rules for bullet lists

- Bullets must start with `-`. (`*` and numbered lists are NOT parsed.)
- Wrapping a bullet in backticks is allowed: `` - `**/version.yml` `` parses as
  `**/version.yml`. The backticks are stripped.
- Empty bullets and lines without `-` are ignored.
- Order is preserved for sections where order matters (globs are matched
  first-to-last).

### Resolution order

For every parsed field, the orchestrator resolves the effective value as:

```
LADON.md -> orchestrator action input (if set) -> baked-in default
```

A consuming workflow can override any LADON.md section by setting the matching
`with:` input on the orchestrator step. LADON.md is the repo's expressed intent;
action inputs are the workflow's override.

---

## `## Repo Context`: how to write narrative rules

Everything between the `## Repo Context` heading and the next H2 ends up in the
reviewer's system prompt as "Repo-specific context."

### What belongs here

- **Repo overview.** One short paragraph: what the repo is, its stack, its
  deployment target, the conventions the reviewer should weigh.
- **Repo-specific mandatory-coverage rules.** Any review check meaningful only
  in this repo (framework audits, product-surface audits, references to specific
  historical regressions on this repo).
- **Repo-specific definitions.** Internal product names, team conventions,
  naming patterns an outsider would need decoded.
- **High-impact areas the baseline rules can't know about.**

Use H3 (`###`) sub-headings to structure long Repo Context sections.

### What does NOT belong here

- **General review philosophy.** Voice, severity definitions, inline-comment
  format all live in the baseline rule files. Don't duplicate. If something is
  true for every repo, propose a change to `ladon/reviewer/rules/*.md` instead.
- **`## High-Risk Paths` / `## Gated Paths` content phrased as prose.** Use the
  structured sections for globs.

### Voicing inside `## Repo Context`

The baseline `voice.md` sets a declarative, technical, quantified voice. The
content of `## Repo Context` becomes part of the system prompt, so it must be
written in the same voice.

Good:

> Whenever the diff modifies a `useEffect` dep array, enumerate every entry.
> Flag any derived value computed from state mutated inside the same effect:
> that's a re-entry loop and almost always a bug.

Bad:

> When reviewing changes to hooks, it might be useful to take a closer look at
> the dependency arrays to see if there's anything that could cause issues.

---

## `## High-Risk Paths`: what to include

A high-risk path is a file or directory where a quietly-broken change is
expensive to detect after merge. Adding NEW files matching a high-risk glob does
NOT automatically escalate; modifications + findings do, and deletions always
do.

Good candidates:

- Public-API contracts: `**/action.yml`, schemas, OpenAPI/GraphQL specs,
  exported package surfaces.
- Production infrastructure and sensitive code: auth, billing, audit logging,
  multi-tenant isolation boundaries.
- Schemas + migrations.

Bad candidates (noise, not signal): generated code, frequently-changing build
configs caught by CI, test fixtures, docs.

---

## `## Gated Paths`: what to include

A gated path is a file or directory where Ladon must never auto-approve, full
stop, until a human with the required sign-off authority approves. This is a
hard block, not a heuristic: the arbiter is code-level prevented from returning
`approve` while any changed file matches a `## Gated Paths` glob, until GitHub's
`review_decision` for the PR reports `APPROVED`.

**This only works if the path is also covered by real GitHub branch protection
+ CODEOWNERS.** `review_decision` is GitHub's own computed signal; if a gated
path has no matching CODEOWNERS entry and no branch-protection required-review
rule, GitHub will never report `APPROVED` and the gate becomes permanently
un-liftable. Pair every `## Gated Paths` entry with a `.github/CODEOWNERS` rule
for the same path.

---

## `## Escalation Reviewers`: users, teams, or both

The arbiter requests these reviewers when it escalates a PR. Entries can be:

- **GitHub usernames** (no slash). The arbiter calls the GitHub API with
  `reviewers: [...]`.
- **Team slugs** in `org/slug` form. The arbiter strips the org prefix and calls
  with `team_reviewers: [...]`. The team must exist in the same org as the repo.

You can mix users and teams in one list. Empty lists are no-ops.

---

## `## Trivial Paths`: what to include

Trivial paths are stripped from the constrained delta on `synchronize` events. A
push that touches only trivial paths produces an `empty-delta` skip.

Always include: lockfiles, generated code, bundled artifacts (if committed),
snapshot files, docs that don't affect behavior.

Don't include: source files (ever), config files that change behavior, or test
files.

The constrained delta only fires on `synchronize`, so the FIRST review of a PR
(`opened`) sees everything regardless of trivial paths.

---

## `## Skip Bot Authors`: when to add

Add an entry when a bot author produces noisy or no-op diffs, or when a bot's
PRs would always result in `approve` anyway (better to skip cleanly than burn
API calls). Don't add an entry if you want Ladon to review that bot's PRs.

---

## Verifying your config

1. **Open a PR with the `LADON.md` change.** The PR's own Ladon run parses and
   uses the file.
2. **Read the orchestrator's job summary.** On a skip, the `Skip notice` step
   prints `skip-reason=...`.
3. **Check the reviewer's prompt.** Your `## Repo Context` content should appear
   under a `# Repo-specific context` header. If it's missing, the parser didn't
   recognize the section heading (check capitalization and spelling).
4. **Iterate.** Watch the first several reviews, then adjust LADON.md to flag
   what was missed and drop what was noise.

---

## Adding a new section type

If a new structured section would be broadly useful (not just to one repo), the
change lives in two places:

- `ladon/setup/src/ladon-md.ts`: add the H2 heading to `SECTION_TO_KEY` and add
  a field to `LadonConfig`.
- `ladon/setup/src/resolve-config.ts`: add the field to the resolved config and
  the resolution chain.

Open a PR with the change. Repo-specific narrative content does NOT require a
code change: it goes under `## Repo Context`.
