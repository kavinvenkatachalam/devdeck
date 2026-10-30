// A newer devdeck: GitHub's latest release, asked when devdeck starts and once a day after (one request each; never
// for a devdeck run from a checkout, which `devdeck update` can't update). The sidebar's Update runs `devdeck update`:
// Homebrew brings the new version, devdeck restarts onto it (terminals keep running) and the app follows.
import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT } from './state.ts';

const REPO = 'kavinvenkatachalam/devdeck';
const DAY = 24 * 60 * 60 * 1000;
export const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string;
// installed by Homebrew (its Cellar), not run from a checkout
const BREW = /\/Cellar\/devdeck\//.test(import.meta.dirname);

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

let latest: string | undefined;
let updating = false;
async function check() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) latest = ((await r.json()) as { tag_name: string }).tag_name.replace(/^v/, '');
  } catch {} // offline: asked again tomorrow
}
export function startUpdateChecks() {
  if (!BREW) return;
  check();
  setInterval(check, DAY).unref();
}

// for the sidebar: the version to update to (none when this is the latest), and whether it's on its way
export const updateInfo = () => ({ available: latest && newer(latest, VERSION) ? latest : undefined, updating });

export function runUpdate() {
  if (!BREW) throw new Error('this devdeck runs from a checkout: update it there (git pull)');
  if (updating) return;
  updating = true;
  // its own process group: `devdeck update` restarts this server, and must outlive it
  const log = openSync(join(STATE_ROOT, 'update.log'), 'a');
  const p = spawn(process.env.DEVDECK_ENTRY || join(import.meta.dirname, '..', 'bin', 'devdeck'), ['update'], { detached: true, stdio: ['ignore', log, log] });
  p.on('exit', () => (updating = false)); // still here: nothing to restart onto (already the latest), or it failed
  p.unref();
}
