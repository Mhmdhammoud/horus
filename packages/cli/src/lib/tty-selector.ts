/**
 * Minimal interactive TTY selector for `horus connect`.
 *
 * Provides a searchable, multi-select checkbox prompt for interactive terminals.
 * Falls back to plain readline prompts when stdin is not a TTY.
 */

import { ReadStream } from 'node:tty';
import pc from 'picocolors';

export interface CheckboxSearchOptions {
  message: string;
  choices: string[];
  pageSize?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class ExitPromptError extends Error {
  constructor(message = 'Prompt was cancelled') {
    super(message);
    this.name = 'ExitPromptError';
  }
}

/** Return true when the input stream is an interactive TTY. */
export function isInteractive(input?: NodeJS.ReadableStream): boolean {
  const stream = input ?? process.stdin;
  return (
    (stream as ReadStream).isTTY === true &&
    typeof (stream as ReadStream).setRawMode === 'function'
  );
}

/**
 * Show a searchable, multi-select checkbox prompt.
 *
 * Keyboard controls:
 *   ↑ / ↓    navigate
 *   space    toggle selection
 *   enter    confirm selection (may be empty)
 *   type     filter the list
 *   backspace edit filter
 *   esc      clear filter, or cancel when filter is empty
 *   ctrl+c   cancel
 *
 * Returns the selected choice values. Throws ExitPromptError on cancel.
 */
export async function checkboxSearch(opts: CheckboxSearchOptions): Promise<string[]> {
  const { message, choices } = opts;
  const pageSize = opts.pageSize ?? 10;
  const input = (opts.input ?? process.stdin) as ReadStream;
  const output = opts.output ?? process.stdout;

  if (!isInteractive(input)) {
    throw new Error('checkboxSearch requires an interactive TTY');
  }

  if (choices.length === 0) {
    return [];
  }

  return new Promise((resolve, reject) => {
    let filter = '';
    const selected = new Set<string>();
    let cursor = 0;
    let filtered = choices;
    let visibleOffset = 0;
    let lastRenderLines = 0;
    const wasRaw = input.isRaw;

    function updateFiltered() {
      const f = filter.toLowerCase();
      filtered = f ? choices.filter((c) => c.toLowerCase().includes(f)) : choices;
      cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
      updateVisibleOffset();
    }

    function updateVisibleOffset() {
      if (cursor < visibleOffset) {
        visibleOffset = cursor;
      } else if (cursor >= visibleOffset + pageSize) {
        visibleOffset = cursor - pageSize + 1;
      }
      const maxOffset = Math.max(0, filtered.length - pageSize);
      visibleOffset = Math.max(0, Math.min(visibleOffset, maxOffset));
    }

    function clear() {
      output.write('\x1B[?25l'); // hide cursor
      if (lastRenderLines > 0) {
        output.write(`\x1B[${lastRenderLines}A`); // move up
        output.write('\x1B[0J'); // clear to end
      }
    }

    function render() {
      clear();
      const lines: string[] = [];
      lines.push(
        `? ${pc.bold(message)} ${pc.dim('(↑↓ navigate • space toggle • enter confirm • type filter)')}`,
      );

      const visible = filtered.slice(visibleOffset, visibleOffset + pageSize);
      for (let i = 0; i < visible.length; i++) {
        const idx = visibleOffset + i;
        const choice = visible[i]!;
        const isCursor = idx === cursor;
        const isSelected = selected.has(choice);
        const marker = isSelected ? pc.green('●') : ' ';
        const prefix = `[${marker}]`;
        const label = isCursor ? pc.cyan(choice) : choice;
        const pointer = isCursor ? pc.cyan('❯') : ' ';
        lines.push(`  ${pointer} ${prefix} ${label}`);
      }

      if (filtered.length === 0) {
        lines.push(pc.dim('  No matches'));
      }

      const statusParts = [
        `${selected.size} selected`,
        `${filtered.length}/${choices.length} matches`,
      ];
      if (filter) statusParts.push(`filter: ${filter}`);
      lines.push(pc.dim(`  ${statusParts.join(' · ')}`));

      output.write(lines.join('\n'));
      lastRenderLines = lines.length;
    }

    function finish(values: string[]) {
      cleanup();
      // Print a compact summary on the final line.
      const summary = values.length > 0 ? values.join(', ') : pc.dim('none');
      output.write(`\n? ${pc.bold(message)} ${summary}\n`);
      resolve(values);
    }

    function cancel() {
      cleanup();
      reject(new ExitPromptError());
    }

    function cleanup() {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      output.write('\x1B[?25h'); // show cursor
    }

    function toggleCurrent() {
      const choice = filtered[cursor];
      if (choice === undefined) return;
      if (selected.has(choice)) {
        selected.delete(choice);
      } else {
        selected.add(choice);
      }
    }

    function onData(chunk: Buffer) {
      const s = chunk.toString();

      if (s === '\x03') {
        // Ctrl+C
        cancel();
        return;
      }

      if (s === '\x1B') {
        // Esc: clear filter, or cancel if filter is empty.
        if (filter) {
          filter = '';
          cursor = 0;
          updateFiltered();
        } else {
          cancel();
        }
        render();
        return;
      }

      if (s === '\r' || s === '\n') {
        finish(Array.from(selected));
        return;
      }

      if (s === ' ') {
        toggleCurrent();
        render();
        return;
      }

      if (s === '\x7F' || s === '\b') {
        // Backspace
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          cursor = 0;
          updateFiltered();
        }
        render();
        return;
      }

      if (s === '\x1B[A') {
        // Up
        if (cursor > 0) {
          cursor -= 1;
          updateVisibleOffset();
        }
        render();
        return;
      }

      if (s === '\x1B[B') {
        // Down
        if (cursor < filtered.length - 1) {
          cursor += 1;
          updateVisibleOffset();
        }
        render();
        return;
      }

      // Printable ASCII: append to filter.
      if (s.length === 1 && s.charCodeAt(0) >= 32 && s.charCodeAt(0) <= 126) {
        filter += s;
        cursor = 0;
        updateFiltered();
        render();
      }
    }

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);

    updateFiltered();
    render();
  });
}
