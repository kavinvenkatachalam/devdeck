// Who may use devdeck. It runs shells, so every request (pages, API, WebSocket, /code) must be:
// - addressed to a name devdeck answers to: localhost, or the Mac's Tailscale name. A web page that points its own
//   domain at 127.0.0.1 (DNS rebinding) would otherwise pass the same-origin check, since its Origin and Host agree;
// - from this page, not another site open in the browser (Origin, when a browser sends one);
// - over Tailscale, from you: `tailscale serve` adds the visitor's login, and only the Mac's own login gets in, so
//   other people's devices on a shared tailnet don't get a shell.
import { capture } from './sh.ts';
import { cleanEnv } from './tmux.ts';

export type Visitor = { host?: string; origin?: string; login?: string };
export type Allowed = { port: number; tailnet?: { host: string; owner?: string }; extraHosts?: string[] };

const LOCAL = ['127.0.0.1', 'localhost', '[::1]'];

// null when the request may go on, else why not
export function refuse(v: Visitor, a: Allowed): string | null {
  const host = (v.host || '').toLowerCase();
  const local = LOCAL.flatMap((h) => [h, `${h}:${a.port}`]).includes(host) || (a.extraHosts ?? []).includes(host);
  const ts = a.tailnet?.host.toLowerCase();
  const tailnet = !!ts && (host === ts || host.startsWith(`${ts}:`));
  if (!local && !tailnet) return `devdeck doesn't answer to "${v.host || ''}"`;
  if (v.origin) {
    let from = '';
    try {
      from = new URL(v.origin).host.toLowerCase();
    } catch {
      /* "null" or garbage */
    }
    if (from !== host) return 'cross-origin request refused';
  }
  if (tailnet) {
    if (!a.tailnet?.owner) return "can't tell who this Mac's Tailscale user is";
    if ((v.login || '').toLowerCase() !== a.tailnet.owner.toLowerCase()) return `only ${a.tailnet.owner} can use devdeck over Tailscale`;
  }
  return null;
}

// The Mac's Tailscale name and login, asked once a minute (requests read the last answer, never wait for it).
let tailnet: Allowed['tailnet'];
let asked = 0;
export function tailnetIdentity() {
  if (Date.now() - asked > 60_000) {
    asked = Date.now();
    capture('tailscale', ['status', '--json'], { cwd: '/', env: cleanEnv() }).then((r) => {
      try {
        const j = JSON.parse(r.out);
        const host = String(j.Self?.DNSName || '').replace(/\.$/, '');
        tailnet = host ? { host, owner: j.User?.[String(j.Self?.UserID)]?.LoginName } : undefined;
      } catch {
        tailnet = undefined; // not installed, or not running
      }
    });
  }
  return tailnet;
}
