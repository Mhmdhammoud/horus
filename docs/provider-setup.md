# Local AI provider setup

Horus can optionally route investigation narratives through a local AI tool you
already have installed. This page explains what is available now and what is
coming.

---

## Current status

| Feature | Status |
|---------|--------|
| Provider registry (IDs, types) | Available — `packages/ai/src/local-providers.ts` |
| Provider detection (`horus providers doctor`) | **Upcoming** — not yet implemented |
| Provider execution (`--ai` via local tool) | **Upcoming** — not yet implemented |
| Anthropic cloud provider (`--ai` flag) | Available — requires `ANTHROPIC_API_KEY` |

If you want AI narrative enrichment now, use the cloud provider:

```sh
ANTHROPIC_API_KEY=<your-key> horus investigate "your incident hint" --ai
```

---

## Supported local providers (upcoming)

The following provider IDs are reserved and will be supported when detection and
execution are implemented. Do not configure these yet — the commands below do not
exist in the current release.

| Provider | ID | Expected binary |
|----------|----|----------------|
| OpenAI Codex CLI | `codex` | `codex` |
| Anthropic Claude CLI | `claude` | `claude` |
| Moonshot Kimi | `kimi` | `kimi` |
| Google Gemini CLI | `gemini` | `gemini` |
| Cursor | `cursor` | `cursor` |

---

## What to expect when provider detection ships

Once detection is implemented, the workflow will look like this:

```sh
# Check which local providers Horus can find (upcoming — not available yet)
horus providers doctor
```

Expected output (illustrative):

```
Local AI providers
  ✓ codex     OpenAI Codex CLI   ready
  ✗ claude    Anthropic Claude   not found on PATH
  ✗ kimi      Moonshot Kimi      not found on PATH
  ✗ gemini    Google Gemini CLI  not found on PATH
  ✗ cursor    Cursor             not found on PATH
```

You will then be able to set a preferred provider in your Horus config
(`horus.config.json`) and use it with the `--ai` flag on `horus investigate`.

---

## Privacy and boundaries

Horus does not read your AI tool credentials or session tokens. Detection uses
only a PATH probe (`binary --version`). Execution passes a bounded, redacted
investigation packet — never raw log lines or PII.

See [local-providers.md](./local-providers.md) for the full privacy boundary and
the implementation checklist.

---

## Source intelligence

Local AI providers are for narrative generation only. Source-intelligence
(code graph, ownership, impact analysis) is provided by the Axon backend — see
[connector-setup.md](./connector-setup.md).
