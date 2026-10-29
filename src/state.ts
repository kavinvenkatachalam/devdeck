// Per-checkout state, kept in devdeck's own folder so worktrees stay clean:
// ~/.local/state/devdeck/checkouts/<hash>/{state.json, run/<svc>.json, logs/<name>.log}
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type State = {
  path?: string;
  branch?: string;
  base?: string; // what the branch was created from, for the branch diff
  ports?: { server?: number; frontend?: number };
  dbs?: { dev?: string; tjdbDev?: string };
  deps?: Record<string, string>; // dir → package-lock hash at last install; plugins:build → plugins tree hash
  org?: { id: string; name?: string };
  licensed?: string; // last 4 chars of the key last applied
};

export type RunInfo = { pid: number; procStart?: string; port: number; startedAt: string; log: string };

export const STATE_ROOT = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'devdeck');
const dir = (root: string) => join(STATE_ROOT, 'checkouts', createHash('sha1').update(root).digest('hex').slice(0, 12));

export const logFile = (root: string, name: string) => join(dir(root), 'logs', `${name}.log`);

// Each server start gets a fresh log; the previous run's moves to <name>.<when it was last written>.log and
// the last KEEP_RUNS of those are kept, so yesterday's run is still there and logs don't grow forever.
const KEEP_RUNS = 5;
const runStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[T:]/g, '-');
export function rotateLog(root: string, name: string) {
  const file = logFile(root, name);
  if (!existsSync(file) || statSync(file).size === 0) return;
  renameSync(file, logFile(root, `${name}.${runStamp(statSync(file).mtimeMs)}`));
  for (const old of pastRuns(root, name).slice(KEEP_RUNS)) rmSync(logFile(root, `${name}.${old.id}`), { force: true });
}

// Earlier runs of a log, newest first: { id (the stamp), updated (ms), size }.
export function pastRuns(root: string, name: string) {
  const logs = join(dir(root), 'logs');
  if (!existsSync(logs)) return [];
  const re = new RegExp(`^${name}\\.([\\d-]+)\\.log$`);
  return readdirSync(logs)
    .map((f) => re.exec(f)?.[1])
    .filter((id): id is string => !!id)
    .map((id) => ({ id, ...(({ mtimeMs, size }) => ({ updated: mtimeMs, size }))(statSync(logFile(root, `${name}.${id}`))) }))
    .sort((a, b) => b.updated - a.updated);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export const loadState = (root: string) => readJson<State>(join(dir(root), 'state.json'), {});
export const saveState = (root: string, s: State) => writeJson(join(dir(root), 'state.json'), { ...s, path: root });
export const updateState = (root: string, patch: Partial<State>) => saveState(root, { ...loadState(root), ...patch });

const runFile = (root: string, svc: string) => join(dir(root), 'run', `${svc}.json`);
export const loadRun = (root: string, svc: string) => readJson<RunInfo | undefined>(runFile(root, svc), undefined);
export const saveRun = (root: string, svc: string, info: RunInfo) => writeJson(runFile(root, svc), info);
export const clearRun = (root: string, svc: string) => rmSync(runFile(root, svc), { force: true });
export const forget = (root: string) => rmSync(dir(root), { recursive: true, force: true });

// Ports tj handed out live in the worktree's .tj/state.json; read them so the two tools never collide.
export const tjPorts = (root: string) => readJson<{ ports?: State['ports'] }>(join(root, '.tj', 'state.json'), {}).ports;
export const tjRun = (root: string, svc: string) => readJson<RunInfo | undefined>(join(root, '.tj', 'run', `${svc}.json`), undefined);
