# Horus Privacy & Telemetry

_Last updated: 2026-06-22 · Owner: HOR-322 (Usage Intelligence)_

> This is the canonical description of what Horus collects, why, and how to turn
> it off. It backs the first-run notice in the CLI and the disclosure in
> `install.sh`. The hosted copy lives at <https://horus.sh/privacy>.

Horus collects usage data **to make the tool better** — to find where the
investigation engine runs out of evidence, which commands break, and how much
real debugging time it saves. Collection is **consent-gated and tiered**, off by
default for anything sensitive, and can be fully disabled with one command or an
environment variable.

## The two tiers

| | **Tier A — Usage metadata** | **Tier B — Content** |
| --- | --- | --- |
| **Default** | **On** (after the first-run notice) | **Off** — explicit opt-in only |
| **What** | Command name, flag *names* (never their values), durations, exit code, result confidence, evidence counts, "engine ran out of evidence" / degraded markers, sanitized error class, OS, CLI version, and a random install ID | The **redacted** text of your investigation inputs and outputs (hint, summary, findings, suspected causes, hypotheses, timeline) |
| **Why** | Reliability and "where does the engine fail" signal | Engine-quality improvement and a future training set |
| **Leaves your machine?** | No free text. Flag *values*, file contents, queries, and secrets never leave. | Only after passing secret/PII redaction (see below) |

To contribute Tier B content: `horus telemetry enable-content`.

## What we never collect

- Flag/argument **values** (e.g. service names, hostnames, search queries).
- File contents, log lines, query results, or database rows.
- Secrets, tokens, passwords, connection strings, or credentials.
- Any machine fingerprint. The install ID is a random UUID, not derived from your
  hardware, and you can reset it any time.

## Identity

A single random `installId` (UUID v4) is stored in `~/.horus/telemetry.json`. It
lets us deduplicate usage without identifying a person. Reset it with
`horus telemetry reset-id`; delete it (and all local telemetry state) with
`horus telemetry delete`.

## Redaction (Tier B)

Before any input/output content is sent, it is scrubbed for secrets and PII
(auth tokens, passwords, API keys, connection strings, JWTs, emails, IPs, card
numbers, …). Redaction is **fail-closed**: if scrubbing cannot complete, or a
high-risk pattern survives, the content is dropped and only Tier-A metadata
remains. _(Hardened redaction ships in Phase 2 — HOR-325. Until then, Tier B is
not enabled.)_

## Horus Cloud is separate

If you run `horus login` and `horus cloud link`, your investigations sync to
**your own** Horus Cloud workspace as a product feature. That is governed by your
account terms, not by this telemetry setting, and disabling telemetry does not
disable cloud sync.

## How to opt out

| Goal | How |
| --- | --- |
| See current status | `horus telemetry status` |
| Turn off all telemetry | `horus telemetry disable` |
| Turn off content sharing only | `horus telemetry disable-content` |
| Disable via environment | `HORUS_TELEMETRY=0` |
| Disable via the cross-tool standard | `DO_NOT_TRACK=1` |
| New install ID | `horus telemetry reset-id` |
| Delete local telemetry state | `horus telemetry delete` |

CI and other automated environments are detected and collect **nothing** by
default.

## Retention (planned)

- Tier B content: retained ~90 days, then aggregated and purged.
- Tier A metadata: retained ~13 months.
- `horus telemetry delete` will propagate a server-side deletion once the cloud
  sink lands (HOR-324 / HOR-327).

## Where this is implemented

- Consent + identity: `packages/cli/src/lib/telemetry/` (`store.ts`, `consent.ts`,
  `notice.ts`).
- Control surface: `horus telemetry` (`packages/cli/src/commands/telemetry.ts`).
- Tracking epic: **HOR-322**. Phase 0 (this disclosure + controls): **HOR-323**.
