import { createConnection, createServer } from 'node:net';
import { capture, sleep } from './sh.ts';

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRNOTAVAIL')); // no IPv6 here: not a conflict
    s.listen({ port, host, exclusive: true }, () => s.close(() => done(true)));
  });
}

// Free on both stacks: webpack binds 0.0.0.0, Nest binds ::.
export async function isFree(port: number) {
  return (await canListen(port, '0.0.0.0')) && (await canListen(port, '::'));
}

export async function freePort(from: number, taken: Set<number> = new Set()) {
  for (let p = from; p < from + 500; p++) if (!taken.has(p) && (await isFree(p))) return p;
  throw new Error(`no free port in ${from}-${from + 500}`);
}

export function reachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ host, port });
    const end = (ok: boolean) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(timeoutMs, () => end(false));
    sock.once('connect', () => end(true));
    sock.once('error', () => end(false));
  });
}

// Something accepts connections on the port (either stack), without binding it ourselves.
export const listening = async (port: number) => (await reachable('127.0.0.1', port, 400)) || (await reachable('::1', port, 400));

export async function waitHttp(url: string, timeoutMs: number, stillAlive: () => boolean) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillAlive()) return 'died' as const;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return 'ready' as const;
    } catch {
      /* not up yet */
    }
    await sleep(1500);
  }
  return 'timeout' as const;
}

// pid, process group and working dir of whatever listens on a port.
export async function listener(port: number) {
  const r = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { cwd: '/' });
  const pid = Number(r.out.split('\n')[0]);
  if (!pid) return undefined;
  const cwd = (await capture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: '/' })).out.split('\n').find((l) => l.startsWith('n'))?.slice(1);
  const pgid = Number((await capture('ps', ['-o', 'pgid=', '-p', String(pid)], { cwd: '/' })).out);
  return { pid, pgid, cwd };
}
