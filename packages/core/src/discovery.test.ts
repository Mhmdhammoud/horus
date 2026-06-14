import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverLocalConfig,
  findRepoRoot,
  writeLocalConfig,
  registerProject,
  lookupProject,
  readRegistry,
} from './discovery.js';

describe('discoverLocalConfig', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-disc-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a .horus/config.json by walking up from a subdir', () => {
    writeLocalConfig(root, { version: 1, project: { name: 'x' } });
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(discoverLocalConfig(deep)).toBe(join(root, '.horus', 'config.json'));
  });

  it('returns null when no .horus exists up the tree', () => {
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(discoverLocalConfig(deep)).toBeNull();
  });
});

describe('findRepoRoot', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-git-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the nearest .git ancestor', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const deep = join(root, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });
});

describe('global registry', () => {
  // Isolate HOME so the test never touches the real ~/.horus/registry.json.
  let home: string;
  const ORIG_HOME = process.env['HOME'];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'horus-home-'));
    process.env['HOME'] = home;
  });
  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = ORIG_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers and looks up a project', () => {
    expect(readRegistry().projects).toEqual({});
    registerProject('my-proj', '/repos/my-proj', '/repos/my-proj/.horus/config.json');
    const entry = lookupProject('my-proj');
    expect(entry?.root).toBe('/repos/my-proj');
    expect(entry?.configPath).toBe('/repos/my-proj/.horus/config.json');
    expect(lookupProject('nope')).toBeNull();
  });

  it('upserts an existing project entry', () => {
    registerProject('p', '/old', '/old/.horus/config.json');
    registerProject('p', '/new', '/new/.horus/config.json');
    expect(lookupProject('p')?.root).toBe('/new');
    expect(Object.keys(readRegistry().projects)).toEqual(['p']);
  });
});
