// Phone access over Tailscale. devdeck only ever adds its own HTTPS port (8444) and never touches
// the tailnet's main URL (:443), which HexoKit or others may be serving.
import { spawn } from 'node:child_process';
import { capture, CmdError } from './sh.ts';
import { cleanEnv } from './tmux.ts';

export const SHARE_PORT = 8444;

// The CLI: `tailscale` on PATH, else the one inside the Mac app (its "Install CLI" puts it on PATH, but not everyone
// does that). Homebrew's `tailscale` formula talks to a daemon of its own, not the app's: with that one not running,
// it says so while the app is on, so whichever reports Running is the one used from then on.
const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
let cli = 'tailscale';
const ts = (...args: string[]) => capture(cli, args, { cwd: '/', env: cleanEnv() });
const stateOf = (out: string) => { try { return String(JSON.parse(out).BackendState ?? ''); } catch { return ''; } };

// `tailscale status --json` from the first CLI that has Tailscale running, else from the first that's there
export async function statusJson() {
  let best: Awaited<ReturnType<typeof ts>> | undefined;
  for (const bin of [...new Set([cli, 'tailscale', APP_CLI])]) {
    const r = await capture(bin, ['status', '--json'], { cwd: '/', env: cleanEnv() });
    if (stateOf(r.out) === 'Running') {
      cli = bin;
      return r;
    }
    // else the most telling: one that gave a state, then one that's there at all
    const rank = (x: typeof r) => (stateOf(x.out) ? 2 : x.code !== 127 ? 1 : 0);
    if (!best || rank(r) > rank(best)) best = r;
  }
  return best!;
}

// Why it isn't on, in a few words
const WHY: Record<string, string> = {
  Stopped: 'Turn Tailscale on in the menu bar.',
  NeedsLogin: 'Sign in to Tailscale on this Mac.',
  NeedsMachineAuth: 'Approve this Mac in the Tailscale admin console.',
  Starting: 'Tailscale is starting.',
};

export async function tailscaleStatus(localPort: number) {
  const st = await statusJson();
  const state = stateOf(st.out);
  if (st.code === 127) return { installed: false, running: false };
  if (state !== 'Running') return { installed: true, running: false, why: WHY[state] ?? (st.err || st.out).split('\n')[0] };
  let self: { DNSName?: string; Online?: boolean } = {};
  try {
    self = JSON.parse(st.out).Self ?? {};
  } catch {
    /* old CLI */
  }
  const host = (self.DNSName || '').replace(/\.$/, '');
  const serve = await ts('serve', 'status', '--json');
  // the local port :8444 leads to: this devdeck's, or another one's (a second devdeck beside it)
  let to: number | undefined;
  try {
    const web = JSON.parse(serve.out || '{}').Web ?? {};
    const handlers = web[`${host}:${SHARE_PORT}`]?.Handlers ?? {};
    to = Object.values(handlers).map((h: any) => Number(/:(\d+)\/?$/.exec(String(h?.Proxy ?? ''))?.[1])).find(Boolean);
  } catch {
    /* no serve config */
  }
  const shared = to === localPort;
  return { installed: true, running: true, host, shared, sharedTo: !shared ? to : undefined, url: host ? `https://${host}:${SHARE_PORT}` : undefined };
}

// `tailscale serve` on a tailnet without Serve or HTTPS turned on prints a link to turn them on, then waits until
// someone does: devdeck stops it there and hands the link on (Share again once it's on).
export async function shareOnTailnet(localPort: number) {
  const r = await new Promise<{ code: number; out: string; enable?: string }>((done) => {
    const p = spawn(cli, ['serve', '--bg', `--https=${SHARE_PORT}`, `http://localhost:${localPort}`], { cwd: '/', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const stop = setTimeout(() => (p.kill(), done({ code: 1, out: out || 'tailscale serve took over 30 seconds' })), 30_000);
    const take = (d: Buffer) => {
      out += d;
      const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(out)?.[0];
      if (enable) clearTimeout(stop), p.kill(), done({ code: 1, out, enable });
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (e) => (clearTimeout(stop), done({ code: 127, out: e.message })));
    p.on('close', (code) => (clearTimeout(stop), done({ code: code ?? 1, out: out.trim() })));
  });
  if (r.enable) return { ...(await tailscaleStatus(localPort)), enable: r.enable };
  if (r.code !== 0) throw new CmdError(`tailscale serve failed: ${r.out}`, 'enable HTTPS for your tailnet in the Tailscale admin console (DNS → HTTPS certificates)');
  return tailscaleStatus(localPort);
}
