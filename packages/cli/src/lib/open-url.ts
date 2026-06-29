/**
 * Best-effort open of a URL in the user's default browser. Shared by `horus login`
 * (device-flow) and `horus report` (pre-filled GitHub issue). NEVER throws and never
 * blocks: on a headless box / missing opener the caller always prints the URL too, so
 * the user can open it manually.
 */
import { execFile } from 'node:child_process';

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    execFile(cmd, args, () => {
      /* ignore — the URL is printed regardless */
    });
  } catch {
    /* headless / no browser — the user opens the printed URL manually */
  }
}
