#!/usr/bin/env node
// Read-only release prerequisite. Uses live, exact default-branch snapshots,
// not code search alone (the search index can lag). Never changes GitHub state.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { promisify } = require("node:util");
const { parse } = require("yaml");
const exec = promisify(execFile);
const policy = JSON.parse(
  readFileSync(
    require("node:path").join(__dirname, "../ladon/consumer-policy.json"),
    "utf8",
  ),
);

function invocations(value, path = "", sites = []) {
  if (!value || typeof value !== "object") return sites;
  if (typeof value.uses === "string" && /ladon/i.test(value.uses)) {
    sites.push({
      path,
      uses: value.uses,
      autoApprove: value.with?.["auto-approve"],
    });
  }
  for (const [key, child] of Object.entries(value))
    invocations(child, `${path}.${key}`, sites);
  return sites;
}

function validateInventory(report, expected = policy) {
  const errors = [];
  if (report.complete !== true)
    errors.push("Incomplete organization inventory");
  if (report.search?.incomplete_results !== false)
    errors.push("Incomplete code search");
  if (report.search?.total_count !== report.search?.items?.length)
    errors.push("Truncated code search");
  const observed = new Map();
  for (const repo of report.repositories || []) {
    if (observed.has(repo.name))
      errors.push(`Duplicate repository: ${repo.name}`);
    observed.set(repo.name, repo);
    if (!/^[a-f0-9]{40}$/.test(repo.head || ""))
      errors.push(`Missing exact head: ${repo.name}`);
    const sites = (repo.workflows || []).flatMap((file) =>
      invocations(parse(file.content), file.path),
    );
    if (sites.length && !expected.repositories.includes(repo.name))
      errors.push(`Uninventoried Ladon consumer: ${repo.name}`);
    if (expected.repositories.includes(repo.name) && sites.length !== 1)
      errors.push(
        `${repo.name}: expected one reviewed invocation, found ${sites.length}`,
      );
    for (const site of sites) {
      if (
        site.uses !==
        `adcontextprotocol/actions/ladon/review@${expected.review}`
      )
        errors.push(`${repo.name}:${site.path}: missing/wrong immutable pin`);
      if (site.autoApprove !== "false")
        errors.push(
          `${repo.name}:${site.path}: auto-approve must be literal 'false'`,
        );
    }
  }
  for (const name of expected.repositories)
    if (!observed.has(name))
      errors.push(`Missing consumer repository: ${name}`);
  for (const item of report.search?.items || []) {
    const repo = observed.get(item.repository.full_name);
    if (!repo?.workflows.some((file) => file.path === item.path))
      errors.push(
        `Unreconciled code-search result: ${item.repository.full_name}:${item.path}`,
      );
  }
  return errors;
}

async function api(path, optional404 = false) {
  try {
    const { stdout } = await exec("gh", ["api", "--method", "GET", path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (optional404 && /HTTP 404/.test(error.stderr || "")) return null;
    throw error;
  }
}

async function pages(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert.ok(Array.isArray(result), "Expected a complete paginated API list");
    items.push(...result);
    if (result.length < 100) return items;
  }
}

async function mapLimited(items, fn) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await fn(items[index]);
      }
    }),
  );
  return result;
}

function checkedWorkflowFiles(files, repository) {
  assert.ok(
    files === null || Array.isArray(files),
    `Invalid workflows directory: ${repository}`,
  );
  // Contents API caps directory responses at 1,000 entries. Search can lag,
  // so accepting this boundary could hide a newly added sixth consumer.
  assert.ok(
    files === null || files.length < 1000,
    `Possibly truncated workflows directory: ${repository}`,
  );
  return (files || []).filter((file) => /\.ya?ml$/.test(file.path));
}

async function audit(actionsHead) {
  if (actionsHead !== undefined)
    assert.match(
      actionsHead,
      /^[a-f0-9]{40}$/,
      "Candidate must be an exact actions commit",
    );
  const query = encodeURIComponent(
    'org:adcontextprotocol "ladon" path:.github/workflows',
  );
  const search = await api(`search/code?q=${query}&per_page=100`);
  assert.equal(search.incomplete_results, false, "Code search is incomplete");
  assert.ok(
    search.total_count <= 100,
    "Code search exceeds the audited pagination bound; expand audit explicitly",
  );
  assert.equal(
    search.items.length,
    search.total_count,
    "Code search is truncated",
  );
  const repositories = await pages("orgs/adcontextprotocol/repos?type=all");
  const snapshots = await mapLimited(
    repositories.filter((repo) => !repo.archived && !repo.disabled),
    async (repo) => {
      const commit = await api(
        `repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`,
      );
      const snapshot =
        actionsHead && repo.full_name === "adcontextprotocol/actions"
          ? await api(`repos/${repo.full_name}/commits/${actionsHead}`)
          : commit;
      const files = await api(
        `repos/${repo.full_name}/contents/.github/workflows?ref=${snapshot.sha}`,
        true,
      );
      const workflows = await mapLimited(
        checkedWorkflowFiles(files, repo.full_name),
        async (file) => {
          assert.equal(file.type, "file", `Non-file workflow: ${file.path}`);
          const blob = await api(
            `repos/${repo.full_name}/git/blobs/${file.sha}`,
          );
          assert.equal(blob.encoding, "base64");
          const bytes = Buffer.from(blob.content, "base64");
          const hash = createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
          assert.equal(
            hash,
            file.sha,
            "Workflow bytes do not match exact Git blob",
          );
          return {
            path: file.path,
            blob: file.sha,
            content: bytes.toString("utf8"),
          };
        },
      );
      return {
        name: repo.full_name,
        head: snapshot.sha,
        liveHead: commit.sha,
        tree: snapshot.commit.tree.sha,
        workflows,
      };
    },
  );
  // Reject head movement during enumeration; never certify a mixed snapshot.
  for (const repo of snapshots) {
    const branch = repositories.find(
      (item) => item.full_name === repo.name,
    ).default_branch;
    const current = await api(
      `repos/${repo.name}/commits/${encodeURIComponent(branch)}`,
    );
    assert.equal(
      current.sha,
      repo.liveHead,
      `Main moved during audit: ${repo.name}`,
    );
  }
  const report = {
    at: new Date().toISOString(),
    scope: actionsHead
      ? "pre-publication actions candidate; NOT live enforcement"
      : "live default branches",
    actionsCandidate: actionsHead,
    complete: true,
    search,
    repositories: snapshots,
  };
  report.errors = validateInventory(report);
  return report;
}

module.exports = {
  invocations,
  validateInventory,
  checkedWorkflowFiles,
  audit,
};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--actions-head"))
    throw new Error(
      "Usage: audit-ladon-consumers.cjs [--actions-head EXACT_SHA]",
    );
  audit(args[1])
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.errors.length) {
        console.error(
          `HOLD: ${report.errors.length} unsafe or unreviewed Ladon inventory entries`,
        );
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`HOLD: inventory could not be verified: ${error.message}`);
      process.exitCode = 1;
    });
}
