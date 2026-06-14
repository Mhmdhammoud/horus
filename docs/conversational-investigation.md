# Conversational Investigation Workflow (HOR-21)

## Model

An **investigation** is a persisted, immutable snapshot. When `horus investigate <hint>` runs, the
full `InvestigationReport` (evidence, hypotheses, suspected causes, timeline, gap analysis) is
stored in Postgres as a JSONB column. Nothing is re-derived from production connectors after that
point.

A **conversational session** is the original `investigate` call followed by one or more `ask`
refinements. Each `ask` call:

1. Reads the persisted report from Postgres.
2. Applies a deterministic topic filter to produce a `RefinedView` (no connector calls, no re-query
   of Axon, BullMQ, Git, or Elasticsearch).
3. Prints the filtered hypotheses, suspected causes, and evidence to stdout.

This means the full evidence base is captured once, and subsequent questions are instant, offline,
and reproducible.

## Deterministic v1 — Topic Focus/Ignore

The `horus ask <id> <directive>` command parses a free-text directive against a fixed `TOPIC_MAP`:

| Topic      | Matched categories         | Matched evidence kinds |
|------------|---------------------------|------------------------|
| queue      | queue-backlog              | queue-edge             |
| worker     | worker-slowdown            | queue-edge             |
| deployment | deployment-regression      | commit                 |
| api        | external-api-latency       | metric                 |
| retry      | retry-storm                | log                    |
| infra      | infrastructure             | redis-key              |

The directive's intent is classified as:

- **focus** — words like `focus`, `only`, `just`, `concentrate`, `look at`
- **ignore** — words like `ignore`, `exclude`, `without`, `skip`, `drop`
- **none** — unrecognized; all evidence is returned with a usage hint

Example session:

```
# Original investigation
horus investigate "order-processor latency spike" --since HEAD~10

# Follow-up refinements (instant, no re-query)
horus ask inv_01j... "focus on queue behavior"
horus ask inv_01j... "ignore deployment changes"
horus ask inv_01j... "focus on worker slowdown and retry storm"
horus ask inv_01j... --json "focus on api latency"
```

`symbol`-kind evidence is always kept in focus mode to preserve the seed context that seeded the
original investigation.

## HOR-15 — AI-Driven Follow-up (future)

HOR-15 will layer an LLM-driven Q&A conversation on top of the same persisted state. The model
will receive the `InvestigationReport` as context and support open-ended questions like "what
would you check next?" or "explain the blast radius of the queue backlog hypothesis". The
underlying evidence store and the `ask` topic filter remain the deterministic foundation; HOR-15
adds an LLM reasoning layer on top without touching production connectors.

## Out of Scope for HOR-21

- Chat/REPL UI (terminal or web).
- Automatic follow-up question generation.
- Mutations to the saved investigation or any production system.
- Streaming or incremental rendering.
- Multi-turn stateful sessions with memory across CLI invocations.

These concerns are tracked separately under HOR-15 (AI follow-up) and future UX work.
