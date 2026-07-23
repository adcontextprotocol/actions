# Installing Ladon in a repo

How to wire the Ladon PR reviewer into a consuming AdCP repo. For tuning the
review _content_ per repo (high-risk paths, escalation reviewers, repo context),
see [`AUTHORING.md`](./AUTHORING.md): this doc is only about installing the
workflow.

Ladon runs as a GitHub Action; the consuming repo supplies the credentials and a
thin workflow that carries the security posture. Copy the workflow below, set the
prerequisites, add a `LADON.md`, and you're done.

## Prerequisites

Ladon posts reviews under the **AAO Secretariat** GitHub App, using Claude for the
review itself. Before the workflow can run:

1. **Install the AAO Secretariat App on the repo.** Reviews post under the App
   identity so they count toward a "1 review required" branch-protection rule.
   Ask an org admin if it isn't already installed.
2. **Add three repository secrets** (Settings → Secrets and variables → Actions):

   | Secret                        | What it is                           |
   | ----------------------------- | ------------------------------------ |
   | `SECRETARIAT_APP_ID`          | The AAO Secretariat App's ID         |
   | `SECRETARIAT_APP_PRIVATE_KEY` | The App's private key (PEM)          |
   | `ANTHROPIC_API_KEY`           | Anthropic API key Ladon reviews with |

3. **(Optional) Branch protection.** If `main` requires an approving review,
   Ladon's App-authored `approve` satisfies it; its `request-changes` blocks the
   merge until addressed.

## Step 1: add the workflow

Create `.github/workflows/ai-review.yml`. This is the canonical consumer
workflow: it pins the floating major tag `@ladon/review/v1` (auto-tracks the
latest v1), and it carries the security posture Ladon depends on. **Copy it
verbatim**: do not reconstruct it (see [Security posture](#security-posture)).

```yaml
name: AI PR Review (Ladon)

# Ladon reviews every non-draft, non-dependabot PR. The engine lives in
# adcontextprotocol/actions (ladon/), consumed here by floating major tag. This
# workflow handles the pull_request_target security posture (trusted base-SHA
# checkout only; the PR head is never fetched, checked out, or executed - setup
# reads head content via the GitHub API), the review-workflow-modification gate,
# and invoking the composite. Reviews post as the AAO Secretariat App.
#
# pull_request_target (not pull_request) is required on a public repo so that PRs
# from forks can access the App token and Anthropic key.

on:
  pull_request_target:
    types: [opened, labeled, ready_for_review, synchronize]
    paths-ignore:
      - ".github/workflows/ai-review.yml"
      - "LADON.md"

jobs:
  code_review:
    if: github.actor != 'dependabot[bot]' && github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      # Trusted base-SHA checkout. Never check out or execute PR-head code.
      # The PR head is never fetched: setup derives the diff/delta and changed
      # files entirely from the GitHub API.
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0

      - name: Mint App token (for the workflow-mod gate comment)
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.SECRETARIAT_APP_ID }}
          private-key: ${{ secrets.SECRETARIAT_APP_PRIVATE_KEY }}

      # Workflow-modification gate: if this PR touches the review system itself,
      # a human owns it. paths-ignore suppresses pure-review-file PRs; this
      # handles mixed PRs.
      - name: Check for review-workflow modifications
        id: workflow-mod
        shell: bash
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          CHANGED="$(gh api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/files" --jq '.[].filename')"
          MODIFIED=""
          while IFS= read -r f; do
            case "$f" in
              .github/workflows/ai-review.yml|LADON.md)
                MODIFIED="${MODIFIED}${f}"$'\n' ;;
            esac
          done <<< "$CHANGED"
          if [ -n "$MODIFIED" ]; then
            echo "modified=true" >> "$GITHUB_OUTPUT"
            echo "modified_files<<EOF" >> "$GITHUB_OUTPUT"
            echo "$MODIFIED" >> "$GITHUB_OUTPUT"
            echo "EOF" >> "$GITHUB_OUTPUT"
          else
            echo "modified=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Comment and skip when PR modifies review workflow
        if: steps.workflow-mod.outputs.modified == 'true'
        uses: actions/github-script@v7
        env:
          MODIFIED_FILES: ${{ steps.workflow-mod.outputs.modified_files }}
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          script: |
            const files = (process.env.MODIFIED_FILES || '').trim().split('\n').map(f => `\`${f}\``).join(', ');
            await github.rest.pulls.createReview({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number,
              event: 'COMMENT',
              body: `Ladon is **not auto-reviewing** this PR because it modifies the review system itself (${files}). A human reviewer should review and merge this PR; Ladon resumes on subsequent PRs once these changes land on \`main\`.`
            });

      - name: Run Ladon
        if: steps.workflow-mod.outputs.modified != 'true'
        uses: adcontextprotocol/actions/ladon/review@ladon/review/v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          app-id: ${{ secrets.SECRETARIAT_APP_ID }}
          app-private-key: ${{ secrets.SECRETARIAT_APP_PRIVATE_KEY }}
          # Optional; defaults to the review action's pinned model.
          model: claude-opus-4-8
```

## Step 2: add `LADON.md`

Create a `LADON.md` at the repo root for per-repo tuning. The bundled rules
(`ladon/reviewer/rules/*.md`) are the baseline every repo inherits; `LADON.md`
extends them, it never replaces them. Minimum viable:

```markdown
# Ladon configuration

## Repo Context

<One paragraph on what this repo is and what reviews should weigh heavily.>

## High-Risk Paths

- src/critical/**

## Escalation Reviewers

- your-github-handle
```

See [`AUTHORING.md`](./AUTHORING.md) for the full section reference and format rules.

## Security posture

The workflow uses `pull_request_target` (not `pull_request`) so that PRs from
forks can access the App token and Anthropic key. That trigger is only safe
because the workflow **never executes PR-head code**:

- It checks out the **base SHA** (`github.event.pull_request.base.sha`), not the
  PR head.
- The PR head is never fetched or checked out; `setup` reads head content via the
  GitHub API.
- All `github.event.*` values reach shells through `env:`, never inline
  interpolation.

If you adapt this workflow, preserve those three properties. Checking out or
running the PR head under `pull_request_target` would expose the App key and
Anthropic key to fork-authored code, the most common GitHub Actions
vulnerability. When in doubt, copy the template unchanged.

## Notes

- **Self-modifying PRs.** The workflow-mod gate makes Ladon decline to
  auto-review any PR that touches `.github/workflows/ai-review.yml` or `LADON.md`
  (it posts a notice instead). A human owns those PRs. Because
  `pull_request_target` runs from the base SHA, changes to the review setup only
  take effect **after** they land on `main`.
- **Versioning.** `@ladon/review/v1` is a floating major tag; you automatically
  pick up the latest `v1.x.x` on each run (no pin bumps). Only a major bump
  (`v1` → `v2`) is a deliberate opt-in change to this line.
