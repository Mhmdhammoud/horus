import { describe, it, expect } from 'vitest';
import {
  parseCodeowners,
  resolveOwner,
  FIXTURE_CODEOWNERS,
  FIXTURE_CODEOWNERS_RULES,
} from './codeowners.js';

describe('parseCodeowners', () => {
  it('ignores blank lines and comments', () => {
    const rules = parseCodeowners('# comment\n\n*.ts @owner\n# another comment\n');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: '*.ts', owners: ['@owner'] });
  });

  it('parses multiple owners on one line', () => {
    const rules = parseCodeowners('src/ @alice @bob @team');
    expect(rules[0]?.owners).toEqual(['@alice', '@bob', '@team']);
  });

  it('parses a line with a leading / anchor', () => {
    const rules = parseCodeowners('/src/index.ts @owner');
    expect(rules[0]?.pattern).toBe('/src/index.ts');
  });
});

describe('resolveOwner — exact match', () => {
  it('returns owned for an exact path match', () => {
    const rules = parseCodeowners('src/index.ts @core-team');
    const result = resolveOwner('src/index.ts', rules);
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') return;
    expect(result.owners).toEqual(['@core-team']);
    expect(result.matchedPattern).toBe('src/index.ts');
  });

  it('returns unowned when no rule matches', () => {
    const rules = parseCodeowners('src/index.ts @core-team');
    const result = resolveOwner('src/other.ts', rules);
    expect(result.kind).toBe('unowned');
    expect(result.file).toBe('src/other.ts');
  });
});

describe('resolveOwner — wildcard match', () => {
  it('matches *.ts against any .ts file', () => {
    const rules = parseCodeowners('*.ts @ts-team');
    expect(resolveOwner('index.ts', rules).kind).toBe('owned');
    expect(resolveOwner('src/lib/util.ts', rules).kind).toBe('owned');
    expect(resolveOwner('index.js', rules).kind).toBe('unowned');
  });

  it('matches **/*.test.ts against test files at any depth', () => {
    const rules = parseCodeowners('**/*.test.ts @qa-team');
    expect(resolveOwner('src/util.test.ts', rules).kind).toBe('owned');
    expect(resolveOwner('packages/core/src/git.test.ts', rules).kind).toBe('owned');
    expect(resolveOwner('src/util.ts', rules).kind).toBe('unowned');
  });

  it('matches directory prefix patterns', () => {
    const rules = parseCodeowners('packages/cli/ @cli-team');
    expect(resolveOwner('packages/cli/src/index.ts', rules).kind).toBe('owned');
    expect(resolveOwner('packages/cli/package.json', rules).kind).toBe('owned');
    expect(resolveOwner('packages/core/src/index.ts', rules).kind).toBe('unowned');
  });
});

describe('resolveOwner — last-rule-wins', () => {
  it('later matching rules override earlier ones', () => {
    const rules = parseCodeowners('*.ts @general\nsrc/special.ts @specific');
    const result = resolveOwner('src/special.ts', rules);
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') return;
    expect(result.owners).toEqual(['@specific']);
    expect(result.matchedPattern).toBe('src/special.ts');
  });
});

describe('FIXTURE_CODEOWNERS_RULES', () => {
  it('resolves a CLI file to the cli-team', () => {
    const result = resolveOwner('packages/cli/src/commands/doctor.ts', FIXTURE_CODEOWNERS_RULES);
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') return;
    expect(result.owners).toContain('@horus/cli-team');
  });

  it('resolves a test file to the qa-team (last-rule-wins over *.ts)', () => {
    const result = resolveOwner('packages/core/src/git.test.ts', FIXTURE_CODEOWNERS_RULES);
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') return;
    expect(result.owners).toContain('@horus/qa-team');
  });

  it('resolves an exact path to multiple owners', () => {
    const result = resolveOwner('packages/core/src/git.ts', FIXTURE_CODEOWNERS_RULES);
    expect(result.kind).toBe('owned');
    if (result.kind !== 'owned') return;
    expect(result.owners).toContain('@horus/core-team');
    expect(result.owners).toContain('@horus/devex-team');
  });

  it('returns unowned for a file that matches no rule', () => {
    const result = resolveOwner('Makefile', FIXTURE_CODEOWNERS_RULES);
    expect(result.kind).toBe('unowned');
  });
});
