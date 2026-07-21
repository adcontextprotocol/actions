# adcp-actions

Reusable GitHub Actions for the Ad Context Protocol. npm-workspaces + Turborepo
monorepo. Each action is a workspace under a top-level directory (currently
`ladon/`).

## Conventions

- **Node actions ship a committed `dist/`.** `dist/index.js` is an `ncc` bundle
  that GitHub Actions runs directly. It MUST stay in sync with `src/`. The
  pre-commit hook (`npm run pre-commit`) rebuilds and re-stages it when action
  source is staged. Never hand-edit `dist/`; change `src/` and rebuild.
- **Build/test/type-check run through Turborepo** (`npm run build|test|type-check`).
- **Lint/format via Biome** (single quotes, no semicolons, 2-space, 80 cols).
  YAML and Markdown are formatted with Prettier.
- **Tests are Vitest** (`*.test.ts` next to source).

## Ladon

`ladon/` is the PR reviewer: `setup` -> `reviewer` -> `arbiter`, orchestrated by
`review`. Ladon is the review desk of the AAO Secretariat and posts under the
AAO Secretariat bot identity. Per-repo tuning lives in each consuming repo's
`LADON.md`; the baseline rules in `ladon/reviewer/rules/*.md` always apply and
`LADON.md` can only extend them. See `ladon/AUTHORING.md`.

## Working safely

- Never `git add .` / `git add -u` / `git commit -a`. Stage explicit files only.
- The App secrets `SECRETARIAT_APP_ID` / `SECRETARIAT_APP_PRIVATE_KEY` are the
  AAO Secretariat bot identity Ladon posts as; they are not renamed.
