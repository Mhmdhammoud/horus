import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';

export const SUPPORTED_TARGETS = ['claude', 'codex', 'gemini', 'cursor', 'generic'] as const;
export type SkillTarget = (typeof SUPPORTED_TARGETS)[number];

export function isValidTarget(target: string): target is SkillTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}

export function getSkillInstallPath(
  target: SkillTarget,
  opts: { global?: boolean; cwd?: string },
): string {
  const base = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  if (target === 'claude') {
    return join(base, '.claude', 'skills', 'horus.md');
  }
  return join(base, '.horus', 'skills', `horus-${target}.md`);
}

const BASE_SKILL = `\
# Horus Incident Investigation Skill

When investigating a production issue in a repo with Horus configured, use Horus before guessing.

## When to use Horus

Use Horus when the user asks:
- why something is broken, slow, or failing
- about a production incident or outage
- what changed recently
- who owns a component or service
- about blast radius or impact of a change
- about queues, workers, Redis/BullMQ, logs, metrics, MongoDB state, or source paths
- to verify a fix or check for regressions after a change

## Getting started

\`\`\`bash
horus status
horus explain <symbol-or-hint>
horus investigate "<incident hint>"
\`\`\`

## Runtime evidence

\`\`\`bash
horus logs [service]
horus state
horus metrics "<hint>"
horus queues --live
\`\`\`

## Source reasoning

\`\`\`bash
horus blast-radius <symbol>
horus owner <symbol>
horus changes <base> [compare]
horus timeline
horus what-changed
\`\`\`

## Saved investigations

\`\`\`bash
horus replay <id>
horus ask <id> "what evidence is missing?"
horus ask <id> "what evidence contradicts <hypothesis>?"
horus postmortem <id>
horus score <id>
\`\`\`

## Rules

- Treat Horus evidence as grounded but not infallible.
- Mention when Horus evidence is missing, stale, ambient, or not structurally linked.
- Do not invent runtime evidence Horus did not collect.
- Prefer exact source locations from Horus over guesses.
- If Horus output conflicts with filesystem or source inspection, report the discrepancy.
- For write or fix tasks, use Horus to validate blast radius and rerun relevant checks after changes.
- Horus is read-only evidence collection — never use Horus to mutate production systems.
- Do not hallucinate evidence. If Horus returns nothing, say so explicitly.
`;

const CLAUDE_SUFFIX = `\
## Claude Code notes

This skill is loaded automatically when present at \`.claude/skills/horus.md\`.

Useful starting points:
- \`horus investigations\` — list saved investigation IDs
- \`horus doctor\` — check system health
- \`horus onboard [area]\` — get oriented in a new codebase area
`;

export function generateSkillContent(target: SkillTarget): string {
  if (target === 'claude') {
    return BASE_SKILL + '\n' + CLAUDE_SUFFIX;
  }
  return BASE_SKILL;
}

export async function runSkillInstall(
  target: string,
  opts: {
    force?: boolean;
    global?: boolean;
    cwd?: string;
    write?: (line: string) => void;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  const outPath = getSkillInstallPath(target, { global: opts.global, cwd: opts.cwd });
  const content = generateSkillContent(target);

  if (existsSync(outPath) && !opts.force) {
    log(`${pc.red('✗')} ${outPath} already exists`);
    log(pc.dim('  pass --force to overwrite'));
    return 1;
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, 'utf8');
  } catch (err) {
    log(`${pc.red('✗')} Could not write ${outPath}: ${(err as Error).message}`);
    return 1;
  }

  log(`${pc.green('✓')} Horus skill installed → ${outPath}`);

  if (target === 'claude') {
    log(pc.dim('  Claude Code will load this skill automatically.'));
    log(pc.dim('  Invoke it with: /horus'));
  } else {
    log(pc.dim(`  Copy or reference this file in your ${target} agent instructions.`));
  }

  return 0;
}

export async function runSkillPrint(
  target: string,
  opts: { write?: (line: string) => void },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  process.stdout.write(generateSkillContent(target));
  return 0;
}

export async function runSkillPath(
  target: string,
  opts: {
    global?: boolean;
    cwd?: string;
    write?: (line: string) => void;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  const outPath = getSkillInstallPath(target, { global: opts.global, cwd: opts.cwd });
  log(outPath);
  return 0;
}

/** Verify the installed skill contains no secrets from .horus/config.json. */
export function skillContentLeaksSecrets(content: string): boolean {
  const secretPatterns = [
    /"password"\s*:/i,
    /"apiKey"\s*:/i,
    /"api_key"\s*:/i,
    /bearer\s+[a-z0-9._-]{20,}/i,
    /mongodb\+srv:\/\/[^@]+@/i,
    /redis:\/\/:[^@]+@/i,
    /postgresql:\/\/[^:]+:[^@]+@/i,
  ];
  return secretPatterns.some((p) => p.test(content));
}
