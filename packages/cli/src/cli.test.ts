import { describe, it, expect } from 'vitest';
import { buildProgram } from './index.js';
import { HORUS_VERSION } from '@horus/core';

describe('CLI program structure', () => {
  it('has the correct name', () => {
    expect(buildProgram().name()).toBe('horus');
  });

  it('description mentions investigation', () => {
    expect(buildProgram().description()).toContain('investigation');
  });

  it('embeds HORUS_VERSION in the version string', () => {
    // Commander's .version() getter returns the string set via .version(str, flags, desc).
    // buildProgram() calls .version(`horus ${HORUS_VERSION}`) so the two must agree exactly.
    expect(buildProgram().version()).toBe(`horus ${HORUS_VERSION}`);
  });

  it('registers all release-critical commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    const required = [
      'setup',
      'init',
      'projects',
      'connect',
      'stop',
      'hosts',
      'status',
      'investigate',
      'index',
      'queues',
      'explain',
      'changes',
      'timeline',
      'what-changed',
      'replay',
      'logs',
      'metrics',
    ];
    for (const cmd of required) {
      expect(names, `command "${cmd}" should be registered`).toContain(cmd);
    }
  });

  it('registers the full command set (no silent regressions)', () => {
    const names = buildProgram().commands.map((c) => c.name());
    // Smoke-check additional commands beyond the release-critical set.
    for (const cmd of ['architecture', 'blast-radius', 'repos', 'search', 'investigations',
                        'postmortem', 'owner', 'score', 'scores', 'ask', 'onboard',
                        'simulate', 'state']) {
      expect(names, `command "${cmd}" should be registered`).toContain(cmd);
    }
  });

  it('setup command has --config option', () => {
    const setup = buildProgram().commands.find((c) => c.name() === 'setup')!;
    const longs = setup.options.map((o) => o.long);
    expect(longs).toContain('--config');
  });

  it('investigate command has --project, --env, --format options', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--project');
    expect(longs).toContain('--env');
    expect(longs).toContain('--format');
  });

  it('investigate command has --ai and --ai-model options', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--ai');
    expect(longs).toContain('--ai-model');
  });

  it('investigate --ai option description mentions ANTHROPIC_API_KEY', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const aiOpt = investigate.options.find((o) => o.long === '--ai');
    expect(aiOpt?.description).toContain('ANTHROPIC_API_KEY');
  });

  it('investigate --ai is a boolean flag (no required argument)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const aiOpt = investigate.options.find((o) => o.long === '--ai');
    // Boolean flags have required=false and optional=false
    expect(aiOpt?.required).toBe(false);
    expect(aiOpt?.optional).toBe(false);
  });

  it('connect command requires a <type> argument', () => {
    const connect = buildProgram().commands.find((c) => c.name() === 'connect')!;
    expect(connect.registeredArguments.length).toBeGreaterThan(0);
    expect(connect.registeredArguments[0]?.name()).toBe('type');
  });

  it('index command has --name and --env options', () => {
    const index = buildProgram().commands.find((c) => c.name() === 'index')!;
    const longs = index.options.map((o) => o.long);
    expect(longs).toContain('--name');
    expect(longs).toContain('--env');
  });

  it('stop command has --all flag', () => {
    const stop = buildProgram().commands.find((c) => c.name() === 'stop')!;
    const longs = stop.options.map((o) => o.long);
    expect(longs).toContain('--all');
  });

  it('investigate command has --since option (HOR-86)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--since');
  });

  it('investigate --since accepts a value argument (not a boolean flag)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const sinceOpt = investigate.options.find((o) => o.long === '--since');
    // A value option has required=true (mandatory arg) or optional=true (optional arg)
    expect(sinceOpt?.required || sinceOpt?.optional).toBe(true);
  });

  it('doctor command has --config option (HOR-85)', () => {
    const doctor = buildProgram().commands.find((c) => c.name() === 'doctor')!;
    const longs = doctor.options.map((o) => o.long);
    expect(longs).toContain('--config');
  });
});
