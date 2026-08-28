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
  --fixture path/to/fixture.json \
  --adapter './path/to/provider-adapter' \
  --provider provider-name \
  --models exact-model-a,exact-model-b \
  --repetitions 5 \
  --out .context/model-comparison.json
```

Adapters must run in an isolated checkout, expose only read tools plus the two
in-memory Ladon persistence tools, and must not receive a GitHub write token.
This makes replay safe: no inline comments, reviews, labels, or other PR state
are changed during an eval.

For promotion decisions, use the same immutable fixtures and agent/tool
configuration for every model. Run at least five trials for a smoke comparison
and twenty per model for a promotion decision. Treat these as hard gates:

- zero false approvals;
- 100% bounded-retry and tool-protocol compliance;
- 100% completion on the infrastructure regression set; and
- no regression in required-finding recall on the issue-detection set.

Then compare completion rate, recall, unexpected findings, tool errors, retry
rate, latency, turns, and cost. Keep model IDs and adapter versions in the saved
artifact so results remain attributable and reproducible.
