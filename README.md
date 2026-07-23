# adcp-actions

Reusable GitHub Actions for the Ad Context Protocol, consumed across AdCP repos.

## Actions

| Path     | What it is                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `ladon/` | The AdCP PR reviewer: `setup` -> `reviewer` -> `arbiter`, orchestrated by `review`. See `ladon/README.md`. |

## Repository layout

This is an npm-workspaces + Turborepo monorepo. Each action is a workspace with
its own `package.json`. Node actions ship a committed `dist/index.js` (an `ncc`
bundle that GitHub Actions runs directly); the bundle is kept in sync with
source by a pre-commit hook and enforced in CI.

## Development

```bash
npm ci            # install all workspaces
npm run type-check
npm run test
npm run build     # ncc-bundle each node action into dist/
```

- **Build:** Turborepo (`turbo.json`) fans `build` / `test` / `type-check` out
  across workspaces.
- **Lint/format:** Biome (`biome.jsonc`), with Prettier for YAML/Markdown.
- **Tests:** Vitest.
- **Node:** version pinned in `.nvmrc`.
- **Hooks:** Husky installs a pre-commit hook (`prepare` script) that formats
  staged files and rebuilds any changed action's `dist/`.

## Versioning

Actions are tagged automatically on merge to `main` (the `merge-publish`
workflow runs `internal/versioning`). Each action declares its major version in
its `version.yml`; every merge that touches an action cuts the next patch tag
and repoints the floating `v<major>` tag.

**Known limitation:** changed actions are detected via the GitHub compare API,
which caps a single response at ~300 files. A merge changing more than 300 files
(a mass reformat or lockfile churn) may not re-version every affected action.
Recover by running the `manual-version-publish` workflow with `runForAll: true`.

## Consuming an action

Reference an action from a consuming repo's workflow by path and ref, e.g.:

```yaml
- uses: adcontextprotocol/actions/ladon/review@<ref>
```

See `ladon/INSTALL.md` for the full install guide (prerequisites, the workflow
template, and the security posture), and `ladon/AUTHORING.md` for how to
configure Ladon per repo via `LADON.md`.
