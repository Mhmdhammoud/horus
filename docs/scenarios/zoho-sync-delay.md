# Incident replay scenario — "Zoho sync delays around 14:00" (HOR-17)

The first **product-level acceptance scenario** for Horus. It uses a realistic LeadCall
incident to check one thing: *can Horus explain a messy real event better than a human
manually opening Kibana, Grafana, Redis, BullMQ, and the codebase?*

Target repo: `meritt-dev/leadcall-api` (indexed by Axon, served on `:8420`).
Out of scope (per ticket): a perfect report, a benchmark suite, any UI.

---

## The incident

| | |
|---|---|
| **Human hint** | `"zoho sync delays"` |
| **Time window** | around 14:00 (Zoho CRM realtime sync reported lagging) |
| **Symptom** | CRM records updating late; suspicion of a queue backlog |
| **Systems a human would open** | Kibana (logs), Grafana (queue/worker metrics), BullMQ dashboard (queue depth/failed jobs), Redis (queue keys), `git log` (recent changes), the codebase (find the Zoho sync path) |

### What a human does manually (~20–40 min)
1. Grep Kibana for `zoho` errors in the window.
2. Open Grafana, eyeball worker latency / queue depth panels.
3. Open the BullMQ dashboard to see which queue is backed up.
4. `git log`/blame the Zoho modules to see what shipped recently.
5. Read the code to find **which worker consumes which queue** and **who enqueues** —
   the part that's never written down and takes the longest.

### What Horus should find (acceptance expectations)
- Resolve the hint to the **Zoho sync source** (`ZohoService` / `src/modules/zoho`).
- Surface the **async boundaries**: `zoho-sync-realtime` and `zoho-sync-batch`
  (producer → worker) — the thing Axon alone can't stitch.
- Generate **competing hypotheses**, with the queue-backed ones **supported**.
- Be **honest about gaps**: no logs/metrics/queue-state → **confidence capped**.
- Offer **evidence-backed next actions** pointed at the right queue/worker.
- Treat recent changes as **evidence, not conclusions**.

---

## What Horus produces

### `horus investigate "zoho sync delays"`

Resolves to **ZohoService** (community `Zoho+call-log`) and reconstructs the
`producer → queue → worker` boundary that Axon's static graph severs:

```
## Hypotheses
- supported  0.65 (was 0.35) — queue-backlog: producers enqueue faster than the worker drains
- supported  0.60 (was 0.30) — worker-slowdown: the worker(s) consuming the zoho-sync queues stall
- unconfirmed 0.20 — external-api-latency      (awaiting Prometheus/ES)
- unconfirmed 0.15 — deployment-regression     (re-run with --since)
- unconfirmed 0.15 — retry-storm               (awaiting logs/queue stats)
- unconfirmed 0.15 — infrastructure            (awaiting infra/Redis metrics)

## Evidence gaps (what we don't know)
- logs / metrics / queue runtime state / deployment records / ownership / traces  → each with a next data source
Confidence ceiling: 0.5 — capped until the gaps are filled.

## Next actions
- Check depth/failures of queue zoho-sync-realtime / zoho-sync-batch
- Inspect logs for worker ZohoRealtimeProcessor / ZohoBatchProcessor
- Diff recent commits touching src/modules/zoho/zoho.service.ts
```

It also **recalls similar past incidents** (institutional memory) and, because the
ES/Prometheus/BullMQ providers aren't wired yet, **caps its own confidence at 0.50** and
says exactly which data would raise it — rather than confidently guessing.

### Supporting commands
- `horus what-changed zoho --since "<window>"` → recent Zoho commits + change-impact
  (*"a change is evidence, not a conclusion"*) — e.g. `feat(integration): provider
  abstraction + concurrency-safe Zoho sync`.
- `horus blast-radius "ZohoRealtimeProcessor"` → the worker's **upstream producers**
  (CallLogService, ZohoService) across the `zoho-sync-realtime` boundary.
- `horus queues` → the literal producer→queue→worker map.
- `horus architecture` → the subsystem/async-boundary context.

---

## Manual vs Horus

| Step | Human | Horus |
|---|---|---|
| Find the Zoho sync code | grep + read modules | `investigate` resolves `ZohoService` instantly |
| **Which worker drains which queue** | read decorators across files | **stitched** `zoho-sync-*` producer→worker map |
| Form hypotheses | from memory, prone to anchoring | 6 competing, **ranked + validated** |
| Recent changes | `git log` by hand | `what-changed zoho` |
| Know what you're missing | easy to overlook | **explicit gaps + capped confidence** |
| Time | ~20–40 min across 5 tools | seconds, one command |

**Verdict:** even with **zero runtime telemetry wired**, Horus reconstructs the async
processing path, ranks the likely causes, and — critically — is transparent that it
*cannot yet confirm the backlog* without queue/worker metrics. That honesty (a capped
0.50 confidence with a precise shopping list of missing data) is the difference between a
useful investigator and a confident-but-wrong one.

---

## Acceptance test

`scripts/acceptance/zoho-sync-delay.sh` runs the scenario against the live Axon host +
Postgres and asserts Horus surfaces the expected structure (the zoho-sync queue
boundary, the queue-backlog hypothesis, and the evidence-gaps/confidence-cap). It exits
non-zero if any expectation regresses — the first product-level acceptance gate.

```bash
# prerequisites: axon host --port 8420 (in leadcall-api) + docker compose up -d
pnpm build && ./scripts/acceptance/zoho-sync-delay.sh
```
