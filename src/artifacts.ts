import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { STATE_ROOT } from './state.ts';
import { tmux, type Session } from './tmux.ts';

const exec = promisify(execFile);

// The claude.ai artifacts (pages, documents) Claude made or opened in a session. Claude keeps a file per running
// process, <config>/sessions/<pid>.json, naming its conversation; devdeck finds the Claude in the session's terminal,
// remembers each conversation it has seen there (so /clear doesn't lose the earlier ones), and reads the artifacts off
// the conversation's log: the Artifact tool's results carry the link and the title. No Claude settings needed.
export type Artifact = { url: string; title: string; at: number };

const ARTIFACT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;

// Claude's config folders (~/.claude, ~/.claude-work…: one per CLAUDE_CONFIG_DIR in use)
const configs = () => readdirSync(homedir()).filter((n) => n.startsWith('.claude')).map((n) => join(homedir(), n)).filter((d) => existsSync(join(d, 'sessions')));

// The log of the conversation a Claude process is on
const logs = new Map<string, string>(); // session id → log path
function logOf(pid: string) {
  for (const dir of configs()) {
    let id: string;
    try {
      id = JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8')).sessionId;
    } catch {
      continue;
    }
    if (!id) continue;
    if (!logs.has(id)) {
      const projects = join(dir, 'projects');
      const hit = existsSync(projects) && readdirSync(projects).map((p) => join(projects, p, `${id}.jsonl`)).find(existsSync);
      if (!hit) continue; // nothing written yet
      logs.set(id, hit);
    }
    return logs.get(id);
  }
}

// window id (@12) → the logs of the conversations seen in it; kept on disk, since a restart of devdeck keeps the terminals
const FILE = join(STATE_ROOT, 'conversations.json');
let seen: Record<string, string[]> | undefined;
const seenLogs = (): Record<string, string[]> => (seen ??= (() => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } })());

// Each log is read once, then only what Claude appended since.
type Read = { offset: number; tail: string; uses: Map<string, { name: string; input: any }>; found: Map<string, Artifact> };
const reads = new Map<string, Read>();
export function artifactsIn(log: string): Artifact[] {
  let r = reads.get(log);
  if (!r) reads.set(log, (r = { offset: 0, tail: '', uses: new Map(), found: new Map() }));
  let fd: number;
  try {
    fd = openSync(log, 'r');
  } catch {
    return [...r.found.values()];
  }
  try {
    const size = fstatSync(fd).size;
    if (size < r.offset) Object.assign(r, { offset: 0, tail: '', uses: new Map(), found: new Map() }); // rewritten
    if (size > r.offset) {
      const buf = Buffer.alloc(size - r.offset);
      readSync(fd, buf, 0, buf.length, r.offset);
      r.offset = size;
      const lines = (r.tail + buf.toString('utf8')).split('\n');
      r.tail = lines.pop() ?? '';
      // only the requests to make one and the replies with a link are worth parsing (logs run to tens of MB)
      for (const line of lines) if (line.includes('"name":"Artifact"') || line.includes('Claude_Docs__batch') || line.includes('claude.ai/')) take(r, line);
    }
  } finally {
    closeSync(fd);
  }
  return [...r.found.values()];
}

function take(r: Read, line: string) {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b.type === 'tool_use' && (b.name === 'Artifact' || /Claude_Docs__batch$/.test(b.name))) r.uses.set(b.id, { name: b.name, input: b.input });
    if (b.type !== 'tool_result' || !r.uses.has(b.tool_use_id)) continue;
    const use = r.uses.get(b.tool_use_id)!;
    r.uses.delete(b.tool_use_id);
    const at = Date.parse(e.timestamp) || 0;
    const res = e.toolUseResult;
    let url = '', title = '';
    if (use.name === 'Artifact') {
      // published, updated or opened (a read or a listing isn't making one)
      if (['read', 'list', 'quickstart', 'delete'].includes(use.input?.action) || typeof res?.url !== 'string') continue;
      [url, title] = [res.url, res.title || ''];
    } else {
      // a document the Docs connector created: its name is in the request, its link in the reply
      title = use.input?.container?.create?.name || '';
      url = title ? (JSON.stringify(b.content ?? '').match(ARTIFACT)?.[0] ?? '') : '';
    }
    if (!ARTIFACT.test(url)) continue;
    const was = r.found.get(url);
    r.found.set(url, { url, title: title || was?.title || '', at: Math.max(at, was?.at ?? 0) });
  }
}

// Claude processes per tmux window: one tmux call, and one ps over devdeck's terminals only (all processes: 0.2 s)
async function claudesByWindow() {
  const panes = await tmux('list-panes', '-a', '-F', '#{window_id}\t#{pane_tty}').catch(() => '');
  const windowOf = new Map(panes.split('\n').filter(Boolean).map((l) => { const [w, tty] = l.split('\t'); return [tty.replace('/dev/', ''), w]; }));
  const out = new Map<string, string[]>();
  if (!windowOf.size) return out;
  const ps = await exec('ps', ['-o', 'pid=,tty=,comm=', '-t', [...windowOf.keys()].join(',')]).then((x) => x.stdout, () => '');
  for (const line of ps.split('\n')) {
    const [pid, tty, ...comm] = line.trim().split(/\s+/);
    const name = basename(comm.join(' '));
    if (!(name === 'claude' || /^\d+\.\d+\.\d+$/.test(name))) continue; // Claude's native build names itself by version
    const w = windowOf.get(tty);
    if (w) out.set(w, [...(out.get(w) ?? []), pid]);
  }
  return out;
}

// Note the conversations running now: in the background, at most every 4 s, so the session list never waits on it
let last = 0;
async function noteConversations() {
  const all = seenLogs();
  let changed = false;
  for (const [w, pids] of await claudesByWindow()) {
    for (const pid of pids) {
      const log = logOf(pid);
      if (log && !all[w]?.includes(log)) (all[w] ??= []).push(log), (changed = true);
    }
  }
  if (changed) try { writeFileSync(FILE, JSON.stringify(all)); } catch { /* next time */ }
}

// Each session's artifact count (what Claude's logs say; reading them again is only what was appended)
export async function withArtifacts(sessions: Session[]) {
  if (Date.now() - last > 4000) {
    last = Date.now();
    noteConversations().catch(() => {});
  }
  const all = seenLogs();
  for (const s of sessions) (s as Session & { artifacts?: number }).artifacts = new Set((all[s.tabs[0]?.id] ?? []).flatMap((l) => artifactsIn(l).map((a) => a.url))).size;
  return sessions;
}

// A session's artifacts, newest first; links still in the terminal's history add older ones (from before devdeck
// looked), with the link's text as the title.
export async function sessionArtifacts(s: Session): Promise<Artifact[]> {
  const byUrl = new Map<string, Artifact>();
  const add = (a: Artifact) => { const was = byUrl.get(a.url); byUrl.set(a.url, { url: a.url, title: was?.title || a.title, at: Math.max(was?.at ?? 0, a.at) }); };
  for (const log of seenLogs()[s.tabs[0]?.id] ?? []) artifactsIn(log).forEach(add);
  const screen = await tmux('capture-pane', '-p', '-e', '-S', '-', '-t', s.tabs[0].pane || s.tabs[0].id).catch(() => '');
  for (const m of screen.matchAll(/\x1b\]8;[^;]*;(https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)\x1b\\(.*?)\x1b\]8;;/g)) {
    const text = m[2].replace(/\x1b\[[\d;]*m/g, '').replace(/^⧉\s*/, '').trim();
    add({ url: m[1], title: text === m[1] ? '' : text, at: 0 });
  }
  return [...byUrl.values()].sort((a, b) => b.at - a.at);
}
