import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { whatChanged, renderWhatChanged, whatChangedToJSON } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

const DEFAULT_SINCE = '7 days ago';

export const WHAT_CHANGED_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

Evidence used
- List the concrete changes/files/commits/timestamps Horus found

Interpretation
- Which change(s) look most incident-relevant and why
- Which changes are likely noise and why
- Any suspicious ordering or coverage gaps

Confidence
- High / Medium / Low with a one-line reason

Next checks
- Exact Horus commands or files to inspect next`;

export async function runWhatChanged(
  service: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    since?: string;
    until?: string;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const { code } = createConnectors(config);

    const since = opts.since ?? DEFAULT_SINCE;

    const r = await whatChanged(
      { repoPath: renv.path, since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? whatChangedToJSON(r) : renderWhatChanged(r));

    if (opts.ai && !opts.json) {
      const result = await renderAiInterpretation({
        command: 'what-changed',
        userIntent: service ? `service: ${service}` : undefined,
        evidence: r,
        promptKind: 'change-risk',
        outputContract: WHAT_CHANGED_AI_CONTRACT,
        config: opts.config,
        modelOverride: opts.aiModel,
        provider: opts._aiProvider,
      });
      console.log('\n' + renderInterpretation(result));
      if (!result.ok) {
        console.error(pc.yellow(`[ai] ${result.warning}`));
      }
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
