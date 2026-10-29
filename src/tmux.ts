import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT } from './state.ts';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// devdeck owns its own tmux server, so it never touches HexoKit's or the user's sessions.
export const SOCKET = 'devdeck';
export const CONF = join(import.meta.dirname, '..', 'tmux.conf');

// Viewer sessions are grouped copies (one per browser tab) so each client can show its own window.
export const VIEWER_SEP = '~';

// For Claude / Codex: what the agent is doing, read off its screen.
export type Agent = 'working' | 'waiting' | 'idle';
// A session is one terminal: one tmux window (`tabs` always holds just that one).
// choices: the numbered options of a prompt that needs you ("1. Yes", "3. No…"), for one-tap replies.
export type Tab = { id: string; index: number; program: string; busy: boolean; active: boolean; agent?: Agent; choices?: string[] };

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh']);

// What runs in the tab, as a label. Claude's native build reports its version (2.1.311) as the command.
function program(command: string) {
  const c = command.replace(/^-/, '');
  return /^\d+\.\d+\.\d+/.test(c) ? 'claude' : c;
}

// folder: the sidebar folder it sits in ('' = loose); order: its place there (0 = by creation). Both are
// session options, so they follow a rename and every device sees the same tree. activity: last output in any tab.
export type Session = { name: string; path: string; created: number; activity: number; folder: string; order: number; tabs: Tab[] };

// Panes start as login shells, which rebuild the rest from the user's dotfiles. Passing only these keeps
// whatever launched devdeck (a Claude session, a test run) out of the terminals: no CLAUDE_CONFIG_DIR etc.
const KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'];
const kept = (k: string) => KEEP.includes(k) || k.startsWith('LC_');

export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };
  for (const [k, v] of Object.entries(process.env)) if (kept(k)) env[k] = v;
  return env;
}

export const tmuxArgs = (...args: string[]) => ['-L', SOCKET, '-f', CONF, ...args];

export async function tmux(...args: string[]) {
  const { stdout } = await exec('tmux', tmuxArgs(...args), { env: cleanEnv() });
  return stdout;
}

// A tmux server started before this fix still carries the old environment; scrub it for new panes.
export async function scrubServerEnv() {
  let out: string;
  try {
    out = await tmux('show-environment', '-g');
  } catch {
    return; // no server yet; it will start clean
  }
  for (const line of out.split('\n')) {
    const k = line.replace(/^-/, '').split('=')[0];
    if (k && !kept(k) && k !== 'TERM') await tmux('set-environment', '-g', '-u', k).catch(() => {});
  }
}

const rows = (out: string) => out.split('\n').filter(Boolean).map((l) => l.split('\t'));

export async function listSessions(): Promise<Session[]> {
  let s: string, w: string;
  try {
    s = await tmux('list-sessions', '-F', '#{session_name}\t#{@dd_path}\t#{session_created}\t#{@dd_folder}\t#{@dd_order}');
    w = await tmux('list-windows', '-a', '-F', '#{session_name}\t#{window_id}\t#{window_index}\t#{pane_current_command}\t#{window_active}\t#{window_activity}\t#{pane_tty}');
  } catch {
    return []; // no server yet
  }
  const sessions = rows(s)
    .filter(([name, path]) => path && !name.includes(VIEWER_SEP)) // only ours: other tools (rk's _rk-ctl) add sessions too
    .map(([name, path, created, folder, order]): Session => ({ name, path, created: Number(created), activity: Number(created), folder: folder || '', order: Number(order) || 0, tabs: [] }));
  const byName = new Map(sessions.map((x) => [x.name, x]));
  const ttys = new Map<string, Tab>(); // shells, whose real foreground program is looked up below
  for (const [sess, id, index, command, active, activity, tty] of rows(w)) {
    const p = program(command);
    const x = byName.get(sess);
    if (!x) continue;
    x.activity = Math.max(x.activity, Number(activity) || 0);
    const tab: Tab = { id, index: Number(index), program: p, busy: !SHELLS.has(p), active: active === '1' };
    x.tabs.push(tab);
    if (SHELLS.has(p) && tty) ttys.set(tty.replace('/dev/', ''), tab);
  }
  await foreground(ttys);
  return sessions.sort((a, b) => a.created - b.created);
}

// tmux names a pane after its foreground process group's leader. An alias that runs Claude from a login shell
// (zsh -lc 'claude …') leaves that leader a shell, so for shells ask ps what really runs in front: one call for all.
async function foreground(ttys: Map<string, Tab>) {
  if (!ttys.size) return;
  let out = '';
  try {
    out = (await exec('ps', ['-o', 'tty=,stat=,comm=', '-t', [...ttys.keys()].join(',')])).stdout;
  } catch {
    return; // keep tmux's names
  }
  const front = new Map<string, string[]>();
  for (const line of out.split('\n')) {
    const [tty, stat, ...comm] = line.trim().split(/\s+/);
    if (stat?.includes('+') && comm.length) front.set(tty, [...(front.get(tty) ?? []), program(comm.join(' ').split('/').pop() || '')]);
  }
  for (const [tty, tab] of ttys) {
    const progs = (front.get(tty) ?? []).filter((x) => !SHELLS.has(x) && x !== 'caffeinate');
    const p = progs.find((x) => AGENTS.has(x)) ?? progs[0];
    if (p) Object.assign(tab, { program: p, busy: true });
  }
}

// Both TUIs show a working line while a turn runs (see WORKING), and a numbered prompt when they
// need you (Claude: "Do you want to proceed?" / question pickers; Codex: "Yes, proceed" / "Would you like to run…").
const AGENTS = new Set(['claude', 'codex']);
const WAITING = /Do you want to proceed\?|Would you like to (proceed|run)|Enter to select|Yes, proceed|Yes, just this once/;
// Codex (and older Claude) say "esc to interrupt"; Claude now shows a spinner line: "✢ Doodling… (2m 11s · …)".
// Done, it reads "✻ Cooked for 3m 2s" (no … and no bracket), so that's idle.
const WORKING = /esc to interrupt|^\s*[·✢✳✶✻✽*∗]\s+\S[^\n]*…\s+\(/im;

// "❯ 1. Yes" / "  2. Yes, and don't ask again…" / "› 1. Yes, proceed (y)"
const CHOICE = /^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+?)\s*$/;

async function agentState(windowId: string): Promise<Pick<Tab, 'agent' | 'choices'>> {
  try {
    return readAgent(await tmux('capture-pane', '-p', '-t', windowId));
  } catch {
    return {};
  }
}

// Claude's input box: a ─── rule, the "❯ " line you type in, a ─── rule. While it's on screen nothing is being
// asked, and only the status line right above it (the first unindented line, past tips and to-dos) says whether
// a turn runs. The conversation above can quote "esc to interrupt" or "Do you want to proceed?"; it doesn't count.
const RULE = /^\s*─{10,}\s*$/;
const INPUT = /^\s*❯(?!\s*\d\.)/; // not "❯ 1. Yes": that's a prompt's choice, not the input line
const SPINNER = /^[·✢✳✶✻✽*∗]\s+\S.*…\s+\(/;
function claudeBox(all: string[]): Agent | undefined {
  const rules = all.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  for (let k = rules.length - 1; k > 0; k--) {
    const [top, end] = [rules[k - 1], rules[k]];
    if (!all.slice(top + 1, end).some((l) => INPUT.test(l))) continue;
    for (let i = top - 1; i >= 0; i--) {
      const l = all[i];
      if (!l.trim() || /^\s/.test(l)) continue; // blank, or a tip / to-do / wrapped text under the status line
      return SPINNER.test(l) ? 'working' : 'idle';
    }
    return 'idle';
  }
  return undefined;
}

export function readAgent(screen: string): Pick<Tab, 'agent' | 'choices'> {
  const all = screen.trimEnd().split('\n');
  const box = claudeBox(all);
  if (box) return { agent: box };
  // no input box (a prompt replaced it, or Codex): read the bottom of the screen
  const lines = all.slice(-25);
  const bottom = lines.join('\n');
  if (!WAITING.test(bottom)) return { agent: WORKING.test(bottom) ? 'working' : 'idle' };
  // the prompt's options, numbered 1, 2, 3… in order (anything else on screen with a number is ignored)
  const choices: string[] = [];
  for (const l of lines) {
    const m = CHOICE.exec(l.replace(/│/g, ''));
    if (m && Number(m[1]) === choices.length + 1) choices.push(m[2].slice(0, 60));
    else if (m && m[1] === '1') choices.splice(0, choices.length, m[2].slice(0, 60));
  }
  return { agent: 'waiting', choices: choices.slice(0, 6) };
}

export async function withAgents(sessions: Session[]) {
  await Promise.all(sessions.flatMap((s) => s.tabs.filter((t) => AGENTS.has(t.program)).map(async (t) => Object.assign(t, await agentState(t.id)))));
  return sessions;
}

// A one-tap reply to a prompt: an option's number, or Escape to cancel.
export const reply = (windowId: string, key: string) => tmux('send-keys', '-t', windowId, key);

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Tabs are plain terminals; tmux names each one after whatever runs in it (zsh, claude, codex…).
export async function createSession(name: string, path: string, folder = '') {
  logSession(`create ${name} in ${path}${folder ? ` [${folder}]` : ''}`);
  await tmux('new-session', '-d', '-s', name, '-c', path);
  await tmux('set-option', '-t', name, '@dd_path', path);
  if (folder) await tmux('set-option', '-t', name, '@dd_folder', folder);
}

// Point a session at another folder: devdeck's views (changes, code, env) follow at once. An idle shell also cds
// there; a running program (an agent, a server) keeps its own folder, so false says it needs a restart there.
export async function moveSession(s: Session, path: string) {
  logSession(`move ${s.name} from ${s.path} to ${path}`);
  await tmux('set-option', '-t', s.name, '@dd_path', path);
  const t = s.tabs[0];
  if (!t || t.busy) return false;
  await tmux('send-keys', '-t', t.id, 'C-u'); // whatever was half-typed
  await tmux('send-keys', '-t', t.id, '-l', `cd '${path.replace(/'/g, `'\\''`)}'`);
  await tmux('send-keys', '-t', t.id, 'Enter');
  return true;
}

export const setFolder = (session: string, folder: string) =>
  folder ? tmux('set-option', '-t', session, '@dd_folder', folder) : tmux('set-option', '-u', '-t', session, '@dd_folder');

export async function orderSessions(names: string[]) {
  for (const [i, n] of names.entries()) await tmux('set-option', '-t', n, '@dd_order', String(i + 1));
}

// One terminal per session: extra windows (tabs from an older devdeck, or tmux's own new-window) become
// sessions of their own, next to the original, in the same folder. Returns whether anything moved.
export async function oneTerminalEach(sessions: Session[]) {
  const names = new Set(sessions.map((s) => s.name));
  let moved = false;
  for (const s of sessions)
    for (const t of s.tabs.slice(1)) {
      let name = '';
      for (let i = 2; names.has((name = `${s.name}-${i}`)); i++);
      names.add(name);
      logSession(`split ${t.id} out of ${s.name} into ${name}`);
      const blank = (await tmux('new-session', '-d', '-P', '-F', '#{window_id}', '-s', name, '-c', s.path)).trim();
      await tmux('set-option', '-t', name, '@dd_path', s.path);
      if (s.folder) await tmux('set-option', '-t', name, '@dd_folder', s.folder);
      await tmux('move-window', '-d', '-s', t.id, '-t', `${name}:`);
      await tmux('kill-window', '-t', blank);
      moved = true;
    }
  return moved;
}

export const renameSession = (from: string, to: string) => tmux('rename-session', '-t', from, to);

// Every session devdeck creates, splits or ends, with why: ~/.local/state/devdeck/sessions.log
export function logSession(what: string) {
  try {
    mkdirSync(STATE_ROOT, { recursive: true });
    appendFileSync(join(STATE_ROOT, 'sessions.log'), `${new Date().toISOString()} ${what}\n`);
  } catch {}
}

export async function killSession(name: string, why: string) {
  logSession(`end ${name} (${why})`);
  const all = rows(await tmux('list-sessions', '-F', '#{session_name}')).map(([n]) => n);
  for (const n of all) if (n === name || n.startsWith(name + VIEWER_SEP)) await tmux('kill-session', '-t', n).catch(() => {});
}
