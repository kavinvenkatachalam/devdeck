// Claude's usage limits (the 5-hour and weekly windows) for each Claude subscription on this Mac, live. Claude Code
// passes them to its status line as rate_limits; Connect puts bin/devdeck-statusline in front of a config's status line
// to save them, and the status line that was there keeps showing. Disconnect puts it back. API-key accounts have no
// such limits and aren't listed.
import { closeSync, existsSync, type FSWatcher, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { STATE_ROOT } from './state.ts';

// Homebrew's stable opt/ path, not the version's own folder (an upgrade deletes it): Claude keeps running this.
const BIN = join(import.meta.dirname, '..', 'bin', 'devdeck-statusline').replace(/\/Cellar\/devdeck\/[^/]+\//, '/opt/devdeck/');
const DIR = join(STATE_ROOT, 'claude');
const PLANS: Record<string, string> = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };

type Config = { key: string; dir: string; state: string; settings: string };
type Window = { used: number; resetsAt: number };

// Every Claude config on this Mac: ~/.claude (its state is ~/.claude.json), $CLAUDE_CONFIG_DIR, and ~/.claude-*/ dirs
// (a second account usually lives in one, e.g. ~/.claude-personal).
function configs(): Config[] {
  const home = homedir();
  const dirs = new Set([join(home, '.claude')]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(resolve(process.env.CLAUDE_CONFIG_DIR));
  for (const n of readdirSync(home)) if (n.startsWith('.claude') && statSync(join(home, n), { throwIfNoEntry: false })?.isDirectory()) dirs.add(join(home, n));
  return [...dirs]
    .map((dir) => {
      const own = join(dir, '.claude.json');
      const state = !existsSync(own) && dir === join(home, '.claude') ? join(home, '.claude.json') : own;
      return { key: basename(dir).replace(/[^\w.-]/g, '_'), dir, state, settings: join(dir, 'settings.json') };
    })
    .filter((c) => existsSync(c.state));
}

// a JSON file, re-read only when it changes (Claude's state file is ~100 KB and this is polled)
const seen = new Map<string, { mtime: number; value: any }>();
function readJson(file: string) {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st) return { value: null, mtime: 0 };
  const c = seen.get(file);
  if (c?.mtime === st.mtimeMs) return c;
  let value = null;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  const out = { mtime: st.mtimeMs, value };
  seen.set(file, out);
  return out;
}

// Where the Claude in a tmux pane works now: the folder its tools last ran in (it cds into a worktree it made, say),
// which its own process never shows. Claude keeps <config>/sessions/<pid>.json (its pane included) while it runs,
// and its transcript notes the folder on every message. start: the folder it was started in.
const tails = new Map<string, { size: number; cwd?: string }>();
export function claudeWorkDir(pane: string): { start: string; now: string } | undefined {
  const alive = (pid: number) => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  for (const c of configs()) {
    const dir = join(c.dir, 'sessions');
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    const s = names
      .map((n) => readJson(join(dir, n)).value)
      .filter((v) => typeof v?.tmux === 'string' && v.tmux.endsWith(`.${pane}`) && v.sessionId && v.cwd && alive(v.pid))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (!s) continue;
    const file = join(c.dir, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${s.sessionId}.jsonl`);
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const seen = tails.get(file);
    if (seen?.size === size) return seen.cwd ? { start: s.cwd, now: seen.cwd } : undefined;
    // the last 64 KB holds the last few messages
    let cwd: string | undefined;
    if (size) {
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size, 65536));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      closeSync(fd);
      for (const m of buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) cwd = JSON.parse(`"${m[1]}"`);
    }
    tails.set(file, { size, cwd });
    return cwd ? { start: s.cwd, now: cwd } : undefined;
  }
}

const ours = (statusLine: any) => typeof statusLine?.command === 'string' && statusLine.command.includes('devdeck-statusline');

// Each Claude config signed in to a plan (not an API key).
function subscribed() {
  const now = Date.now();
  return configs().flatMap((c) => {
    const a = readJson(c.state).value?.oauthAccount;
    if (!a || !(PLANS[a.organizationType] || /subscription/.test(a.billingType ?? ''))) return [];
    const connected = ours(readJson(c.settings).value?.statusLine);
    const saved = connected ? readJson(join(DIR, `${c.key}.json`)) : null;
    const win = (w: any): Window | undefined =>
      typeof w?.used_percentage === 'number' && w.resets_at * 1000 > now ? { used: w.used_percentage, resetsAt: w.resets_at * 1000 } : undefined;
    const limits = saved?.value?.rate_limits;
    return [{
      key: c.key,
      account: (a.emailAddress || a.displayName || basename(c.dir)) as string,
      plan: PLANS[a.organizationType] || 'Subscription',
      connected,
      at: saved?.mtime || 0,
      fiveHour: win(limits?.five_hour),
      week: win(limits?.seven_day),
    }];
  });
}

// One entry per account (an account can be signed in in several configs, each with its own status line), connected
// when all its configs are. Each config's numbers are from its own last reply, so an idle one's are old: per window,
// the reading with the latest reset time wins, then the highest use (use only grows until the window resets).
export function claudeAccounts() {
  const by = new Map<string, ReturnType<typeof subscribed>>();
  for (const c of subscribed()) by.set(c.account, [...(by.get(c.account) ?? []), c]);
  const freshest = (ws: (Window | undefined)[]) =>
    ws.filter((w): w is Window => !!w).reduce<Window | undefined>((a, b) => (!a || b.resetsAt > a.resetsAt || (b.resetsAt === a.resetsAt && b.used > a.used) ? b : a), undefined);
  return [...by.entries()].map(([account, cs]) => ({
    account,
    plan: cs[0].plan,
    connected: cs.every((c) => c.connected),
    at: Math.max(...cs.map((c) => c.at)),
    fiveHour: freshest(cs.map((c) => c.fiveHour)),
    week: freshest(cs.map((c) => c.week)),
  }));
}

// Pushed, not polled: one watcher on the saved numbers (no timer) while any page listens; Claude writing new ones
// tells every listener, once the writes settle.
const listeners = new Set<() => void>();
let watcher: FSWatcher | null = null;
let settle: NodeJS.Timeout | undefined;
export function onUsageChange(fn: () => void) {
  listeners.add(fn);
  if (!watcher) {
    mkdirSync(DIR, { recursive: true });
    watcher = watch(DIR, () => {
      clearTimeout(settle);
      settle = setTimeout(() => listeners.forEach((f) => f()), 300);
    });
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      clearTimeout(settle);
      watcher?.close();
      watcher = null;
    }
  };
}

// Connect or disconnect every config signed in to the account.
export function setUsage(account: string, on: boolean) {
  const keys = subscribed().filter((c) => c.account === account).map((c) => c.key);
  if (!keys.length) throw new Error(`no Claude subscription signed in as ${account}`);
  for (const k of keys) (on ? connectUsage : disconnectUsage)(k);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function settingsOf(key: string) {
  const c = configs().find((x) => x.key === key);
  if (!c) throw new Error(`no Claude config "${key}"`);
  const raw = existsSync(c.settings) ? readFileSync(c.settings, 'utf8') : '{}';
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    throw new Error(`${c.settings} isn't plain JSON, so devdeck won't rewrite it`);
  }
  // written whole, then moved into place: Claude never reads half a file
  const save = (next: object) => {
    writeFileSync(`${c.settings}.devdeck-tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${c.settings}.devdeck-tmp`, c.settings);
  };
  return { c, raw, s, save };
}

// Put devdeck in front of the config's status line. What was there is kept in DIR and still runs after it, and a copy
// of settings.json as it was is kept next to it.
function connectUsage(key: string) {
  const { c, raw, s, save } = settingsOf(key);
  if (ours(s.statusLine)) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${c.key}.settings-before.json`), raw);
  writeFileSync(join(DIR, `${c.key}.statusline`), s.statusLine?.type === 'command' && typeof s.statusLine.command === 'string' ? s.statusLine.command : '');
  save({ ...s, statusLine: { ...(s.statusLine ?? {}), type: 'command', command: `bash ${shq(BIN)} ${shq(DIR)} ${shq(c.key)}` } });
}

// Back to the status line from before (or none).
function disconnectUsage(key: string) {
  const { c, s, save } = settingsOf(key);
  if (!ours(s.statusLine)) return;
  const before = existsSync(join(DIR, `${c.key}.statusline`)) ? readFileSync(join(DIR, `${c.key}.statusline`), 'utf8') : '';
  const { statusLine, ...rest } = s;
  save(before ? { ...rest, statusLine: { ...statusLine, command: before } } : rest);
}
