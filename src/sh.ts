// Subprocesses. Long commands log to a file and stream each line to the caller (a job's live log).
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

type RunOpts = { cwd: string; env?: NodeJS.ProcessEnv };

export class CmdError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

// Capture output; for queries (git, ps, lsof). Never throws on exit code.
export function capture(cmd: string, args: string[], opts: RunOpts): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => done({ code: 127, out, err: e.message }));
    p.on('close', (code) => done({ code: code ?? 1, out: out.trim(), err: err.trim() }));
  });
}

export async function git(cwd: string, ...args: string[]) {
  const r = await capture('git', args, { cwd });
  if (r.code !== 0) throw new CmdError(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

// The last n lines, reading only the end of the file (server logs grow to tens of MB).
export function tail(file: string, n = 30): string {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(64 * 1024, n * 400));
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').trimEnd().split('\n');
    return (len < size ? lines.slice(1) : lines).slice(-n).join('\n'); // the first line may be cut off
  } finally {
    closeSync(fd);
  }
}

// Colour and cursor codes, for showing a terminal's log as plain text.
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g, '');

export function run(label: string, cmd: string, args: string[], opts: RunOpts & { log: string; onLine?: (l: string) => void }): Promise<void> {
  mkdirSync(dirname(opts.log), { recursive: true });
  appendFileSync(opts.log, `\n$ ${cmd} ${args.join(' ')}  (cwd ${opts.cwd})\n`);
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let partial = '';
    const onData = (d: Buffer) => {
      appendFileSync(opts.log, d);
      const lines = (partial + d.toString()).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.onLine?.(l);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => fail(new CmdError(`${label} failed: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? done() : fail(new CmdError(`${label} failed (exit ${code})`, `full log: ${opts.log}`))));
  });
}

// Long-running service: own process group, output to its log, survives devdeck restarting.
export function startDetached(cmd: string, args: string[], opts: RunOpts & { log: string }): number {
  mkdirSync(dirname(opts.log), { recursive: true });
  appendFileSync(opts.log, `\n$ ${cmd} ${args.join(' ')}  (cwd ${opts.cwd}, ${new Date().toISOString()})\n`);
  const fd = openSync(opts.log, 'a');
  const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  p.unref();
  if (!p.pid) throw new CmdError(`could not start ${cmd}`);
  return p.pid;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function procStart(pid: number) {
  return (await capture('ps', ['-o', 'lstart=', '-p', String(pid)], { cwd: '/' })).out;
}

// pid alone can be reused after a reboot
export async function owned(run: { pid: number; procStart?: string } | undefined) {
  return !!run && alive(run.pid) && (!run.procStart || (await procStart(run.pid)) === run.procStart);
}

export async function killGroup(pid: number, graceMs = 10_000) {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      /* already gone */
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await sleep(250);
  if (alive(pid)) signal('SIGKILL');
}

export async function killPids(pids: number[], graceMs = 5_000) {
  const signal = (s: NodeJS.Signals) => {
    for (const p of pids.filter(alive)) {
      try {
        process.kill(p, s);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < deadline) await sleep(250);
  signal('SIGKILL');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// macOS clones a whole folder in one clonefile(2) call: ~1 s of CPU for 100k files, where cp -cR clones file by
// file (~18 s). Node can't call it, so the system Python does, when it's really there (/usr/bin/python3 without
// the command line tools opens an install dialog). Elsewhere: undefined, and callers copy the usual way.
const CLONE_PY = "import ctypes,sys,os;l=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True);l.clonefile.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint32];sys.exit(0 if l.clonefile(sys.argv[1].encode(),sys.argv[2].encode(),0)==0 else os.strerror(ctypes.get_errno()))";
let clonePython: Promise<string> | undefined;
export function cloneTool() {
  clonePython ??= (async () => {
    if (process.platform !== 'darwin') return '';
    const py = (await capture('which', ['python3'], { cwd: '/' })).out;
    if (!py) return '';
    if (py === '/usr/bin/python3' && (await capture('xcode-select', ['-p'], { cwd: '/' })).code !== 0) return '';
    return py;
  })();
  return clonePython;
}
export async function cloneTree(from: string, to: string) {
  const py = await cloneTool();
  if (!py) return false;
  mkdirSync(dirname(to), { recursive: true });
  return (await capture(py, ['-I', '-c', CLONE_PY, from, to], { cwd: '/' })).code === 0;
}

// Delete a folder in the background at the lowest priority (macOS background QoS: little CPU, throttled disk),
// so removing a worktree's 300k files doesn't load the Mac or devdeck. Detached: it outlives a devdeck restart.
export function deleteInBackground(path: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['taskpolicy', ['-b', 'rm', '-rf', path]] : ['nice', ['-n', '19', 'rm', '-rf', path]];
  const p = spawn(cmd, args, { cwd: '/', stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
}
