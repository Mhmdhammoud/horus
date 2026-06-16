/**
 * Unit tests for the minimal TTY selector used by `horus connect`.
 */

import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { checkboxSearch, isInteractive, ExitPromptError } from './tty-selector.js';

class MockTTY extends Readable {
  isRaw = false;

  constructor() {
    super();
    Object.defineProperty(this, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
  }

  override _read() {
    // No-op: data is pushed manually via emitKey.
  }

  setRawMode(raw: boolean) {
    this.isRaw = raw;
    return this;
  }

  emitKey(seq: string) {
    this.emit('data', Buffer.from(seq));
  }
}

class MockOutput extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk.toString());
    callback();
  }

  output() {
    return this.chunks.join('');
  }
}

class MockNonTTY extends Readable {
  constructor() {
    super();
    Object.defineProperty(this, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });
  }

  override _read() {}
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------

describe('isInteractive', () => {
  it('returns true for a TTY stream', () => {
    const tty = new MockTTY();
    expect(isInteractive(tty)).toBe(true);
  });

  it('returns false for a non-TTY stream', () => {
    const nonTty = new MockNonTTY();
    expect(isInteractive(nonTty)).toBe(false);
  });
});

describe('checkboxSearch', () => {
  it('returns an empty array when there are no choices', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const result = await checkboxSearch({ message: 'Pick', choices: [], input, output });
    expect(result).toEqual([]);
  });

  it('throws when given a non-TTY stream', async () => {
    const input = new MockNonTTY();
    const output = new MockOutput();
    await expect(
      checkboxSearch({ message: 'Pick', choices: ['a', 'b'], input, output }),
    ).rejects.toThrow('requires an interactive TTY');
  });

  it('returns selected items after toggling with space and confirming with enter', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['logs-prod', 'logs-dev', 'metrics-prod'];

    const promise = checkboxSearch({ message: 'Pick indices', choices, input, output });
    await tick();

    input.emitKey(' '); // toggle first
    input.emitKey('\x1B[B'); // down
    input.emitKey(' '); // toggle second
    input.emitKey('\r'); // confirm

    await expect(promise).resolves.toEqual(['logs-prod', 'logs-dev']);
    expect(input.isRaw).toBe(false);
  });

  it('filters choices when the user types', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['erp-dev', 'leadcall-api-prod', 'leadcall-api-dev'];

    const promise = checkboxSearch({ message: 'Pick indices', choices, input, output });
    await tick();

    input.emitKey('p');
    input.emitKey('r');
    input.emitKey('o');
    input.emitKey('d');
    await tick();
    input.emitKey(' '); // toggle the first filtered item
    input.emitKey('\r');

    const result = await promise;
    expect(result).toEqual(['leadcall-api-prod']);
    expect(output.output()).toContain('filter: prod');
  });

  it('clears the filter with backspace', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['alpha', 'beta'];

    const promise = checkboxSearch({ message: 'Pick', choices, input, output });
    await tick();

    input.emitKey('a');
    input.emitKey('\x7F'); // backspace
    input.emitKey(' '); // toggle first item of restored list
    input.emitKey('\r');

    const result = await promise;
    expect(result).toEqual(['alpha']);
  });

  it('cancels with ctrl+c', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['a', 'b'];

    const promise = checkboxSearch({ message: 'Pick', choices, input, output });
    await tick();

    input.emitKey('\x03');

    await expect(promise).rejects.toBeInstanceOf(ExitPromptError);
    expect(input.isRaw).toBe(false);
  });

  it('cancels with escape when filter is empty', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['a', 'b'];

    const promise = checkboxSearch({ message: 'Pick', choices, input, output });
    await tick();

    input.emitKey('\x1B');

    await expect(promise).rejects.toBeInstanceOf(ExitPromptError);
  });

  it('clears filter with escape when filter is non-empty', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['alpha', 'beta'];

    const promise = checkboxSearch({ message: 'Pick', choices, input, output });
    await tick();

    input.emitKey('a');
    await tick();
    input.emitKey('\x1B'); // clear filter
    input.emitKey(' '); // toggle first of restored list
    input.emitKey('\r');

    const result = await promise;
    expect(result).toEqual(['alpha']);
  });

  it('returns an empty selection when the user confirms without selecting', async () => {
    const input = new MockTTY();
    const output = new MockOutput();
    const choices = ['a', 'b'];

    const promise = checkboxSearch({ message: 'Pick', choices, input, output });
    await tick();

    input.emitKey('\r');

    await expect(promise).resolves.toEqual([]);
  });
});
