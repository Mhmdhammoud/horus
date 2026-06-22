/**
 * Single-point command telemetry wiring (HOR-324). Registers Commander
 * pre/post-action hooks so every command emits `command.invoked` and
 * `command.completed` (with duration + exit code) without touching each
 * command's handler. Only flag NAMES and the command path are recorded.
 */
import type { Command } from 'commander';
import { track } from './client.js';
import { extractFlagNames } from './events.js';

/** Build the full command path, e.g. the `sync` of `horus cloud sync` -> "cloud sync". */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command | null = cmd;
  // Walk up to (but not including) the root program, which has no parent.
  while (current && current.parent) {
    parts.unshift(current.name());
    current = current.parent as Command;
  }
  return parts.join(' ') || cmd.name();
}

export function installCommandTelemetry(program: Command): void {
  let startedAt = 0;

  program.hook('preAction', (_thisCommand, actionCommand) => {
    startedAt = Date.now();
    track({
      type: 'command.invoked',
      command: commandPath(actionCommand),
      flags: extractFlagNames(process.argv),
    });
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    track({
      type: 'command.completed',
      command: commandPath(actionCommand),
      flags: extractFlagNames(process.argv),
      durationMs: startedAt ? Date.now() - startedAt : 0,
      exitCode,
      ok: exitCode === 0,
    });
  });
}
