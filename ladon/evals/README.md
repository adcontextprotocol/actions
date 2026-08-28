# Ladon evals

This package replays Ladon's persisted tool calls through the same state
transition functions used by the production reviewer. It answers three
separate questions:

1. Did reviewer infrastructure complete and finalize correctly?
2. Did the review find the issues expected by the fixture?
3. Did the end-to-end result remain fail-closed?

The distinction matters: missing output is an infrastructure failure, not a
clean review and not a code rejection.

## What is covered

The committed regression suite verifies that:

- findings survive model final-text or structured-output exhaustion;
- a missing or explicitly incomplete finalization cannot reach approval;
- only one compact, finalization-only retry is allowed;
- findings cannot be added during that retry;
- invalid tool calls are measured and do not mutate persisted state;
- repeated runs can be grouped by provider and exact model ID; and
- the historical PR 6883 exhaustion is classified as infrastructure failure.
- adcp-client PR 2721's `error_max_structured_output_retries` incident is
  retained with its turn, duration, cost, and permission-denial telemetry.

That historical trace fails its completion gate. The paired
`pr-6883-fixed-finalization-recovery.json` trace exercises the new one-retry
path and passes, without turning absent output into approval.

Run the deterministic suite with:

```sh
npm --workspace @adcp/ladon-evals test
```

## Fixture and trace contract

A fixture identifies immutable review material and its expected behavior. Use
base and head SHAs rather than a moving branch. `required_findings` match on
file and optionally severity and a case-insensitive title substring.

```json
{
  "schema_version": 1,
  "id": "stable-case-id",
  "description": "What this case is intended to detect",
  "source": {
    "repository": "owner/repository",
    "pr_number": 123,
    "base_sha": "...",
    "head_sha": "..."
  },
  "expected": {
    "required_findings": [
      {
        "file": "src/example.ts",
        "severity": "high",
        "title_includes": "authorization"
      }
    ],
    "forbidden_outcomes": ["approve"],
    "allow_additional_findings": true,
    "require_completion": true,
    "max_tool_errors": 0
  }
}
```

An adapter emits a normalized trace. A trace contains the actual ordered tool
calls, not a reconstructed final answer. The optional second attempt must be
`finalization` and may call only `finalize_review`.

```json
{
  "schema_version": 1,
  "fixture_id": "stable-case-id",
  "provider": "provider-name",
  "model": "exact-model-id",
  "attempts": [
    {
      "kind": "review",
      "result": {
        "subtype": "success",
        "num_turns": 20,
        "duration_ms": 12345,
        "total_cost_usd": 1.23
      },
      "tool_calls": [
        { "name": "record_finding", "arguments": {} },
        { "name": "finalize_review", "arguments": {} }
      ]
    }
  ],
  "outcome": "request-changes"
}
```

Grade one or more saved traces without making model calls:

```sh
node ladon/evals/src/cli.mjs grade \
  --fixture ladon/evals/fixtures/pr-6883-structured-output-exhaustion.json \
  --traces trace-a.json,trace-b.json \
  --out .context/ladon-eval-report.json
```

## Cross-model runs

The `run` command is provider-neutral. `--adapter` is an executable command
that reads one JSON request from stdin and writes one normalized trace to
stdout. The request contains `fixture`, `provider`, `model`, and `trial`.
Provider credentials and model-specific agent loops stay in the adapter rather
than in the evaluator.

```sh
node ladon/evals/src/cli.mjs run \
  --fixtures fixture-a.json,fixture-b.json \
  --adapter './path/to/provider-adapter' \
  --provider provider-name \
  --models exact-model-a,exact-model-b \
  --repetitions 5 \
  --concurrency 4 \
  --timeout-ms 900000 \
  --out .context/model-comparison.json
```

Concurrency is global to that invocation and defaults to one. Keep it bounded
to the provider's rate and spend limits. Reports remain in deterministic
fixture/model/trial order even when trials finish out of order. The output file
is replaced atomically after every completed trial, with `status`, `completed`,
and `total` fields, so a terminated batch retains its completed work.

An adapter timeout, non-zero exit, invalid JSON response, or invalid trace is
recorded as a failed, fail-closed trial with a `runner_error`; it does not abort
the rest of the matrix. Adapter stderr is whitespace-normalized and truncated
before it enters the report. Do not print credentials or review content to
stderr.

Run one invocation per provider adapter in parallel CI jobs, then combine their
artifacts without re-running a model:

```sh
node ladon/evals/src/cli.mjs merge \
  --reports anthropic-report.json,google-report.json,openai-report.json \
  --out .context/model-comparison.json
```

Adapters must run in an isolated checkout, expose only read tools plus the two
in-memory Ladon persistence tools, and must not receive a GitHub write token.
This makes replay safe: no inline comments, reviews, labels, or other PR state
are changed during an eval.

The committed incident fixtures are currently deterministic replay cases, not
self-contained live-model inputs. They identify immutable base/head SHAs and
expected behavior, but they do not bundle the historical prompt, rules, diff,
and repository snapshot. Do not describe a replay-only result as a model
comparison.

A live provider adapter must:

1. Materialize the exact fixture base/head into an isolated checkout.
2. Render one fixed Ladon prompt and rule set for every candidate model.
3. Expose read-only repository tools and the `record_finding` and
   `finalize_review` MCP tools, with no GitHub write credential.
4. Capture the ordered MCP calls directly rather than reconstructing them from
   final assistant text.
5. Perform no more than one finalization-only retry against the same persisted
   state.
6. Emit the normalized trace contract above, including exact provider/model ID
   and available duration, turn, permission-denial, and cost telemetry.

For CI, use a manually dispatched workflow with `permissions: contents: read`,
one job per provider adapter, `strategy.fail-fast: false`, and a conservative
`max-parallel`. Put provider credentials in a protected eval environment. Each
provider job uploads its checkpointed report even on failure; a final job
downloads and merges the reports. Live evals should never run on every pull
request or receive Ladon's production GitHub App token.

For promotion decisions, use the same immutable fixtures and agent/tool
configuration for every model. Run at least five trials for a smoke comparison
and twenty per model for a promotion decision. Treat these as hard gates:

- zero false approvals;
- 100% bounded-retry and tool-protocol compliance;
- 100% completion on the infrastructure regression set; and
- no regression in required-finding recall on the issue-detection set.

Then compare completion rate, recall, unexpected findings, tool errors, retry
rate, runner-error rate, latency, turns, permission denials, and cost. Missing
telemetry remains `null` rather than being counted as zero. Keep model IDs and
adapter versions in the saved artifact so results remain attributable and
reproducible.

## Architecture boundary

This package, its immutable fixtures, and its normalized reports are the eval
system of record. Model providers execute trials through narrow adapters; they
do not own fixture storage, orchestration, grading, comparison, or promotion
decisions.

Do not export Ladon evals to a hosted eval platform. The reviewer depends on an
agentic, multi-turn MCP tool loop, and a text-completion approximation does not
test the behavior that matters. Keeping orchestration and deterministic grading
here also prevents a provider-specific API lifecycle from becoming part of the
reliability or merge path.
