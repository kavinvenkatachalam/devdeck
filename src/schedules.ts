// Schedules: a command run quietly (no terminal; its output kept in a log) at a time of day, on a cron expression, or
// when a Claude usage limit resets. Kept in ~/.config/devdeck/schedules.json; each run's log in
// ~/.local/state/devdeck/schedules/<id>/<due>.log. Only while devdeck runs: one timer at the top of each minute,
// only while a schedule is on, and it starts nothing until one is due. A time missed while the Mac slept runs when it
// wakes (once, however many were missed).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeAccounts, configDirOf, noteLimits } from './claude.ts';
import { FILE as SETTINGS, expandHome, loadSettings } from './settings.ts';
import { stripAnsi, tail } from './sh.ts';
import { STATE_ROOT } from './state.ts';
import { cleanEnv } from './tmux.ts';

export type When =
  | { kind: 'time'; time: string; days: number[] } // 09:30 on these weekdays (0 = Sunday)
  | { kind: 'cron'; expr: string }
  | { kind: 'reset'; account: string; window: 'fiveHour' | 'week'; quiet?: Quiet };
export type Quiet = { from: string; to: string }; // not between these times (23:00–07:00): a reset then waits for the end
export type Schedule = { id: string; name: string; on: boolean; cmd: string; cwd: string; when: When };
export type Run = { at: number; status: 'ok' | 'failed' | 'running' | 'unknown'; code?: number; ms?: number };

const FILE = join(dirname(SETTINGS), 'schedules.json');
const LOGS = join(STATE_ROOT, 'schedules');
export const KEEP_DAYS = [1, 3, 7]; // how long run logs may be kept (Settings' keepRuns)
const KEEP = 500; // and at most this many per schedule (an every-minute cron makes 1,440 a day)
const MAX_RUN = 60 * 60 * 1000; // a run still going after an hour is stopped
const AFTER_RESET = 60 * 1000; // a minute after a reset, so the new window has surely begun

export function loadSchedules(): Schedule[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}
function save(list: Schedule[]) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(list, null, 2)}\n`);
}

// ---------- cron ----------
// minute hour day-of-month month day-of-week: *, 5, 1-5, 1,3,5, */15, 1-30/2. Day of week 0–7 (0 and 7: Sunday). When
// both days are given, either one matches (as in cron).
type Cron = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; anyDom: boolean; anyDow: boolean };
const FIELDS: [string, number, number][] = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 7]];

function field(src: string, [name, lo, hi]: [string, number, number]) {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron: "${part}" isn't a ${name}`);
    const from = m[1] === '*' ? lo : Number(m[2]);
    const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < lo || to > hi || from > to || step < 1) throw new Error(`cron: ${name} "${part}" is out of ${lo}–${hi}`);
    for (let v = from; v <= to; v += step) out.add(name === 'day of week' && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron: five fields, minute hour day month weekday (like 0 9 * * 1-5)');
  const [min, hour, dom, mon, dow] = f.map((x, i) => field(x, FIELDS[i]));
  return { min, hour, dom, mon, dow, anyDom: f[2] === '*', anyDow: f[4] === '*' };
}

// The first minute after `from` the expression matches (local time), or 0 if none within a year.
export function nextCron(c: Cron, from: number) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= end) {
    const day = c.anyDom || c.anyDow ? c.dom.has(d.getDate()) && c.dow.has(d.getDay()) : c.dom.has(d.getDate()) || c.dow.has(d.getDay());
    if (!c.mon.has(d.getMonth() + 1)) d.setMonth(d.getMonth() + 1, 1), d.setHours(0, 0);
    else if (!day) d.setDate(d.getDate() + 1), d.setHours(0, 0);
    else if (!c.hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0);
    else if (!c.min.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1);
    else return d.getTime();
  }
  return 0;
}

const cronOf = (w: When) => (w.kind === 'cron' ? w.expr : w.kind === 'time' ? `${Number(w.time.split(':')[1])} ${Number(w.time.split(':')[0])} * * ${w.days.join(',')}` : '');

// ---------- when each one is due ----------
const next = new Map<string, number>(); // id → next time (time and cron), worked out once and again after each run
const resets = new Map<string, number>(); // id → the reset it waits for: kept, since Claude's reading of it lapses at the reset

// The next time a schedule is due, or why it can't be said.
function dueOf(s: Schedule, accounts = claudeAccounts()): { at?: number; why?: string } {
  if (s.when.kind !== 'reset') {
    if (!next.has(s.id)) next.set(s.id, nextCron(parseCron(cronOf(s.when)), Date.now()));
    return next.get(s.id) ? { at: next.get(s.id) } : { why: 'Never: no such date' };
  }
  const { account, window } = s.when;
  const a = accounts.find((x) => x.account === account);
  const w = a?.[window];
  if (w) resets.set(s.id, w.resetsAt);
  const at = resets.get(s.id);
  if (at) return { at: afterQuiet(at + AFTER_RESET, s.when.quiet) };
  if (!a) return { why: `${account} isn't signed in to Claude on this Mac` };
  if (!a.connected) return { why: 'Connect Claude usage for this account (the Overview\'s Claude usage card) so devdeck knows when it resets' };
  return { why: 'Waiting to learn the next reset: it shows once Claude is used on this account' };
}

// The time, or if that falls in the quiet hours, their end.
export function afterQuiet(at: number, q?: Quiet) {
  if (!q) return at;
  const mins = (t: string) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  const [from, to] = [mins(q.from), mins(q.to)];
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  if (!(from <= to ? m >= from && m < to : m >= from || m < to)) return at;
  // the next `to` on the clock: today, or tomorrow when it's past
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (m >= to ? 1 : 0), Math.floor(to / 60), to % 60);
  return end.getTime();
}

// ---------- runs ----------
const running = new Map<string, number>(); // id → the run's due time, while it runs in this devdeck
const logOf = (id: string, at: number) => join(LOGS, id, `${at}.log`);
const FOOT = /\n\[devdeck\] exit (-?\d+|signal \w+) after (\d+) ms\n?$/;

// Runs a schedule for the time it was due. Every devdeck on this Mac (the app's and a dev copy, say) shares the
// schedules; the first to create the run's log runs it, so it runs once.
function fire(s: Schedule, at: number, why: string) {
  if (running.has(s.id)) return false; // the last run is still going
  mkdirSync(join(LOGS, s.id), { recursive: true });
  let fd: number;
  try {
    fd = openSync(logOf(s.id, at), 'wx');
  } catch {
    return false; // run already, by this devdeck or another
  }
  const cwd = expandHome(s.cwd || '~');
  writeSync(fd, `$ ${s.cmd}\n[devdeck] ${why}, in ${s.cwd || '~'}, ${new Date().toString()}\n\n`);
  running.set(s.id, at);
  const started = Date.now();
  // Your login shell, interactive, so the command finds what a terminal would (PATH, aliases, functions), with no
  // terminal attached. What the shell's startup prints (prompt themes complain without a terminal) is dropped: the
  // log gets only the command's output, on fd 3.
  const shell = /\/(zsh|bash)$/.test(process.env.SHELL || '') ? process.env.SHELL! : '/bin/zsh';
  const p = spawn(shell, ['-ilc', 'exec 1>&3 2>&3 3>&-; eval "$DEVDECK_CMD"'], {
    cwd: existsSync(cwd) ? cwd : homedir(),
    // waiting on an account's limit: Claude runs signed in as that account
    env: { ...cleanEnv(), TERM: 'dumb', DEVDECK_CMD: s.cmd, ...(s.when.kind === 'reset' && configDirOf(s.when.account) ? { CLAUDE_CONFIG_DIR: configDirOf(s.when.account) } : {}) },
    stdio: ['ignore', 'ignore', 'ignore', fd],
    detached: true,
  });
  const stop = setTimeout(() => { try { process.kill(-p.pid!, 'SIGTERM'); } catch {} }, MAX_RUN);
  const done = (code: string) => {
    clearTimeout(stop);
    running.delete(s.id);
    try {
      writeSync(fd, `\n[devdeck] exit ${code} after ${Date.now() - started} ms\n`);
      closeSync(fd);
    } catch {}
    pruneRuns();
    if (s.when.kind === 'reset') learnLimits(s.when.account, logOf(s.id, at));
  };
  p.on('error', (e) => { try { writeSync(fd, `${e.message}\n`); } catch {} done('127'); });
  p.on('exit', (code, signal) => done(signal ? `signal ${signal}` : String(code)));
  return true;
}

// Run logs older than the days Settings keeps them, or past the most kept per schedule, go: when a run ends, when
// devdeck starts and when the setting changes (nothing looks in between).
export function pruneRuns() {
  const days = loadSettings().keepRuns;
  const before = Date.now() - (KEEP_DAYS.includes(days) ? days : 7) * 864e5;
  for (const id of loadSchedules().map((s) => s.id))
    timesOf(id).forEach((at, i) => (at < before || i >= KEEP) && running.get(id) !== at && rmSync(logOf(id, at), { force: true }));
}

// a schedule's run times, newest first
function timesOf(id: string) {
  try {
    return readdirSync(join(LOGS, id)).map((n) => Number(/^(\d+)\.log$/.exec(n)?.[1])).filter((at) => at > 0).sort((a, b) => b - a);
  } catch {
    return [];
  }
}

// a run's result, from its log's last line
function runOf(id: string, at: number): Run {
  if (running.get(id) === at) return { at, status: 'running' };
  const m = FOOT.exec(tail(logOf(id, at), 2));
  if (!m) return { at, status: 'unknown' };
  return { at, status: m[1] === '0' ? 'ok' : 'failed', code: /^-?\d+$/.test(m[1]) ? Number(m[1]) : undefined, ms: Number(m[2]) };
}

// a schedule's runs, newest first
export const runsOf = (id: string, limit = Infinity) => timesOf(id).slice(0, limit).map((at) => runOf(id, at));

// Claude's detailed output (claude -p … --output-format stream-json --verbose) says when the window it ran in resets,
// which its plain output doesn't. Read once, when a limit-reset run ends: the next run then needs no terminal Claude.
const LIMIT_EVENT = '"type":"rate_limit_event"';
function learnLimits(account: string, file: string) {
  let last = '';
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.includes(LIMIT_EVENT)) last = line;
    if (last) noteLimits(account, JSON.parse(last).rate_limit_info?.unifiedWindows ?? {});
  } catch {}
}

// That detailed output, shown as its reply and the limits it reported; any other output as it is.
function readable(line: string) {
  if (!line.startsWith('{"type":"')) return line;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return line;
  }
  if (e.type === 'result') return String(e.result ?? '');
  if (e.type !== 'rate_limit_event') return null;
  const w = e.rate_limit_info?.unifiedWindows?.five_hour;
  return w ? `[Claude] 5-hour limit: ${Math.round(w.utilization * 100)}% used, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : null;
}

export function runLog(id: string, at: number) {
  const file = logOf(id, at);
  if (!existsSync(file)) return null;
  const lines = stripAnsi(tail(file, 500)).replace(FOOT, '\n').split('\n');
  return lines.map(readable).filter((l) => l !== null).join('\n');
}

// ---------- the timer ----------
let timer: NodeJS.Timeout | undefined;
let wakeAt = 0; // when the timer should go off, on the clock
function arm() {
  clearTimeout(timer);
  timer = undefined;
  const on = loadSchedules().filter((s) => s.on);
  if (!on.length) return;
  // each one's next time, worked out now (later would skip one due before then)
  const accounts = claudeAccounts();
  for (const s of on) try { dueOf(s, accounts); } catch {}
  // the top of the next minute, or a reset due sooner
  const now = Date.now();
  const wait = Math.max(500, Math.min(60_000 - (now % 60_000) + 500, ...[...resets.values()].map((r) => r + AFTER_RESET - now)));
  wakeAt = now + wait;
  timer = setTimeout(tick, wait);
  timer.unref();
}

// A timer counts only the time the Mac is awake, so after a sleep it can be a minute late. Any request (the page asks
// as soon as the lid opens) checks the clock: past due, it goes off now.
export function catchUp() {
  if (timer && Date.now() > wakeAt + 1000) tick();
}

function tick() {
  const now = Date.now();
  const accounts = claudeAccounts();
  for (const s of loadSchedules()) {
    if (!s.on) continue;
    let due: { at?: number };
    try {
      due = dueOf(s, accounts);
    } catch {
      continue;
    }
    if (!due.at || due.at > now) continue;
    // late (the Mac slept through it): once, now, for the time it was due
    fire(s, due.at, s.when.kind === 'reset' ? `Claude's ${s.when.window === 'week' ? 'weekly' : '5-hour'} limit reset` : 'scheduled');
    if (s.when.kind === 'reset') resets.delete(s.id);
    else next.set(s.id, nextCron(parseCron(cronOf(s.when)), now));
  }
  arm();
}

export function startSchedules() {
  pruneRuns();
  arm();
}

// ---------- the API's side ----------
function clean(b: any, id: string): Schedule {
  const cmd = String(b.cmd ?? '').trim();
  if (!cmd) throw new Error('a command is needed');
  const w = b.when ?? {};
  let when: When;
  if (w.kind === 'time') {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(w.time))) throw new Error('pick a time');
    const days = [...new Set<number>((Array.isArray(w.days) ? w.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
    if (!days.length) throw new Error('pick at least one day');
    when = { kind: 'time', time: w.time, days };
  } else if (w.kind === 'cron') {
    parseCron(String(w.expr ?? ''));
    when = { kind: 'cron', expr: String(w.expr).trim().replace(/\s+/g, ' ') };
  } else if (w.kind === 'reset') {
    if (!w.account) throw new Error('pick a Claude account');
    when = { kind: 'reset', account: String(w.account), window: w.window === 'week' ? 'week' : 'fiveHour' };
    if (w.quiet) {
      const ok = (t: any) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t));
      if (!ok(w.quiet.from) || !ok(w.quiet.to) || w.quiet.from === w.quiet.to) throw new Error('pick the hours it should not run');
      when.quiet = { from: w.quiet.from, to: w.quiet.to };
    }
  } else throw new Error('pick when it runs');
  return { id, name: String(b.name ?? '').trim() || cmd.split('\n')[0].slice(0, 60), on: b.on !== false, cmd, cwd: String(b.cwd ?? '').trim() || '~', when };
}

const forget = (id: string) => { next.delete(id); resets.delete(id); };

export function addSchedule(b: unknown) {
  const s = clean(b, randomUUID().slice(0, 8));
  save([...loadSchedules(), s]);
  arm();
  return s;
}

export function updateSchedule(id: string, b: any) {
  const list = loadSchedules();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) throw new Error('no such schedule');
  list[i] = clean({ ...list[i], ...b }, id);
  forget(id);
  save(list);
  arm();
  return list[i];
}

export function removeSchedule(id: string) {
  const list = loadSchedules();
  if (!list.some((s) => s.id === id)) throw new Error('no such schedule');
  save(list.filter((s) => s.id !== id));
  forget(id);
  rmSync(join(LOGS, id), { recursive: true, force: true });
  arm();
}

export function runNow(id: string) {
  const s = loadSchedules().find((x) => x.id === id);
  if (!s) throw new Error('no such schedule');
  if (!fire(s, Date.now(), 'run by hand')) throw new Error('it is still running');
}

// The next few times a "when" comes round, to check one before saving it.
export function preview(w: any) {
  const s = clean({ cmd: 'x', when: w }, '');
  if (s.when.kind === 'reset') return [];
  const c = parseCron(cronOf(s.when));
  const out: number[] = [];
  for (let at = Date.now(); out.length < 3 && (at = nextCron(c, at)); ) out.push(at);
  return out;
}

// Every schedule's runs, newest first
export function runHistory(limit = 200) {
  const all = loadSchedules().flatMap((s) => timesOf(s.id).map((at) => ({ s, at })));
  return all
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ s, at }) => ({ ...runOf(s.id, at), id: s.id, name: s.name }));
}

export function scheduleList() {
  const accounts = claudeAccounts();
  return {
    schedules: loadSchedules().map((s) => {
      let due: { at?: number; why?: string };
      try {
        due = s.on ? dueOf(s, accounts) : {};
      } catch (e) {
        due = { why: (e as Error).message };
      }
      return { ...s, next: due.at ?? null, why: due.why ?? null, last: runsOf(s.id, 1)[0] ?? null };
    }),
    accounts: accounts.map((a) => ({ account: a.account, connected: a.connected })),
  };
}
