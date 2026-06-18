import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

export const SUPPORTED_TARGETS = ['claude', 'codex', 'gemini', 'cursor', 'generic'] as const;
export type SkillTarget = (typeof SUPPORTED_TARGETS)[number];

export function isValidTarget(target: string): target is SkillTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}

/** Legacy flat-file path used by early Horus Claude skill installers. */
export function getLegacyClaudeSkillPath(opts: { global?: boolean; cwd?: string }): string {
  const base = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  return join(base, '.claude', 'skills', 'horus.md');
}

export function getSkillInstallPath(
  target: SkillTarget,
  opts: { global?: boolean; cwd?: string },
): string {
  const base = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  switch (target) {
    case 'claude':
      return join(base, '.claude', 'skills', 'horus', 'SKILL.md');
    case 'gemini':
      return join(base, '.gemini', 'skills', 'horus', 'SKILL.md');
    case 'cursor':
      return opts.global
        ? join(base, '.cursorrules')
        : join(base, '.cursor', 'rules', 'horus.mdc');
    case 'codex':
      return opts.global ? join(base, '.codex', 'AGENTS.md') : join(base, 'AGENTS.md');
    case 'generic':
    default:
      return join(base, '.horus', 'skills', `horus-${target}.md`);
  }
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

function skillFrontmatter(target: SkillTarget): string {
  const description = 'Use Horus as the grounded evidence layer for production incident investigation.';
  switch (target) {
    case 'claude':
    case 'gemini':
      return `---\nname: horus\ndescription: ${description}\n---\n\n`;
    case 'cursor':
      return `---\ndescription: ${description}\nglobs: *\nalwaysApply: true\n---\n\n`;
    default:
      return '';
  }
}

const PROVIDER_NOTES: Record<SkillTarget, string> = {
  claude: `\
## Claude Code notes

This skill is loaded automatically when present at \`.claude/skills/horus/SKILL.md\`.

Useful starting points:
- \`horus investigations\` — list saved investigation IDs
- \`horus doctor\` — check system health
- \`horus onboard [area]\` — get oriented in a new codebase area
`,
  gemini: `\
## Gemini CLI notes

This skill is loaded automatically when present at \`.gemini/skills/horus/SKILL.md\`.

Useful starting points:
- \`horus investigations\` — list saved investigation IDs
- \`horus doctor\` — check system health
- \`horus onboard [area]\` — get oriented in a new codebase area
`,
  cursor: `\
## Cursor notes

This rule is loaded automatically when present at \`.cursor/rules/horus.mdc\`.

Useful starting points:
- \`horus investigations\` — list saved investigation IDs
- \`horus doctor\` — check system health
- \`horus onboard [area]\` — get oriented in a new codebase area
`,
  codex: `\
## Codex notes

This file is loaded automatically by Codex CLI as project instructions.

Useful starting points:
- \`horus investigations\` — list saved investigation IDs
- \`horus doctor\` — check system health
- \`horus onboard [area]\` — get oriented in a new codebase area
`,
  generic: '',
};

export function generateSkillContent(target: SkillTarget): string {
  return skillFrontmatter(target) + BASE_SKILL + '\n' + PROVIDER_NOTES[target];
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runSkillInstall(
  target: string,
  opts: {
    force?: boolean;
    global?: boolean;
    cwd?: string;
    write?: (line: string) => void;
    confirm?: (message: string) => Promise<boolean>;
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

  // Migrate legacy flat Claude skill file to the new directory layout.
  if (target === 'claude') {
    const legacyPath = getLegacyClaudeSkillPath({ global: opts.global, cwd: opts.cwd });
    if (existsSync(legacyPath)) {
      if (!opts.force) {
        const confirmed = await (opts.confirm ?? confirm)(
          `Found old flat skill file at ${legacyPath}. Replace it with the new directory layout?`,
        );
        if (!confirmed) {
          log(`${pc.yellow('!')} Migration cancelled; existing skill left untouched.`);
          log(pc.dim('  Pass --force to replace without prompting.'));
          return 1;
        }
      }
      try {
        rmSync(legacyPath);
        log(`${pc.yellow('!')} Replaced old flat skill file: ${legacyPath}`);
      } catch (err) {
        log(`${pc.red('✗')} Could not remove legacy skill file ${legacyPath}: ${(err as Error).message}`);
        return 1;
      }
    }
  }

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
  } else if (target === 'gemini') {
    log(pc.dim('  Gemini CLI will load this skill automatically.'));
  } else if (target === 'cursor') {
    log(pc.dim('  Cursor will load this rule automatically.'));
  } else if (target === 'codex') {
    log(pc.dim('  Codex CLI will load this file automatically.'));
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
