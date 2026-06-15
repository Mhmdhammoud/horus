/**
 * CODEOWNERS ownership parser.
 *
 * Parses GitHub/GitLab CODEOWNERS-style files and resolves which owners
 * are responsible for a given file path. Supports the simple patterns
 * used in real CODEOWNERS files:
 *   - exact paths          `src/index.ts @owner`
 *   - directory prefixes   `src/lib/ @owner`  (matches everything under src/lib/)
 *   - extension globs      `*.ts @owner`       (any .ts file)
 *   - double-star globs    `**\/*.test.ts @owner`
 *
 * Resolution follows the CODEOWNERS rule: last matching rule wins.
 */

export interface OwnershipRule {
  pattern: string;
  owners: string[];
}

export interface OwnershipMatch {
  kind: 'owned';
  file: string;
  owners: string[];
  matchedPattern: string;
}

export interface OwnershipUnmatched {
  kind: 'unowned';
  file: string;
}

export type FileOwnershipResult = OwnershipMatch | OwnershipUnmatched;

/**
 * Parse a CODEOWNERS file into an ordered list of rules.
 * Comment lines and blank lines are ignored.
 */
export function parseCodeowners(content: string): OwnershipRule[] {
  const rules: OwnershipRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1);
    if (pattern && owners.length > 0) {
      rules.push({ pattern, owners });
    }
  }
  return rules;
}

/**
 * Resolve which owners are responsible for `file` given an ordered list of rules.
 * Last matching rule wins (GitHub CODEOWNERS semantics).
 */
export function resolveOwner(file: string, rules: OwnershipRule[]): FileOwnershipResult {
  let match: OwnershipRule | null = null;
  for (const rule of rules) {
    if (patternMatches(rule.pattern, file)) {
      match = rule;
    }
  }
  if (match) {
    return { kind: 'owned', file, owners: match.owners, matchedPattern: match.pattern };
  }
  return { kind: 'unowned', file };
}

function patternMatches(pattern: string, file: string): boolean {
  const p = pattern.startsWith('/') ? pattern.slice(1) : pattern;

  if (p.endsWith('/')) {
    return file.startsWith(p);
  }

  // GitHub CODEOWNERS: patterns without a path separator match at any depth.
  // `*.ts` is treated as `**/*.ts` — it matches src/lib/util.ts and index.ts.
  const effectivePattern = !p.includes('/') ? `**/${p}` : p;
  return globToRegex(effectivePattern).test(file);
}

function globToRegex(pattern: string): RegExp {
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // **/ → zero or more directories
        result += '(?:.+/)?';
        i += 3;
      } else {
        result += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      result += '[^/]*';
      i++;
    } else {
      result += pattern[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${result}$`);
}

// ---------------------------------------------------------------------------
// Built-in fixture — reusable in HOR-71 replay tests
// ---------------------------------------------------------------------------

export const FIXTURE_CODEOWNERS = `
# Horus project CODEOWNERS fixture (HOR-69)
# Used for deterministic ownership resolution tests.

*.ts                      @horus/core-team
packages/cli/             @horus/cli-team
packages/connectors/      @horus/connectors-team
**/*.test.ts              @horus/qa-team
docs/                     @horus/docs-team
packages/core/src/git.ts  @horus/core-team @horus/devex-team
`.trim();

/** Pre-parsed rules from FIXTURE_CODEOWNERS. */
export const FIXTURE_CODEOWNERS_RULES: OwnershipRule[] = parseCodeowners(FIXTURE_CODEOWNERS);
