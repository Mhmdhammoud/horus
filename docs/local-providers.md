# Local AI provider support (HOR-48 / HOR-78)

Horus can optionally use local AI tools (Codex, Claude CLI, Kimi, Gemini CLI, Cursor)
to enrich investigation narratives. This document describes the privacy boundary,
what Horus does and does not do with these tools, and the implementation checklist
for adding new provider support.

---

## Design principle

**Horus does not own your AI accounts or credentials.**

Local provider support is built on the opposite of a centralized key: Horus detects
whether a tool is already installed and runnable by the current user, and routes
narrative tasks to it through the user's own session. Nothing is stored on Horus's
side beyond the provider registry and the investigation output.

---

## Privacy boundary

| What Horus may do | What Horus must not do |
|-------------------|------------------------|
| Check whether a provider binary is present on `PATH` | Read or cache provider API keys or session tokens |
| Read `horus.config.json` for an explicit provider preference | Access browser cookies or auth sessions |
| Pass a bounded, redacted investigation packet to a local provider command | Send raw log lines, credentials, or PII to any provider |
| Record the provider's text output as part of the investigation report | Execute provider commands without a clear user-configured opt-in |
| Fall back gracefully when a provider is unavailable | Block an investigation because no local provider is configured |

The investigation packet sent to any provider is always pre-processed by the
redaction layer (`@horus/ai` `redactNarrativeInput`) before it leaves the process.
See `packages/ai/src/redact.ts` for the redaction rules.

---

## Detection signals (when implemented)

Horus uses the following signals to determine a provider's status. All are
read-only and require no elevated permissions:

1. **PATH probe** — run `<binary> --version` (or equivalent) to confirm the binary exists
   and returns a usable exit code. No auth required.
2. **Explicit config** — if the user sets a `providers.local.preferred` key in
   `horus.config.json`, Horus uses that provider without probing others.
3. **No fallback hierarchy across providers** — Horus does not silently try provider
   B when provider A fails mid-run. It reports the failure and stops.

Detection does not verify that the provider is authenticated or that it can accept
tasks — that is left to the first real use, where the provider's own error output
reaches the user directly.

---

## Supported providers (registry only — detection not yet implemented)

The provider registry (`packages/ai/src/local-providers.ts`) defines the following
stable IDs. These IDs are the canonical reference for all future detection and
execution work.

| ID | Display name | Binary / entry point |
|----|-------------|----------------------|
| `codex` | OpenAI Codex CLI | `codex` |
| `claude` | Anthropic Claude | `claude` |
| `kimi` | Moonshot Kimi | `kimi` |
| `gemini` | Google Gemini CLI | `gemini` |
| `cursor` | Cursor | `cursor` |

> **Status:** The registry contract (IDs, types, lookup) is implemented. Provider
> detection and execution are not yet implemented — do not document them as available.

---

## Implementation checklist for a new provider

Use this checklist when adding detection or execution support for a provider listed
above. Each item must be complete before the feature is considered production-ready.

### Detection

- [ ] Binary probe is purely read-only (`--version` or health check only)
- [ ] Probe timeout is bounded (≤ 2 s) so `horus providers doctor` is fast
- [ ] Probe failure returns `status: 'unavailable'` — never throws uncaught
- [ ] No credentials are read during detection

### Execution

- [ ] Input to the provider is built from `NarrativeInput` via `redactNarrativeInput`
- [ ] Output is validated by `validateNarrative` before it enters the report
- [ ] On provider error, execution falls back to the deterministic narrative
- [ ] No raw log lines, PII, or credential-shaped strings reach the provider
- [ ] Provider command is run through a controlled adapter (not a raw shell interpolation)
- [ ] User must have explicitly opted in via CLI flag or config (`--ai` or equivalent)

### Documentation and testing

- [ ] `docs/local-providers.md` updated with the provider's actual status
- [ ] Unit tests for the detection result shapes (use `LocalProviderResult`)
- [ ] Contract test verifying the provider returns a valid `NarrativeOutput`
- [ ] `horus providers doctor` output updated to reflect the new provider

---

## What is not supported

The following will not be implemented as part of local provider support:

- **Browser cookie reuse** — Horus will not read or relay session tokens from
  browser profiles (Cursor, Claude web, etc.).
- **Automatic credential discovery** — Horus will not scan `~/.config`, keychain, or
  environment variables to auto-configure a provider without user action.
- **Cross-provider fallback chains** — Horus will not silently retry with a second
  provider when the first fails mid-run.
- **Unbounded input forwarding** — Raw evidence, log excerpts, or tool output will
  not be forwarded to a provider without passing through the redaction layer first.

---

## Related

- `packages/ai/src/local-providers.ts` — provider registry contract (HOR-74)
- `packages/ai/src/redact.ts` — narrative input redaction (HOR-72)
- `docs/source-intelligence-boundary.md` — source-intelligence privacy model
