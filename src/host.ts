// Mac health for the status bar: CPU load, memory in use (as Activity Monitor counts it), disk.
import { cpus, hostname, loadavg, totalmem, uptime } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './sh.ts';

const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string;
let cached: { at: number; value: unknown } | undefined;

// os.freemem() on macOS leaves out cached/purgeable pages; vm_stat's active + wired + compressed is "memory used".
async function memUsed() {
  const r = await capture('vm_stat', [], { cwd: '/' });
  const page = Number(/page size of (\d+)/.exec(r.out)?.[1] || 16384);
  const n = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(r.out)?.[1] || 0);
  const used = (n('Pages active') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
  return used || totalmem() - (await import('node:os')).freemem();
}

async function disk() {
  const r = await capture('df', ['-k', process.platform === 'darwin' ? '/System/Volumes/Data' : '/'], { cwd: '/' });
  const f = r.out.split('\n')[1]?.split(/\s+/);
  return f ? { used: Number(f[2]) * 1024, total: Number(f[1]) * 1024 } : undefined;
}

export async function hostStats() {
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  const value = {
    host: hostname().replace(/\.local$/, ''),
    version: VERSION,
    cpu: Math.min(100, Math.round((loadavg()[0] / cpus().length) * 100)),
    load: loadavg().map((x) => Math.round(x * 100) / 100),
    mem: { used: await memUsed(), total: totalmem() },
    disk: await disk(),
    uptime: Math.round(uptime()),
  };
  cached = { at: Date.now(), value };
  return value;
}
