import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor } from './doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureOutput(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-doctor-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// Existing checks (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('exits 0 in a fully configured repo (healthy case)', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [
            { name: 'test-project', path: root, axon: { hostUrl: 'http://127.0.0.1:8420' } },
          ],
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn, not fail) when local config is missing', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    // No .horus/config.json — missing setup case
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when not in a git repository', async () => {
    const root = tempDir();
    // No git init
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when source-intelligence host is not configured', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [{ name: 'test-project', path: root }], // no axon
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HOR-85: Elasticsearch connector check
// ---------------------------------------------------------------------------

function writeJsConfig(dir: string, content: string): string {
  const path = join(dir, 'horus.config.js');
  writeFileSync(path, content);
  return path;
}

const DB = `{ url: "postgresql://horus:horus@localhost:5433/horus" }`;

describe('runDoctor — Elasticsearch present (HOR-85)', () => {
  it('exits 0 and shows indexPattern in output', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "my-api-prod-*" } },
    }],
  }],
};
`);
    const { lines, code } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('my-api-prod-*');
    expect(output).toContain('Elasticsearch');
  });

  it('shows project/env context in the detail', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "leadcall",
    repositories: [{ name: "leadcall", path: "/repos/leadcall" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "leadcall-prod-*" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('leadcall/production');
  });

  it('does not print url, username, or password secrets', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: {
        elasticsearch: {
          indexPattern: "my-api-prod-*",
          url: "https://es-secret.example.com:9200",
          username: "elastic-user",
          password: "super-secret-password",
        },
      },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('es-secret.example.com');
    expect(output).not.toContain('elastic-user');
    expect(output).not.toContain('super-secret-password');
  });

  it('notes that runtime ingestion is pending even when configured', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "logs-*" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    expect(lines.join('\n')).toContain('pending');
  });
});

describe('runDoctor — Elasticsearch absent (HOR-85)', () => {
  it('shows "not configured" when no environment has ES', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    expect(lines.join('\n')).toContain('not configured');
  });

  it('includes a next-step hint for absent ES config', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    expect(lines.join('\n')).toContain('connectors.elasticsearch');
  });

  it('exits 0 (warn, not fail) for absent ES', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`);
    const { code } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    expect(code).toBe(0);
  });
});

describe('runDoctor — Elasticsearch partial (indexPattern missing) (HOR-85)', () => {
  it('shows warn status when indexPattern is absent', async () => {
    const dir = tempDir();
    const configPath = writeJsConfig(dir, `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { elasticsearch: { indexPattern: "" } },
    }],
  }],
};
`);
    const { lines } = await captureOutput((write) =>
      runDoctor({ config: configPath, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('indexPattern not set');
    expect(output).toContain('set indexPattern');
  });
});

describe('runDoctor — no global config (HOR-85)', () => {
  it('skips ES check when no global config is loadable', async () => {
    const root = tempDir();
    // No horus.config.js, no horus.config.ts, no HORUS_CONFIG
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, write }),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('Elasticsearch');
  });

  it('still outputs existing checks when global config is absent', async () => {
    const root = tempDir();
    const { lines } = await captureOutput((write) =>
      runDoctor({ cwd: root, write }),
    );
    expect(lines.join('\n')).toContain('CLI version');
  });
});
