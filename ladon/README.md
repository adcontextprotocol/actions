# Ladon

AdCP's PR reviewer, as a set of GitHub Actions: `setup` -> `reviewer` ->
`arbiter`, orchestrated by `review`. The reviewer emits schema-validated
findings; the arbiter decides an outcome (`approve` / `request-changes` /
`comment` / `escalate`) via a constrained tool call and posts a single review.

## Actions

| Action     | Role                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `setup`    | Parses `LADON.md`, computes the diff/delta and changed files (via the GitHub API), evaluates short-circuit skip conditions, and resolves per-repo config. |
| `reviewer` | Runs the review against the bundled rules (`reviewer/rules/*.md`) plus the repo's `LADON.md` context and emits schema-validated findings. |
| `arbiter`  | Turns findings into a single decision (`approve` / `request-changes` / `comment` / `escalate`) and posts the review. |
| `review`   | Composite orchestrator that runs `setup` -> `reviewer` -> `arbiter`.                                      |

## Identity

Ladon is the review desk of the AAO Secretariat, the staff function serving the
AdCP Working Group. Ladon does the reviewing; it posts under the AAO Secretariat
bot identity (the App whose credentials the consuming workflow supplies). See
`reviewer/rules/voice.md`.

## Per-repo configuration

Repo-specific tuning lives in a `LADON.md` file at each consuming repo's root
(high-risk paths, escalation reviewers, trivial paths, and a free-form repo
context injected into the reviewer's prompt). The bundled `reviewer/rules/*.md`
are the baseline every repo inherits; `LADON.md` can only extend them, never
replace them. See `AUTHORING.md` for the full format.

## Layout

The action tree lives under `ladon/`. Consuming repos invoke the orchestrator
and supply the App credentials and Anthropic key as inputs; see the repo root
`.github/workflows/ai-review.yml` for a worked example of the
`pull_request_target` security posture.
