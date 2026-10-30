// Phone access over Tailscale. devdeck only ever adds its own HTTPS port (8444) and never touches
// the tailnet's main URL (:443), which HexoKit or others may be serving.
import { capture, CmdError } from './sh.ts';
import { cleanEnv } from './tmux.ts';

export const SHARE_PORT = 8444;

const ts = (...args: string[]) => capture('tailscale', args, { cwd: '/', env: cleanEnv() });

export async function tailscaleStatus(localPort: number) {
  const st = await ts('status', '--json');
  if (st.code !== 0) return { installed: st.code !== 127, running: false };
  let self: { DNSName?: string; Online?: boolean } = {};
  let state = '';
  try {
    const j = JSON.parse(st.out);
    self = j.Self ?? {};
    state = j.BackendState;
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
  return { installed: true, running: state === 'Running', host, shared, sharedTo: !shared ? to : undefined, url: host ? `https://${host}:${SHARE_PORT}` : undefined };
}

export async function shareOnTailnet(localPort: number) {
  const r = await ts('serve', '--bg', `--https=${SHARE_PORT}`, `http://localhost:${localPort}`);
  if (r.code !== 0) throw new CmdError(`tailscale serve failed: ${r.err || r.out}`, 'enable HTTPS for your tailnet in the Tailscale admin console (DNS → HTTPS certificates)');
  return tailscaleStatus(localPort);
}
