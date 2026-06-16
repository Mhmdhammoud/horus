/**
 * HOR-187 — Unit tests for interactive selector integration in `horus connect`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { askIndexSelection, askDashboardSelection } from './connect.js';

const mockCheckboxSearch = vi.fn();
const mockIsInteractive = vi.fn();

vi.mock('../lib/tty-selector.js', () => ({
  checkboxSearch: (...args: unknown[]) => mockCheckboxSearch(...args),
  isInteractive: () => mockIsInteractive(),
  ExitPromptError: class ExitPromptError extends Error {
    constructor(message = 'Prompt was cancelled') {
      super(message);
      this.name = 'ExitPromptError';
    }
  },
}));

function withStdinInput<T>(input: string, fn: () => Promise<T>): Promise<T> {
  const originalStdin = process.stdin;
  const mockStdin = new Readable({ read() {} });
  Object.defineProperty(mockStdin, 'isTTY', { value: false });
  Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });
  const promise = fn();
  mockStdin.push(input + '\n');
  mockStdin.push(null);
  return promise.finally(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });
}

beforeEach(() => {
  mockCheckboxSearch.mockReset();
  mockIsInteractive.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('askIndexSelection (HOR-187)', () => {
  it('uses the interactive checkbox selector in TTY mode', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockCheckboxSearch.mockResolvedValue(['logs-prod', 'logs-dev']);

    const result = await askIndexSelection(['logs-prod', 'logs-dev', 'metrics-prod']);

    expect(result).toEqual(['logs-prod', 'logs-dev']);
    expect(mockCheckboxSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select index patterns to use',
        choices: ['logs-prod', 'logs-dev', 'metrics-prod'],
        pageSize: 12,
      }),
    );
  });

  it('falls back to numeric selection in non-TTY mode', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await withStdinInput('1,2', () =>
      askIndexSelection(['logs-prod', 'logs-dev', 'metrics-prod']),
    );
    expect(result).toEqual(['logs-prod', 'logs-dev']);
    expect(mockCheckboxSearch).not.toHaveBeenCalled();
  });

  it('falls back to a manual pattern in non-TTY mode', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await withStdinInput('logs-*', () =>
      askIndexSelection(['logs-prod', 'logs-dev', 'metrics-prod']),
    );
    expect(result).toEqual(['logs-*']);
  });

  it('returns an empty array in non-TTY mode when the user skips', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await withStdinInput('', () =>
      askIndexSelection(['logs-prod', 'logs-dev', 'metrics-prod']),
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('askDashboardSelection (HOR-187)', () => {
  it('uses the interactive checkbox selector in TTY mode', async () => {
    mockIsInteractive.mockReturnValue(true);
    mockCheckboxSearch.mockResolvedValue(['API Overview', 'DB Health']);

    const dashboards = [
      { uid: 'abc', title: 'API Overview' },
      { uid: 'def', title: 'DB Health' },
      { uid: 'ghi', title: 'Redis' },
    ];
    const result = await askDashboardSelection(dashboards);

    expect(result).toEqual([
      { uid: 'abc', title: 'API Overview' },
      { uid: 'def', title: 'DB Health' },
    ]);
    expect(mockCheckboxSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select dashboards to use',
        choices: ['API Overview', 'DB Health', 'Redis'],
        pageSize: 12,
      }),
    );
  });

  it('falls back to numeric selection in non-TTY mode', async () => {
    mockIsInteractive.mockReturnValue(false);
    const dashboards = [
      { uid: 'abc', title: 'API Overview' },
      { uid: 'def', title: 'DB Health' },
    ];
    const result = await withStdinInput('1', () => askDashboardSelection(dashboards));
    expect(result).toEqual([{ uid: 'abc', title: 'API Overview' }]);
    expect(mockCheckboxSearch).not.toHaveBeenCalled();
  });
});

import { parseDbSpec } from './connect.js';

describe('parseDbSpec (HOR-201 redis --db)', () => {
  it('parses "0:cache,state"', () => {
    expect(parseDbSpec('0:cache,state')).toEqual({ db: 0, roles: ['cache', 'state'] });
  });

  it('parses "1:bullmq,queues"', () => {
    expect(parseDbSpec('1:bullmq,queues')).toEqual({ db: 1, roles: ['bullmq', 'queues'] });
  });

  it('parses a DB with no roles', () => {
    expect(parseDbSpec('2')).toEqual({ db: 2, roles: [] });
  });

  it('rejects an out-of-range DB index', () => {
    expect(() => parseDbSpec('99:cache')).toThrow(/0–15/);
  });

  it('rejects an unknown role', () => {
    expect(() => parseDbSpec('0:bogus')).toThrow(/Invalid role/);
  });
});
