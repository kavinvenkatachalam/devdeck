import { html, render, useCallback, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact.js';

const phone = () => matchMedia('(max-width: 760px)').matches;

// devdeck's mark: a small deck of terminal cards.
const DeckMark = () => html`
  <svg class="deckmark" viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id="dd-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--accent)" /><stop offset="1" style="stop-color:color-mix(in srgb, var(--accent) 70%, var(--text))" /></linearGradient></defs>
    <rect x="8" y="2.5" width="13" height="9" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3" />
    <rect x="5.5" y="6" width="13" height="9" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".55" />
    <rect x="3" y="9.5" width="13.5" height="11" rx="2.4" fill="url(#dd-grad)" />
    <path d="M6.6 13.4l2.3 1.8-2.3 1.8M10.6 17.2h2.6" fill="none" stroke="var(--on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

// Lucide icons from /icons.svg (built by scripts/icons.mjs).
const Icon = ({ name, cls = '', style }) => html`<svg class=${`i ${cls}`} style=${style} aria-hidden="true"><use href=${`/icons.svg#${name}`} /></svg>`;

class ApiError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

async function call(method, path, data) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const out = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new ApiError(out.error || res.statusText, out.hint);
  return out;
}
const qs = (o) => new URLSearchParams(o).toString();

// Per-device conveniences; storage can be unavailable (private mode), so failures are ignored.
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`devdeck.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`devdeck.${k}`, JSON.stringify(v)); } catch {} },
};

const shortPath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
// the home folder (or /): too big to open as a code project
const isHome = (p) => ['~', '/'].includes(shortPath(p).replace(/\/$/, '') || '/');
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return s; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy:', text);
  }
}
const Copy = ({ text }) => html`<button class="copy" title="Copy" onClick=${() => copy(text)}><${Icon} name="copy" cls="sm" /></button>`;

// Theme: system (follows macOS / iOS), light or dark. index.html applies the saved one before first paint.
const THEMES = [['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']];
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  // phone status bar color follows the page
  for (const m of document.querySelectorAll('meta[name=theme-color]')) {
    m.dataset.orig ??= m.content;
    m.content = t === 'light' || t === 'dark' ? getComputedStyle(document.body).backgroundColor : m.dataset.orig;
  }
  themeListeners.forEach((f) => f());
}
const keyboardListeners = new Set();
const onKeyboard = (fn) => { keyboardListeners.add(fn); return () => keyboardListeners.delete(fn); };
// Phone keyboard: iOS doesn't shrink the page for it (Android does, see interactive-widget in index.html), so the
// app is sized to what's visible. While it's up, .keyboard gives the terminal the room (see style.css).
if (window.visualViewport) {
  const vv = visualViewport;
  let full = 0;
  let width = 0;
  const fit = () => {
    if (vv.width !== width) { width = vv.width; full = 0; } // turned: measure again
    full = Math.max(full, vv.height);
    const root = document.documentElement;
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    const up = phone() && vv.height < full - 150;
    if (up !== root.classList.contains('keyboard')) {
      root.classList.toggle('keyboard', up);
      keyboardListeners.forEach((f) => f());
    }
    if (window.scrollY) window.scrollTo(0, 0); // iOS scrolls the page to show the focused box
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

// Whether the page is dark right now (the switch, or the OS while it's on System); the terminal and the editor follow it.
const DARK_OS = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (DARK_OS.matches ? 'dark' : 'light')) === 'dark';
const themeListeners = new Set();
const onThemeChange = (fn) => { themeListeners.add(fn); return () => themeListeners.delete(fn); };
DARK_OS.addEventListener('change', () => themeListeners.forEach((f) => f()));
function ThemeSwitch({ labels }) {
  const [t, setT] = useState(store.get('theme', 'system'));
  const pick = (v) => { setT(v); store.set('theme', v); applyTheme(v); };
  return html`<div class="seg theme-seg" role="radiogroup" aria-label="Theme">${THEMES.map(([id, icon, label]) => html`
    <button class=${t === id ? 'sel' : ''} role="radio" aria-checked=${t === id} title=${label} onClick=${() => pick(id)}><${Icon} name=${icon} cls="sm" />${labels && label}</button>`)}</div>`;
}

// A text field that replaces a label while renaming: Enter saves, Esc cancels, clicking away saves.
function InlineEdit({ value, onSave, onCancel }) {
  const ref = useRef();
  const finished = useRef(false);
  useEffect(() => { ref.current.value = value; ref.current.focus(); ref.current.select(); }, []);
  const done = (save) => {
    if (finished.current) return;
    finished.current = true;
    const v = ref.current.value.trim();
    if (save && v && v !== value) onSave(v);
    else onCancel();
  };
  return html`<input ref=${ref} class="inline-edit" spellcheck="false" autocapitalize="off"
    onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); }}
    onBlur=${() => done(true)} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()} />`;
}

// A small in-app dialog instead of the browser's confirm(): resolves true when confirmed.
const ask = (opts) => new Promise((done) => ui.ask({ ...opts, done }));
function Ask({ title, body, ok = 'OK', danger, done, close }) {
  const okRef = useRef();
  const finish = (yes) => { close(); done(yes); };
  useEffect(() => {
    okRef.current?.focus(); // Enter confirms
    const k = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, []);
  return html`
    <div class="backdrop" onClick=${(e) => e.target === e.currentTarget && finish(false)}>
      <div class="sheet ask" role="alertdialog" aria-label=${title}>
        <div class="grabber"></div>
        <div class="sheet-h"><h2>${title}</h2></div>
        ${body && html`<div class="sheet-sub">${body}</div>`}
        <div class="sheet-f">
          <button class="btn" onClick=${() => finish(false)}>Cancel</button>
          <button ref=${okRef} class=${`btn ${danger ? 'danger-fill' : 'primary'}`} onClick=${() => finish(true)}>${ok}</button>
        </div>
      </div>
    </div>`;
}
// Ending a session closes its terminal, and whatever runs in it stops. Dev servers started from Env run on their own,
// outside any terminal, so they keep running; the dialog says so only when that worktree has some up.
const END_SESSION = (s) => {
  const t = leadTab(s);
  const co = s.checkout && ui.checkout(s.checkout);
  const what = t?.busy ? `This will close its terminal and stop ${t.program}, which is running in it.` : 'This will close its terminal.';
  const servers = serverState(co) ? `\n\nThe dev servers of ${co.main ? co.project : co.branch || co.name} will keep running: they run on their own, not in this terminal. Stop them from Env.` : '';
  return { title: `End the session "${s.name}"?`, body: what + servers, ok: 'End session', danger: true };
};

async function renameSessionTo(s, to, refresh, onRenamed) {
  try { const r = await call('PATCH', `/sessions/${encodeURIComponent(s.name)}`, { name: to }); onRenamed?.(s.name, r.name); await refresh(); } catch (e) { toast(e.message); }
}
async function endSession(s, refresh) {
  if (!(await ask(END_SESSION(s)))) return;
  await call('DELETE', `/sessions/${encodeURIComponent(s.name)}`).catch((e) => toast(e.message));
  refresh();
}

function usePoll(fn, ms, deps) {
  useEffect(() => {
    let live = true;
    const tick = () => live && !document.hidden && fn();
    tick();
    const t = setInterval(tick, ms);
    const vis = () => !document.hidden && tick();
    document.addEventListener('visibilitychange', vis);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, deps);
}

function useJob(id, onDone) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    if (!id) return setJob(null);
    let live = true;
    let timer;
    const tick = async () => {
      try {
        const j = await call('GET', `/jobs/${id}`);
        if (!live) return;
        setJob(j);
        if (j.status === 'running') timer = setTimeout(tick, 1000);
        else onDone?.(j);
      } catch {
        if (live) setJob(null);
      }
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [id]);
  return job;
}

function ErrorBox({ error }) {
  if (!error) return null;
  return html`<div class="alert bad"><${Icon} name="triangle-alert" /><div><b>${error.message || String(error)}</b>${error.hint && html`<span>${error.hint}</span>`}</div></div>`;
}

function Switch({ checked, onChange }) {
  return html`<span class="switch"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} /><i></i></span>`;
}

// ---------- model ----------

// /api/projects → { sessions, projects }. A session is a terminal in any folder. When that folder is a
// worktree of a known project, `checkout` points at it and the worktree's tools (changes, code, env) come along.
function checkoutIndex(data) {
  const m = new Map();
  for (const p of data?.projects || []) for (const c of p.checkouts) m.set(c.path, { ...c, project: p.name, projectPath: p.path, tooljet: p.tooljet });
  return m;
}

const coTitle = (c) => c.branch || c.name;

function serverState(c) {
  const s = c?.servers;
  if (s?.server && s?.frontend) return 'ok';
  if (s?.server || s?.frontend) return 'warn';
  return null;
}

// Claude / Codex tabs report what the agent is doing; other tabs just whether something runs in them.
const AGENT = { working: ['run', 'working', 'accent-text'], waiting: ['warn', 'needs you', 'warn-text'], idle: ['ok', 'idle', 'muted'] };
const tabDot = (t) => (t.agent ? AGENT[t.agent][0] : t.busy ? 'ok' : 'off');
const RANK = { waiting: 3, working: 2, idle: 1 };
// the tab that says most about a session: one that needs you, then one that's working
const leadTab = (s) => [...s.tabs].sort((a, b) => (RANK[b.agent] || 0) - (RANK[a.agent] || 0) || Number(b.busy) - Number(a.busy))[0];

// App-wide openers (menus, palette, sidebar) registered by App, so any row can call them.
const ui = { openMenu: () => {}, palette: () => {}, toggleSide: () => {}, moveSession: () => {}, focusCompose: () => {}, ask: (o) => o.done(confirm(o.title)), checkout: () => null };

// PR look: merged / closed / draft, else by what's blocking it (failing checks, conflicts, changes asked), else pending checks
function prLook(pr) {
  if (pr.state === 'MERGED') return { cls: 'merged', icon: 'git-merge', label: 'Merged' };
  if (pr.state === 'CLOSED') return { cls: 'closed', icon: 'git-pull-request-closed', label: 'Closed' };
  if (pr.draft) return { cls: 'draft', icon: 'git-pull-request-draft', label: 'Draft' };
  const k = pr.checks;
  const rereview = pr.review === 'CHANGES_REQUESTED' && pr.requested?.length > 0;
  if (k.failed || pr.conflicts || (pr.review === 'CHANGES_REQUESTED' && !rereview)) return { cls: 'bad', icon: 'git-pull-request', label: 'Open' };
  if (k.pending || rereview) return { cls: 'warn', icon: 'git-pull-request', label: 'Open' };
  return { cls: 'ok', icon: 'git-pull-request', label: 'Open' };
}

const PrBadge = ({ pr, link }) => {
  const l = prLook(pr);
  const inner = html`<${Icon} name=${l.icon} cls="xs" />#${pr.number}`;
  const title = `${l.label} · ${pr.title}`;
  return link
    ? html`<a class=${`pr-badge ${l.cls}`} href=${pr.url} target="_blank" rel="noopener" title=${title}>${inner}</a>`
    : html`<span class=${`pr-badge ${l.cls}`} title=${title}>${inner}</span>`;
};

const REVIEW = { APPROVED: ['Approved', 'ok-text'], CHANGES_REQUESTED: ['Changes requested', 'bad-text'], REVIEW_REQUIRED: ['Review required', 'muted'] };

// The worktree's PR: state, checks, review, and the failing checks (each links to its run).
function PrCard({ c }) {
  const [pr, setPr] = useState(c.pr);
  usePoll(() => call('GET', `/pr?${qs({ path: c.path })}`).then((r) => setPr(r.pr)).catch(() => {}), 60000, [c.path]);
  if (pr === undefined) return null;
  if (!pr) return html`<div class="prbar"><span class="small muted row"><${Icon} name="git-pull-request" cls="sm" />No pull request for this branch yet</span></div>`;
  const l = prLook(pr);
  const k = pr.checks;
  const asked = pr.requested?.length ? pr.requested.join(', ') : '';
  const review = pr.review === 'CHANGES_REQUESTED' && asked
    ? [`Re-review requested from ${asked}`, 'warn-text']
    : pr.review !== 'APPROVED' && asked ? [`Review requested from ${asked}`, 'muted'] : REVIEW[pr.review];
  return html`
    <div class="prbar">
      <a class="prcard" href=${pr.url} target="_blank" rel="noopener">
        <span class=${`pr-ic ${l.cls}`}><${Icon} name=${l.icon} /></span>
        <span class="grow" style="min-width:0">
          <span class="prcard-title ellipsis"><span class="muted">#${pr.number}</span> ${pr.title}</span>
          <span class="prcard-sub">
            <span class=${`pr-state ${l.cls}`}>${l.label}</span>
            <span>into ${pr.base}</span>
            ${pr.state === 'OPEN' && html`
              ${k.passed > 0 && html`<span class="row ok-text"><${Icon} name="circle-check" cls="xs" />${k.passed}</span>`}
              ${k.failed > 0 && html`<span class="row bad-text"><${Icon} name="circle-x" cls="xs" />${k.failed} failing</span>`}
              ${k.pending > 0 && html`<span class="row warn-text"><${Icon} name="clock" cls="xs" />${k.pending} running</span>`}
              ${review && html`<span class=${review[1]}>${review[0]}</span>`}
              ${pr.conflicts && html`<span class="bad-text">Conflicts</span>`}`}
            <span class="muted"><span class="n-add">+${pr.additions}</span> <span class="n-del">−${pr.deletions}</span></span>
          </span>
        </span>
        <${Icon} name="external-link" cls="sm muted" />
      </a>
      ${pr.state === 'OPEN' && k.failing.length > 0 && html`
        <details class="pr-fails">
          <summary>${plural(k.failing.length, 'failing check')}<${Icon} name="chevron-down" cls="sm chev" /></summary>
          ${k.failing.map((f) => html`<a href=${f.url} target="_blank" rel="noopener" class="row"><${Icon} name="circle-x" cls="xs bad-text" />${f.name}</a>`)}
        </details>`}
    </div>`;
}

// ---------- sidebar / home ----------

// Worktrees with what runs in them, for the Worktrees page and the overview.
function checkoutsOf(data, idx) {
  return data.projects.flatMap((p) => p.checkouts.map((c) => {
    const sessions = data.sessions.filter((s) => s.checkout === c.path);
    return { key: c.path, co: idx.get(c.path), project: p.name, sessions, active: sessions.length > 0 || !!(c.servers?.server || c.servers?.frontend) };
  }));
}

// The sidebar is your own tree: folders you make (named groups, not folders on disk) › sessions (one terminal each).
// Sessions outside any folder come after the folders. Where a session runs is a detail on its row.
const sessKey = (s) => s.order || s.created; // placed ones (1, 2, …) first, the rest by age
function treeOf(data, idx, filter) {
  const f = filter.trim().toLowerCase();
  const hit = (s) => {
    const co = s.checkout && idx.get(s.checkout);
    return !f || `${s.name} ${s.folder} ${s.path} ${co ? `${co.project} ${coTitle(co)}` : ''}`.toLowerCase().includes(f);
  };
  const sessions = [...data.sessions].sort((a, b) => sessKey(a) - sessKey(b)).filter(hit);
  const folders = data.folders.map((name) => ({ name, sessions: sessions.filter((s) => s.folder === name) }));
  return { folders: f ? folders.filter((x) => x.sessions.length) : folders, loose: sessions.filter((s) => !s.folder) };
}

// where a session runs, for its second line: the worktree's branch, or the folder on disk.
// A session on a main checkout with no servers or PR gets no second line: it would say the same on every row.
const quietWhere = (co) => co?.main && !serverState(co) && !co.pr;
function whereOf(s, co) {
  if (co) return { icon: co.main ? 'folder-git-2' : 'git-branch', text: co.main ? `${co.project} · ${co.branch}` : coTitle(co) };
  const p = shortPath(s.path);
  return p === '~' ? { icon: 'house', text: 'Home' } : { icon: 'folder', text: p };
}

// A collapsible sidebar section: ▾ TITLE  count  [actions]
function Panel({ id, cls = '', title, count, action, drop, over, children }) {
  const [open, setOpen] = useState(store.get(`panel.${id}`, true));
  const toggle = () => { setOpen(!open); store.set(`panel.${id}`, !open); };
  return html`
    <section class=${`panel ${cls} ${open ? 'open' : ''}`}>
      <div class=${`panel-h ${over ? 'drop' : ''}`} ...${drop || {}}>
        <button class="panel-t" onClick=${toggle}>${title}${count > 0 && html`<span class="panel-n">${count}</span>`}<${Icon} name="chevron-right" cls="xs caret" /></button>
        ${action}
      </div>
      ${open && html`<div class="panel-b">${children}</div>`}
    </section>`;
}

// Drag a session into a folder, or between sessions to reorder.
const sideDrag = { session: null };
const sessionDrag = (s) => ({
  draggable: !phone(),
  onDragStart: (e) => {
    e.stopPropagation();
    sideDrag.session = s;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', s.name);
    document.body.classList.add('dragging-session');
  },
  onDragEnd: () => { sideDrag.session = null; document.body.classList.remove('dragging-session'); },
});

// Put a session into a folder ('' = top level), just before another session or at the end.
async function placeSession(data, name, folder, before, refresh) {
  if (name === before) return;
  const list = data.sessions.filter((x) => x.folder === folder && x.name !== name).sort((a, b) => sessKey(a) - sessKey(b)).map((x) => x.name);
  const at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, name);
  try { await call('PUT', `/sessions/${encodeURIComponent(name)}/place`, { folder, order: list }); } catch (e) { toast(e.message); }
  refresh();
}

// Another terminal in the same place: a new session in the same folder on disk and sidebar folder, named after this one.
async function sessionHere(s, refresh, openSession) {
  try {
    const out = await call('POST', '/sessions', { path: s.path, folder: s.folder, name: s.name });
    await refresh();
    openSession(out.name);
  } catch (e) { toast(e.message); }
}

// A session is one terminal. Two lines: status, name and what's going on; then where it runs (branch, PR, changes,
// servers). + opens another terminal in the same place; double-click renames; drag it into a folder or between sessions.
function SessionItem({ s, co, sel, onClick, refresh, onRenamed, openSession, drop, over, folders, onMove }) {
  const [editing, setEditing] = useState(false);
  const t = leadTab(s);
  const a = t?.agent && AGENT[t.agent];
  const where = whereOf(s, co);
  const st = co && serverState(co);
  const quiet = quietWhere(co);
  const here = (e) => { e?.stopPropagation(); sessionHere(s, refresh, openSession); };
  const more = (e) => {
    e.stopPropagation();
    const moves = [...folders.filter((f) => f !== s.folder).map((f) => ({ icon: 'folder-output', label: `Move to ${f}`, run: () => onMove(f) })),
      s.folder && { icon: 'folder-output', label: 'Move out of the folder', run: () => onMove('') }].filter(Boolean);
    ui.openMenu(e.currentTarget, [
      { icon: 'plus', label: 'New session here', run: () => here() },
      { icon: 'pencil', label: 'Rename', run: () => setEditing(true) },
      { icon: 'folder-input', label: 'Run in another folder…', run: () => ui.moveSession(s) },
      moves.length && '-',
      ...moves,
      '-',
      { icon: 'power', label: 'End session', danger: true, run: () => endSession(s, refresh) },
    ]);
  };
  return html`
    <div class=${`trow sess ${quiet ? 'one' : ''} ${sel ? 'sel' : ''} ${over ? 'drop-before' : ''}`} ...${sessionDrag(s)} ...${drop}
      onClick=${onClick} onDblClick=${(e) => { e.preventDefault(); setEditing(true); }} title=${`${shortPath(s.path)}${t ? ` · ${t.program}` : ''}`}>
      <span class="caret"></span>
      <span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>
      <span class="sess-main">
        <span class="sess-l1">
          ${editing
            ? html`<${InlineEdit} value=${s.name} onSave=${(v) => { setEditing(false); renameSessionTo(s, v, refresh, onRenamed); }} onCancel=${() => setEditing(false)} />`
            : html`<span class="trow-name ellipsis">${s.name}</span>`}
          ${!editing && a && t.agent !== 'idle' && html`<span class=${`trow-st ${a[2]}`}>${a[1]}</span>`}
        </span>
        ${!quiet && html`<span class="sess-l2">
          <${Icon} name=${where.icon} cls="xs" /><span class="ellipsis">${where.text}</span>
          ${co?.stats?.changes > 0 && html`<span class="trow-chg" title=${plural(co.stats.changes, 'uncommitted change')}>±${co.stats.changes}</span>`}
          ${st && html`<span class=${`port ${st}`} title="ToolJet servers"><span class=${`dot ${st}`}></span>${co.servers.ports.frontend}</span>`}
          ${co?.pr && html`<${PrBadge} pr=${co.pr} />`}
        </span>`}
      </span>
      <span class="trow-act">
        <button class="trow-btn" title="New session here" onClick=${here}><${Icon} name="plus" cls="xs" /></button>
        <button class="trow-btn" title="More" onClick=${more}><${Icon} name="ellipsis" cls="xs" /></button>
      </span>
    </div>`;
}

// the most telling status among some sessions, for a collapsed folder
const groupDot = (sessions) => {
  const tabs = sessions.flatMap((s) => s.tabs);
  return tabs.some((t) => t.agent === 'waiting') ? 'warn' : tabs.some((t) => t.agent === 'working') ? 'run' : null;
};

async function renameFolderTo(from, to, refresh) {
  try { await call('PATCH', `/groups/${encodeURIComponent(from)}`, { name: to }); } catch (e) { toast(e.message); }
  refresh();
}
async function deleteFolder(f, refresh) {
  if (f.sessions.length && !(await ask({ title: `Delete the folder "${f.name}"?`, body: `This will also end its ${plural(f.sessions.length, 'session')} and close their terminals. Dev servers started from Env will keep running.`, ok: 'Delete folder', danger: true }))) return;
  await call('DELETE', `/groups/${encodeURIComponent(f.name)}`).catch((e) => toast(e.message));
  refresh();
}

function SessionTree({ data, idx, sel, filter, onSelect, onNew, refresh, onRenamed, openSession, adding, setAdding }) {
  const [closed, setClosed] = useState(store.get('folders.closed', {}));
  const [editing, setEditing] = useState(null);
  const [over, setOver] = useState(null);
  if (!data) return html`<div class="empty-side">Loading…</div>`;
  const fold = (k) => { const next = { ...closed, [k]: !closed[k] }; setClosed(next); store.set('folders.closed', next); };
  const { folders, loose } = treeOf(data, idx, filter);
  const searching = !!filter.trim();

  // drop a dragged session here: into `folder`, before the session `before` (or at the end)
  const drop = (key, folder, before) => ({
    onDragOver: (e) => {
      if (!sideDrag.session) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); },
    onDrop: (e) => {
      const d = sideDrag.session;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      if (closed[folder]) fold(folder);
      placeSession(data, d.name, folder, before, refresh);
    },
  });
  const item = (s, folder) => html`
    <${SessionItem} key=${s.name} s=${s} co=${s.checkout && idx.get(s.checkout)} sel=${sel?.kind === 'session' && sel.name === s.name} folders=${data.folders}
      onClick=${() => onSelect({ kind: 'session', name: s.name })} refresh=${refresh} onRenamed=${onRenamed} openSession=${openSession} onMove=${(to) => placeSession(data, s.name, to, null, refresh)}
      drop=${drop(`s:${s.name}`, folder, s.name)} over=${over === `s:${s.name}`} />`;
  const folderMenu = (e, f) => {
    e.stopPropagation();
    ui.openMenu(e.currentTarget, [
      { icon: 'plus', label: 'New session in this folder', run: () => onNew(f.name) },
      { icon: 'pencil', label: 'Rename', run: () => setEditing(f.name) },
      '-',
      { icon: 'trash-2', label: 'Delete folder', danger: true, run: () => deleteFolder(f, refresh) },
    ]);
  };
  const folder = (f) => {
    const shut = !searching && closed[f.name];
    const dot = shut && groupDot(f.sessions);
    return html`
      <div class="tgroup" key=${f.name}>
        <div class=${`trow fold ${over === `f:${f.name}` ? 'drop' : ''}`} ...${drop(`f:${f.name}`, f.name, null)}
          onClick=${() => fold(f.name)}>
          <span class=${`caret ${shut ? '' : 'open'}`}><${Icon} name="chevron-right" cls="xs" /></span>
          <${Icon} name=${shut ? 'folder-closed' : 'folder-open'} cls="sm fold-ic" />
          ${editing === f.name
            ? html`<${InlineEdit} value=${f.name} onSave=${(v) => { setEditing(null); renameFolderTo(f.name, v, refresh); }} onCancel=${() => setEditing(null)} />`
            : html`<span class="trow-name ellipsis" title="Double-click to rename" onDblClick=${(e) => { e.preventDefault(); setEditing(f.name); }}>${f.name}</span>`}
          ${dot && html`<span class=${`dot ${dot}`}></span>`}
          <span class="trow-n">${f.sessions.length || ''}</span>
          <span class="trow-act">
            <button class="trow-btn" title="New session in this folder" onClick=${(e) => { e.stopPropagation(); onNew(f.name); }}><${Icon} name="plus" cls="xs" /></button>
            <button class="trow-btn" title="More" onClick=${(e) => folderMenu(e, f)}><${Icon} name="ellipsis" cls="xs" /></button>
          </span>
        </div>
        ${!shut && html`<div class="fold-b">
          ${f.sessions.map((s) => item(s, f.name))}
          ${!f.sessions.length && html`<div class="trow fold-empty">${phone() ? 'Empty. Move sessions here from their ⋯ menu' : 'Empty. Drag sessions here'}</div>`}
        </div>`}
      </div>`;
  };

  return html`
    ${adding && html`
      <div class="trow fold">
        <span class="caret"></span><${Icon} name="folder-plus" cls="sm fold-ic" />
        <${InlineEdit} value="" onSave=${async (v) => { setAdding(false); await call('POST', '/groups', { name: v }).catch((e) => toast(e.message)); refresh(); }} onCancel=${() => setAdding(false)} />
      </div>`}
    ${!data.sessions.length && !data.folders.length && !searching && html`
      <div class="empty-side"><p>No sessions yet. A session is a terminal you can reach from the Mac and your phone. Start it in any folder or worktree, and group sessions in folders here.</p>
        <button class="btn primary" onClick=${() => onNew('')}><${Icon} name="plus" cls="sm" />New session</button></div>`}
    <div class="tree">
      ${folders.map(folder)}
      ${folders.length > 0 && loose.length > 0 && html`<div class="tree-gap"></div>`}
      ${loose.map((s) => item(s, ''))}
      ${data.folders.length > 0 && html`<div class=${`trow loose-end ${over === 'loose' ? 'drop' : ''}`} ...${drop('loose', '', null)}><${Icon} name="folder-output" cls="sm" />Drop here to take it out of the folder</div>`}
    </div>
    ${searching && !folders.length && !loose.length && html`<div class="empty-side">Nothing matches.</div>`}`;
}

// ---------- popovers ----------

// Anchored to a button on the desktop; a bottom sheet on the phone.
function Popover({ rect, onClose, children, width = 260 }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k, true); // before a focused terminal swallows it
    return () => removeEventListener('keydown', k, true);
  }, []);
  const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
  const below = rect.bottom + 6 + 320 < innerHeight;
  const style = phone() ? '' : `left:${left}px;width:${width}px;${below ? `top:${rect.bottom + 6}px` : `bottom:${innerHeight - rect.top + 6}px`}`;
  return html`<div class="menu-scrim" onClick=${onClose}></div><div class="pop" style=${style}>${children}</div>`;
}

// ---------- menu ----------

// items: { icon, label, run, danger } | '-'
const MenuItems = ({ items, onClose }) => items.filter(Boolean).map((it) => (it === '-' ? html`<hr />` : html`
        <button class=${`mi ${it.danger ? 'danger' : ''}`} onClick=${() => { onClose(); it.run(); }}><${Icon} name=${it.icon} />${it.label}</button>`));

function Menu({ items, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  return html`
    <div class="menu-scrim" onClick=${onClose}></div>
    <div class="menu" role="menu"><${MenuItems} items=${items} onClose=${onClose} /></div>`;
}

// ---------- terminal ----------

const TERM_THEME = {
  background: '#111114', foreground: '#e6e6ea', cursor: '#c7c7d1', cursorAccent: '#111114', selectionBackground: '#3a3a48',
  black: '#1b1e26', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#7aa2ff', magenta: '#c49bff', cyan: '#5fd0e0', white: '#d5d8df',
  brightBlack: '#5c6170', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fcd34d', brightBlue: '#9db9ff', brightMagenta: '#d6b6ff', brightCyan: '#86e0ec', brightWhite: '#ffffff',
};
// on white, "white" and the bright colors are darkened so everything stays readable
const TERM_THEME_LIGHT = {
  background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: '#c9d6f5',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#8a5a00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#6c4400', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};
const termTheme = () => (isDark() ? TERM_THEME : TERM_THEME_LIGHT);

// Files dropped or pasted on a terminal are saved on the Mac; the terminal gets their paths, escaped the way
// Terminal.app does it, as a paste (so Claude attaches images).
const shellEscape = (p) => p.replace(/[^A-Za-z0-9_\-.,/:@+=~]/g, '\\$&');
async function uploadFiles(files) {
  const paths = [];
  for (const f of files) {
    const res = await fetch(`/api/upload?${qs({ name: f.name || 'pasted' })}`, { method: 'POST', body: f });
    const out = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(`${f.name}: ${out.error}`);
    paths.push(out.path);
  }
  return paths;
}

function Terminal({ session, tabIndex, sendRef, onGone, small, autofocus = true }) {
  const el = useRef();
  const wsRef = useRef();
  const termRef = useRef();
  const [attempt, setAttempt] = useState(0);
  const [dropping, setDropping] = useState(false);
  // Input is numbered and kept until the server confirms it (see the effect); the server writes each number once.
  const unacked = useRef([]);
  const inputId = useRef(Math.random().toString(36).slice(2));
  const inputSeq = useRef(0);
  const retry = useRef(0);
  const putFiles = async (files) => {
    if (!files.length) return;
    try {
      const paths = await uploadFiles(files);
      termRef.current?.paste(`${paths.map(shellEscape).join(' ')} `);
      termRef.current?.focus();
    } catch (e) { toast(e.message); }
  };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  useEffect(() => {
    const term = new window.Terminal({
      fontSize: phone() || small ? 12 : 13,
      lineHeight: 1.15,
      fontFamily: '"SF Mono", ui-monospace, Menlo, "JetBrains Mono", monospace',
      cursorBlink: true,
      scrollback: 0, // tmux keeps the history; mouse wheel scrolls it
      theme: termTheme(),
      allowProposedApi: true, // unicode graphemes
      macOptionIsMeta: true, // ⌥ sends Meta to the CLI instead of composing characters
      macOptionClickForcesSelection: true, // ⌥-drag selects in the browser even while tmux has the mouse
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    // tmux lays out with modern wcwidth; xterm's default Unicode 6 tables misplace Claude's symbols and boxes
    term.loadAddon(new window.UnicodeGraphemesAddon.UnicodeGraphemesAddon());
    term.unicode.activeVersion = '15-graphemes';
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    // Copies reach the terminal as OSC 52 (a tmux mouse selection, Claude's "copied" via tmux load-buffer -w, a program's
    // own); this puts them on the browser clipboard. tmux sends them with an empty target (";;"), which the addon's own
    // provider ignores (it only takes "c"), so every target goes to the clipboard here. Reading it back stays "c" only.
    term.loadAddon(new window.ClipboardAddon.ClipboardAddon(undefined, {
      readText: (sel) => (sel === 'c' ? navigator.clipboard.readText() : ''),
      writeText: (_sel, text) => navigator.clipboard?.writeText(text).catch(() => toast('Couldn\'t copy: click the page and try again')),
    }));
    term.open(el.current);
    termRef.current = term;
    const offTheme = onThemeChange(() => { term.options.theme = termTheme(); });
    // a pasted image or file (a screenshot, a file copied in Finder) goes in as its path; text pastes as usual
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length || e.clipboardData.getData('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      putFiles(files);
    };
    el.current.addEventListener('paste', onPaste, true);
    // GPU renderer like a native terminal; the default DOM renderer stays as the fallback
    try {
      const gl = new window.WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* no WebGL: DOM renderer */ }
    // ⌘C copies a selection (⌥-drag); without one it reaches the terminal as usual
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).then(() => toast('Copied'), () => {});
        return false;
      }
      // ⇧Enter = a new line in Claude / Codex: send ESC+Enter like Claude's /terminal-setup does (xterm sends a plain Enter)
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown') send({ t: 'i', d: '\x1b\r' });
        return false;
      }
      return true;
    });
    const visible = () => el.current && el.current.offsetWidth > 0 && el.current.offsetHeight > 0;
    if (visible()) fit.fit();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?${qs({ session, window: String(tabIndex ?? ''), cols: term.cols, rows: term.rows })}`);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer'; // the server's confirmations come as binary frames, terminal output as text
    let reconnect = 0;
    const again = (wait) => { clearTimeout(reconnect); reconnect = setTimeout(() => setAttempt((n) => n + 1), wait); };
    const send = (m) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    };
    // Input is never lost: each piece is numbered and kept until the server confirms it, and re-sent after a reconnect
    // (the server writes each number once). Unconfirmed after 3 s means the connection is dead though it looks open,
    // as a phone's often is after sleeping or changing network: drop it and reconnect.
    for (const m of unacked.current) m.at = 0;
    const deliver = (m) => { if (send({ t: 'i', d: m.d, id: inputId.current, seq: m.seq })) m.at = Date.now(); };
    const type = (d) => {
      const m = { seq: ++inputSeq.current, d, at: 0 };
      unacked.current.push(m);
      if (ws.readyState === WebSocket.OPEN) deliver(m);
      else if (ws.readyState > WebSocket.OPEN) again(0);
    };
    sendRef.current = (d, focus = true) => {
      type(d);
      if (focus) term.focus();
    };
    const dead = () => {
      ws.onclose = ws.onmessage = null;
      ws.close();
      again(0);
    };
    const watchdog = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) for (const m of unacked.current) if (!m.at) deliver(m); // queued from an older connection
      const m = unacked.current[0];
      if (m?.at && Date.now() - m.at > 3000) dead();
    }, 1000);

    ws.onopen = () => {
      retry.current = 0;
      for (const m of unacked.current) deliver(m);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return term.write(e.data);
      const { ack } = JSON.parse(new TextDecoder().decode(e.data));
      unacked.current = unacked.current.filter((m) => m.seq > ack);
    };
    // Dropped (the phone slept, the network changed, the Mac restarted devdeck): reconnect on its own, soon at first.
    ws.onclose = (e) => {
      if (e.code === 4404) return onGone();
      term.write('\r\n\x1b[2m[reconnecting…]\x1b[0m');
      again(Math.min(5000, 300 * 2 ** retry.current++));
    };
    // back in the app, or back online: reconnect now if it's closed; if it looks open, an empty input checks it's alive
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (ws.readyState > WebSocket.OPEN) again(0);
      else if (ws.readyState === WebSocket.OPEN) type('');
    };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    const input = term.onData(type);
    // A phone keyboard only covers part of the terminal (no resize, see below): it's scrolled so the cursor's line, Claude's
    // input box or the shell prompt, stays in view.
    let follow = 0;
    const keepCursor = () => {
      cancelAnimationFrame(follow);
      follow = requestAnimationFrame(() => {
        const box = el.current;
        if (!box) return;
        if (!document.documentElement.classList.contains('keyboard')) return void (box.scrollTop = 0);
        const row = term.element.offsetHeight / term.rows;
        const cursor = (term.buffer.active.cursorY + 2) * row;
        box.scrollTop = Math.max(0, Math.min(cursor - box.clientHeight, box.scrollHeight - box.clientHeight));
      });
    };
    const moved = term.onCursorMove(keepCursor);
    const offKeys = onKeyboard(keepCursor);
    // A hidden terminal (another tab is open) has no size; resizing tmux to it would shrink the window.
    let frame = 0;
    let sized = false;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!visible()) return;
        // a phone keyboard coming up only hides the top of the terminal (see .keyboard .term): resizing tmux for it
        // would make Claude redraw its whole screen, twice per keyboard
        if (sized && document.documentElement.classList.contains('keyboard')) return keepCursor();
        const { cols, rows } = term;
        fit.fit();
        if (term.cols !== cols || term.rows !== rows || !sized) send({ t: 'r', c: term.cols, r: term.rows });
        sized = true;
      });
    });
    ro.observe(el.current);
    if (!phone() && autofocus) term.focus();
    // A finger drag scrolls (xterm.js has no touch scrolling of its own): a line per row the finger moves, sent once a
    // frame; the server scrolls tmux's history or hands it to a full-screen app like Claude's. A flick glides on.
    let lastY = 0, lastT = 0, acc = 0, speed = 0, glide = 0, at = [1, 1], lines = 0, flush = 0;
    const scrollBy = (dy) => {
      const row = el.current.clientHeight / term.rows;
      acc += dy;
      const n = Math.trunc(acc / row);
      if (!n) return;
      acc -= n * row;
      lines += n;
      flush ||= requestAnimationFrame(() => {
        flush = 0;
        send({ t: 's', n: lines, x: at[0], y: at[1] });
        lines = 0;
      });
    };
    const touchStart = (e) => {
      if (e.touches.length !== 1) return;
      cancelAnimationFrame(glide);
      const t = e.touches[0];
      const box = term.element.getBoundingClientRect();
      const cell = (n, from, size, count) => Math.min(count, Math.max(1, Math.floor(((n - from) / size) * count) + 1));
      at = [cell(t.clientX, box.left, box.width, term.cols), cell(t.clientY, box.top, box.height, term.rows)];
      [lastY, lastT, acc, speed] = [t.clientY, e.timeStamp, 0, 0];
    };
    const touchMove = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault(); // ours: iOS would otherwise start its own page bounce and stop sending the touch
      const t = e.touches[0];
      const dy = lastY - t.clientY;
      speed = 0.8 * (dy / Math.max(1, e.timeStamp - lastT)) + 0.2 * speed;
      [lastY, lastT] = [t.clientY, e.timeStamp];
      scrollBy(dy);
    };
    const touchEnd = () => {
      let prev = performance.now();
      const frame = (now) => {
        const dt = now - prev;
        prev = now;
        speed *= 0.995 ** dt;
        if (Math.abs(speed) < 0.05) return;
        scrollBy(speed * dt);
        glide = requestAnimationFrame(frame);
      };
      if (Math.abs(speed) > 0.3) glide = requestAnimationFrame(frame);
    };
    const touch = [['touchstart', touchStart], ['touchmove', touchMove], ['touchend', touchEnd]];
    for (const [ev, fn] of touch) el.current.addEventListener(ev, fn, { passive: ev !== 'touchmove' });

    // Phone keyboards (autocorrect, predictions, composing) type badly into a terminal: there you write in the
    // message box under it, and a tap on the terminal opens that instead. A hardware keyboard still types here.
    let tapped = null;
    if (phone()) {
      term.textarea?.setAttribute('inputmode', 'none');
      tapped = () => ui.focusCompose();
      el.current.addEventListener('click', tapped);
    }

    return () => {
      el.current?.removeEventListener('paste', onPaste, true);
      if (tapped) el.current?.removeEventListener('click', tapped);
      for (const [ev, fn] of touch) el.current?.removeEventListener(ev, fn);
      cancelAnimationFrame(glide);
      cancelAnimationFrame(flush);
      offTheme();
      clearTimeout(reconnect);
      clearInterval(watchdog);
      moved.dispose();
      offKeys();
      cancelAnimationFrame(follow);
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('online', wake);
      ro.disconnect();
      input.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [session, attempt]);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'w', w: tabIndex }));
  }, [tabIndex]);

  return html`
    <div class=${`term ${dropping ? 'dropping' : ''}`} ref=${el}
      onDragOver=${(e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
      onDragLeave=${(e) => { if (!el.current.contains(e.relatedTarget)) setDropping(false); }}
      onDrop=${(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(false); putFiles([...e.dataTransfer.files]); }}></div>`;
}

const KEYS = [
  ['esc', '\x1b'], ['tab', '\t'], ['⇧tab', '\x1b[Z'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['⏎', '\r'],
];

// Write a message into the terminal as one paste, then press Enter. Easier than typing into the terminal on a
// phone, and multi-line text arrives as one prompt (bracketed paste) instead of one line per Enter.
function Compose({ sendRef }) {
  const ta = useRef();
  // read from the box itself, not from state: Android keyboards (Gboard) can still be composing the last word
  const go = () => {
    const el = ta.current;
    const v = el.value;
    // sendRef is looked up each time: the terminal may have reconnected in between
    if (v) sendRef.current(`\x1b[200~${v}\x1b[201~`, false);
    setTimeout(() => sendRef.current('\r', false), v ? 60 : 0);
    el.value = '';
    el.style.height = '';
    el.focus();
  };
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };
  useEffect(() => { ui.focusCompose = () => ta.current?.focus(); return () => { ui.focusCompose = () => {}; }; }, []);
  // a phone's Return sends, as in a terminal (a pasted text keeps its lines); commands aren't words, so no autocorrect.
  // Android reports Return as a line-break input rather than a key, so both are caught.
  return html`
    <div class="compose">
      <textarea ref=${ta} rows="1" placeholder="Type here · Return sends" enterkeyhint="send"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"
        onInput=${(e) => grow(e.target)}
        onBeforeInput=${(e) => { if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); go(); } }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } }}></textarea>
      <button class="btn sm primary" onPointerDown=${(e) => e.preventDefault()} onClick=${go} title="Send"><${Icon} name="send" cls="sm" /></button>
    </div>`;
}

// One tap answers an agent's prompt: an option's number, or Esc to cancel.
function Replies({ t, refresh }) {
  if (t?.agent !== 'waiting' || !t.choices?.length) return null;
  const send = async (key) => {
    try { await call('POST', `/tabs/${encodeURIComponent(t.id)}/reply`, { key }); } catch (e) { toast(e.message); }
    refresh();
  };
  return html`
    <div class="replies" onClick=${(e) => e.stopPropagation()}>
      ${t.choices.map((c, i) => html`<button class="btn sm" title=${c} onClick=${() => send(String(i + 1))}><span class="reply-n">${i + 1}</span><span class="ellipsis">${c}</span></button>`)}
      <button class="btn sm ghost" title="Cancel (Esc)" onClick=${() => send('Escape')}>Esc</button>
    </div>`;
}

// The sessions of the open one's sidebar folder (or those outside folders), as tabs to hop between (⌘/⌃1–9); + adds one,
// ✕ ends one, double-click renames. Each is still its own session: this is only navigation.
function FolderTabs({ s, siblings, refresh, openSession, onRenamed }) {
  const [editing, setEditing] = useState(null);
  if (!siblings.length) return null;
  const close = async (e, x) => {
    e.stopPropagation();
    if (!(await ask(END_SESSION(x)))) return;
    if (x.name === s.name) {
      const i = siblings.indexOf(x);
      const next = siblings[i + 1] || siblings[i - 1];
      if (next) openSession(next.name);
    }
    await call('DELETE', `/sessions/${encodeURIComponent(x.name)}`).catch((er) => toast(er.message));
    refresh();
  };
  return html`
    <div class="ftabs">
      ${siblings.map((x, i) => {
        const t = leadTab(x);
        const a = t?.agent && AGENT[t.agent];
        return html`
          <div class=${`ftab ${x.name === s.name ? 'sel' : ''}`} key=${x.name} onClick=${() => x.name !== s.name && openSession(x.name)}
            title=${`${x.name}${a ? ` · ${t.program} ${a[1]}` : ''}${i < 9 ? ` (⌘${i + 1})` : ''} · double-click to rename`}
            onDblClick=${(e) => { e.preventDefault(); setEditing(x.name); }}>
            ${i < 9 && html`<span class="ftab-k">${i + 1}</span>`}<span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>
            ${editing === x.name
              ? html`<${InlineEdit} value=${x.name} onSave=${(v) => { setEditing(null); renameSessionTo(x, v, refresh, (_, to) => x.name === s.name && onRenamed(to)); }} onCancel=${() => setEditing(null)} />`
              : html`<span class="ellipsis">${x.name}</span>`}
            <button class="x" title="End session" onClick=${(e) => close(e, x)}><${Icon} name="x" cls="xs" /></button>
          </div>`;
      })}
      <button class="icon-btn sm" title=${s.folder ? `New session in ${s.folder}` : 'New session here'} onClick=${() => sessionHere(s, refresh, openSession)}><${Icon} name="plus" cls="sm" /></button>
    </div>`;
}

// The session's terminal, framed: the folder's sessions as tabs on top, one-tap replies when an agent asks.
function TerminalPane({ s, siblings, refresh, openSession, onRenamed }) {
  const sendRef = useRef(() => {});
  const t = s.tabs[0];
  if (!t) return null;
  return html`
    <div class="term-unit">
      <${FolderTabs} s=${s} siblings=${siblings} refresh=${refresh} openSession=${openSession} onRenamed=${onRenamed} />
      <${Replies} t=${t} refresh=${refresh} />
      <div class="term-card">
        <${Terminal} key=${s.name} session=${s.name} tabIndex=${t.index} sendRef=${sendRef} onGone=${refresh} />
      </div>
    </div>
    <div class="keys">${KEYS.map(([l, seq]) => html`<button onPointerDown=${(e) => e.preventDefault()} onClick=${() => sendRef.current(seq, !phone())}>${l}</button>`)}</div>
    ${phone() && html`<${Compose} sendRef=${sendRef} />`}`;
}

// ---------- top & status bars ----------

// crumbs: [{ label, icon, go }] — the last one is the current place. On the phone: back + title + sub.
// A crumb with `rename` renames in place on double-click (or when `editing` is set, e.g. from a menu).
function TopBar({ onBack, crumbs, title, sub, lenses, cur, pick, changes, children }) {
  const badge = (id) => id === 'changes' && changes > 0 && html`<span class="n">${changes}</span>`;
  const [editingAt, setEditingAt] = useState(null);
  const last = crumbs.map((x) => !x.node).lastIndexOf(true);
  const chip = (c, i) => {
    const cls = `crumb-chip ${i === last ? 'cur' : ''}`;
    const icon = c.icon && html`<${Icon} name=${c.icon} cls="xs" />`;
    const stop = () => { setEditingAt(null); c.onEditEnd?.(); };
    if (c.rename && (editingAt === i || c.editing)) {
      return html`<span class=${cls}>${icon}<${InlineEdit} value=${c.label} onSave=${(v) => { stop(); c.rename(v); }} onCancel=${stop} /></span>`;
    }
    return html`<button class=${`${cls} ${!c.go ? 'static' : ''}`} onClick=${c.go} disabled=${!c.go && !c.rename}
      onDblClick=${c.rename && ((e) => { e.preventDefault(); setEditingAt(i); })} title=${c.title || (c.rename ? 'Double-click to rename' : '')}>
      ${icon}<span class="ellipsis">${c.label}</span></button>`;
  };
  return html`
    <header class="top">
      <button class="icon-btn back" onClick=${onBack} aria-label="Back"><${Icon} name="chevron-left" /></button>
      <button class="icon-btn side-toggle" title="Toggle sidebar" onClick=${() => ui.toggleSide()}><${Icon} name="panel-left" /></button>
      <nav class="crumbs">${crumbs.map((c, i) => html`
        ${i > 0 && !c.node && html`<span class="crumb-sep">/</span>`}
        ${c.node || chip(c, i)}`)}
      </nav>
      <div class="top-title"><h1><span>${title}</span></h1>${sub && html`<div class="top-sub">${sub}</div>`}</div>
      <div class="top-actions">
        ${children}
        ${lenses?.length > 1 && html`<div class="lens-group">${lenses.map(([id, label, icon]) => html`
          <button class=${`lens ${cur === id ? 'sel' : ''}`} title=${label} onClick=${() => pick(id)}><${Icon} name=${icon} cls="sm" /><span class="lens-label">${label}</span>${badge(id)}</button>`)}</div>`}
        <button class="icon-btn palette-btn" title="Go to… (⌘K)" onClick=${() => ui.palette()}><${Icon} name="search" cls="sm" /></button>
      </div>
    </header>`;
}

const gb = (n) => `${(n / 2 ** 30).toFixed(n >= 100 * 2 ** 30 ? 0 : 1)}G`;

// Desktop footer: what the open place is doing (branch, PR, agent, servers) and how the Mac is doing.
function StatusBar({ s, co, host }) {
  const t = s && leadTab(s);
  const a = t?.agent && AGENT[t.agent];
  const st = co && serverState(co);
  const memPct = host ? Math.round((host.mem.used / host.mem.total) * 100) : 0;
  return html`
    <footer class="status">
      ${co && html`<span class="st-i"><${Icon} name="git-branch" cls="xs" />${co.branch || co.name}</span>`}
      ${co?.pr && html`<a class=${`st-i pr-${prLook(co.pr).cls}`} href=${co.pr.url} target="_blank" rel="noopener">pr #${co.pr.number} · ${prLook(co.pr).label.toLowerCase()}</a>`}
      ${co?.stats && html`<span class="st-i">${co.stats.changes ? plural(co.stats.changes, 'change') : 'clean'}${co.stats.ahead ? ` ↑${co.stats.ahead}` : ''}${co.stats.behind ? ` ↓${co.stats.behind}` : ''}</span>`}
      ${a && html`<span class=${`st-i ${a[2]}`}><span class=${`dot ${a[0]}`}></span>${t.program} ${a[1]}</span>`}
      ${st && html`<span class=${`st-i ${st}-text`}><span class=${`dot ${st}`}></span>:${co.servers.ports.frontend} · :${co.servers.ports.server}</span>`}
      ${s && html`<span class="st-i st-path muted">${shortPath(s.path)}</span>`}
      <span class="grow"></span>
      ${host && html`
        <span class="st-i" title=${`load ${host.load.join(' ')}`}>cpu<span class="gauge"><i class=${host.cpu > 85 ? 'hi' : ''} style=${`width:${host.cpu}%`}></i></span><b>${host.cpu}%</b></span>
        <span class="st-i">mem<span class="gauge"><i class=${memPct > 85 ? 'hi' : ''} style=${`width:${memPct}%`}></i></span><b>${gb(host.mem.used)}/${gb(host.mem.total)}</b></span>
        ${host.disk && html`<span class="st-i hide-narrow">dsk ${gb(host.disk.used)}/${gb(host.disk.total)}</span>`}
        <span class="st-i muted hide-narrow">${host.host}</span>
        <span class="st-i muted">v${host.version}</span>`}
      <span class="dot ok" title="Connected"></span>
    </footer>`;
}

// ---------- command palette ----------

const fuzzy = (q, text) => {
  let i = 0;
  const t = text.toLowerCase();
  for (const ch of q.toLowerCase()) if ((i = t.indexOf(ch, i) + 1) === 0) return false;
  return true;
};

function Palette({ commands, onClose }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef();
  useEffect(() => { input.current?.focus(); }, []);
  // best match first: name starts with it, then contains it, then fuzzy on the name, then anywhere
  const score = (c) => {
    const l = c.label.toLowerCase(), x = q.toLowerCase();
    return l.startsWith(x) ? 4 : l.includes(x) ? 3 : fuzzy(q, c.label) ? 2 : fuzzy(q, `${c.group} ${c.label} ${c.hint || ''}`) ? 1 : 0;
  };
  const list = (q ? commands.map((c) => [score(c), c]).filter(([n]) => n).sort((a, b) => b[0] - a[0]).map(([, c]) => c) : commands).slice(0, 60);
  const run = (c) => { onClose(); c.run(); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((i + 1) % Math.max(1, list.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((i - 1 + list.length) % Math.max(1, list.length)); }
    else if (e.key === 'Enter' && list[i]) run(list[i]);
    else if (e.key === 'Escape') onClose();
  };
  useEffect(() => { document.querySelector('.palette .sel')?.scrollIntoView({ block: 'nearest' }); }, [i]);
  let last = '';
  return html`
    <div class="backdrop palette-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette">
        <div class="palette-in"><${Icon} name="search" cls="sm" /><input ref=${input} placeholder="Go to a session or worktree, or run a command" value=${q} onInput=${(e) => { setQ(e.target.value); setI(0); }} onKeyDown=${key} autocapitalize="off" autocorrect="off" spellcheck="false" /><kbd>esc</kbd></div>
        <div class="palette-list">
          ${list.map((c, n) => {
            const head = c.group !== last && html`<div class="palette-g">${c.group}</div>`;
            last = c.group;
            return html`${head}<button class=${`palette-item ${n === i ? 'sel' : ''}`} onMouseMove=${() => n !== i && setI(n)} onClick=${() => run(c)}>
              <${Icon} name=${c.icon} cls="sm" /><span class="grow ellipsis">${c.label}</span>${c.hint && html`<span class="palette-hint ellipsis">${c.hint}</span>`}</button>`;
          })}
          ${!list.length && html`<div class="palette-empty">No match</div>`}
        </div>
      </div>
    </div>`;
}

// ---------- changes ----------

function FileDiff({ f, open: initial }) {
  const [open, setOpen] = useState(initial);
  const slash = f.path.lastIndexOf('/');
  return html`
    <div class="dfile">
      <button class=${`dfile-h ${open ? 'open' : ''}`} onClick=${() => setOpen(!open)}>
        <${Icon} name="chevron-right" cls="sm chev" />
        <span class="p" title=${f.path}>${slash > 0 && html`<span class="dir">${f.path.slice(0, slash + 1)}</span>`}${f.path.slice(slash + 1)}</span>
        <span class=${`st ${f.status}`}>${f.status === 'untracked' ? 'new' : f.status}</span>
        ${f.add > 0 && html`<span class="n-add">+${f.add}</span>`}${f.del > 0 && html`<span class="n-del">−${f.del}</span>`}
      </button>
      ${open && html`<div class="dbody">
        ${f.patch ? f.patch.split('\n').map((l) => html`<div class=${l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : ''}>${l || ' '}</div>`) : html`<div class="h">${f.status === 'binary' ? 'Binary file' : 'No text changes'}</div>`}
        ${f.truncated && html`<div class="h">… truncated</div>`}
      </div>`}
    </div>`;
}

function ChangesPane({ path }) {
  const [mode, setMode] = useState(store.get('diffMode', 'uncommitted'));
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = async () => {
    setErr(null);
    try { setData(await call('GET', `/diff?${qs({ path, mode })}`)); } catch (e) { setErr(e); }
  };
  useEffect(() => { setData(null); load(); }, [path, mode]);
  const pickMode = (m) => { setMode(m); store.set('diffMode', m); };
  const lines = data?.files.reduce((n, f) => n + f.add + f.del, 0) || 0;
  return html`
    <div class="scroll"><div class="stack">
      <div class="diff-sum">
        <div class="seg">
          <button class=${mode === 'uncommitted' ? 'sel' : ''} onClick=${() => pickMode('uncommitted')}>Uncommitted</button>
          <button class=${mode === 'branch' ? 'sel' : ''} onClick=${() => pickMode('branch')}>Whole branch</button>
        </div>
        <span class="grow"></span>
        ${data && html`<span class="small muted">${plural(data.files.length, 'file')} <span class="n-add">+${data.add}</span> <span class="n-del">−${data.del}</span></span>`}
        <button class="icon-btn" title="Refresh" onClick=${load}><${Icon} name="rotate-cw" /></button>
      </div>
      ${mode === 'branch' && data?.base && html`<div class="small muted">Against <span class="mono">${data.base}</span>, including uncommitted work${data.commits.length ? ` · ${plural(data.commits.length, 'commit')}` : ''}</div>`}
      <${ErrorBox} error=${err || (data?.error && { message: data.error })} />
      ${!data && !err && html`<div class="muted">Loading…</div>`}
      ${data && mode === 'branch' && data.commits.length > 0 && html`
        <details class="card disclose">
          <summary><${Icon} name="git-commit-horizontal" />${plural(data.commits.length, 'commit')} on this branch<${Icon} name="chevron-down" cls="chev" /></summary>
          <div class="card-b tight"><ul class="list">${data.commits.map((x) => html`<li><span class="mono muted">${x.sha}</span><span class="grow">${x.subject}</span></li>`)}</ul></div>
        </details>`}
      ${data && !data.files.length && !data.error && html`
        <div class="empty"><div class="empty-box">
          <div class="empty-ic"><${Icon} name="check" /></div>
          <h2>${mode === 'uncommitted' ? 'No uncommitted changes' : 'Nothing on this branch yet'}</h2>
          <p>${mode === 'uncommitted' ? 'Edits made by you or Claude show up here.' : `No differences from ${data.base}.`}</p>
        </div></div>`}
      ${data?.files.map((f, i) => html`<${FileDiff} key=${mode + f.path} f=${f} open=${lines < 1500 && i < 20} />`)}
    </div></div>`;
}

// ---------- code ----------

const codeUrl = (path) => `/code/?${qs({ folder: path })}`;

function CodePane({ path, active }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => call('GET', '/code').then(setSt).catch(setErr);
  useEffect(() => { if (active) load(); }, [active]);
  // the editor's light/dark follows the page's (it's one setting for code-server, so the last page shown wins)
  useEffect(() => {
    if (!active) return;
    const send = () => call('POST', '/code/theme', { dark: isDark() }).catch(() => {});
    send();
    return onThemeChange(send);
  }, [active]);
  // a code-server started with older flags is restarted once, transparently
  useEffect(() => { if (active && st?.stale && !busy) start(); }, [active, st?.stale]);
  const start = async () => {
    setBusy(true);
    setErr(null);
    try { setSt(await call('POST', '/code/start')); } catch (e) { setErr(e); }
    setBusy(false);
  };
  const install = async () => {
    setErr(null);
    try { const r = await call('POST', '/code/install'); if (r.id) setJobId(r.id); else setSt(r); } catch (e) { setErr(e); }
  };
  const vscode = async () => {
    setErr(null);
    try { await call('POST', '/open/vscode', { path }); toast('Opened in VS Code on the Mac'); } catch (e) { setErr(e); }
  };
  // your editor's settings and extensions come along on their own (see codeserver.ts); full screen is in the ⋯ menu
  if (st?.running && !st.stale && active)
    return html`<div class="code-frame"><iframe key=${path} src=${codeUrl(path)} title="Code" allow="clipboard-read; clipboard-write"></iframe></div>`;
  return html`
    <div class="empty"><div class="empty-box" style="max-width:380px">
      <div class="empty-ic"><${Icon} name="code-xml" /></div>
      <h2>Browse & edit the code</h2>
      <p>${st && !st.installed ? 'VS Code in the browser needs code-server, a one-time install.' : 'VS Code in the browser, on the Mac or your phone.'}</p>
      <div class="row wrap" style="justify-content:center">
        ${!st ? html`<span class="muted">Loading…</span>` : st.installed
          ? html`<button class="btn primary" disabled=${busy} onClick=${start}><${Icon} name="play" />${busy ? 'Starting…' : 'Open in browser'}</button>`
          : html`<button class="btn primary" disabled=${!st.brew || !!jobId} onClick=${install}><${Icon} name="package" />Install code-server</button>`}
        <button class="btn hide-phone" onClick=${vscode}><${Icon} name="monitor" />VS Code on this Mac</button>
      </div>
      ${err && html`<div style="margin-top:14px;text-align:left"><${ErrorBox} error=${err} /></div>`}
      ${jobId && html`<div style="margin-top:14px;text-align:left"><${JobView} jobId=${jobId} onDone=${() => { setJobId(null); load(); }} /></div>`}
    </div></div>`;
}

// ---------- env ----------

function envState(env) {
  if (!env?.tooljet) return null;
  const s = env.services;
  if (env.job?.status === 'running') return { cls: 'warn', icon: 'loader-circle', label: env.job.title, sub: 'Working…' };
  const up = (x) => x.state === 'running';
  if (up(s.server) && up(s.frontend)) return { cls: 'ok', icon: 'server', label: 'Running', sub: `Frontend :${s.frontend.port} · server :${s.server.port}` };
  if (s.server.state === 'starting' || s.frontend.state === 'starting') return { cls: 'warn', icon: 'loader-circle', label: 'Starting', sub: 'Waiting for the servers' };
  if (up(s.server) || up(s.frontend)) return { cls: 'warn', icon: 'server', label: up(s.server) ? 'Server only' : 'Frontend only', sub: 'One service is down' };
  if (s.server.state === 'busy' || s.frontend.state === 'busy') return { cls: 'bad', icon: 'triangle-alert', label: 'Port in use', sub: 'Another process holds a port' };
  if (!env.ready) return { cls: '', icon: 'package', label: 'Not set up', sub: 'Set up creates .env, database and dependencies' };
  return { cls: '', icon: 'server', label: 'Stopped', sub: `Ready on :${s.frontend.port}` };
}

// Env status: polled every 5 s on the Env tab or while a job runs. Elsewhere it's read once and then again only
// when the session list (refreshed every 5 s anyway) sees a server go up or down: see useEnvControls.
function useEnv(path, enabled, fast) {
  const [env, setEnv] = useState(null);
  const load = useCallback(() => enabled && call('GET', `/env?${qs({ path })}`).then(setEnv).catch(() => {}), [path, enabled]);
  const poll = fast || env?.job?.status === 'running';
  usePoll(load, poll ? 5000 : 3_600_000, [path, enabled, poll]);
  return [env, load];
}

function JobView({ jobId, onDone, onDiscard }) {
  const job = useJob(jobId, onDone);
  const logRef = useRef();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [job?.log.length]);
  if (!job) return null;
  const done = job.steps.filter((s) => ['done', 'skipped'].includes(s.status)).length;
  const secs = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  return html`
    <div class="card">
      <div class="card-h">
        <h3>${job.status === 'running' ? html`<${Icon} name="loader-circle" cls="spin" />` : job.status === 'done' ? html`<${Icon} name="check" />` : html`<${Icon} name="triangle-alert" />`}${job.title}</h3>
        <span class=${`pill ${job.status === 'running' ? 'warn' : job.status === 'done' ? 'ok' : 'bad'}`}>${job.status === 'running' ? `${done}/${job.steps.length}` : job.status === 'done' ? 'Done' : 'Failed'} · ${secs}s</span>
      </div>
      <div class="card-b">
        ${job.status === 'running' && html`<div class="progress"><div style=${`width:${(done / job.steps.length) * 100}%`}></div></div>`}
        <div class="steps">
          ${job.steps.map((s) => html`
            <div class=${`step ${s.status}`}>
              <span class="si">${s.status === 'done' ? html`<${Icon} name="check" />` : s.status === 'failed' ? html`<${Icon} name="x" />` : ''}</span>
              <span>${s.label}</span>${s.detail && html`<span class="sd">${s.detail}</span>`}
            </div>`)}
        </div>
        ${job.error && html`<div style="margin-top:10px"><${ErrorBox} error=${{ message: job.error, hint: job.hint }} /></div>`}
        ${onDiscard && job.status === 'failed' && /unsaved work/.test(job.error || '') && html`<div class="row" style="margin-top:10px"><button class="btn danger" onClick=${onDiscard}><${Icon} name="trash-2" />Remove anyway, discard changes</button></div>`}
        ${job.log.length > 0 && html`
          <details style="margin-top:10px" open=${job.status === 'failed'}>
            <summary class="linkish" style="cursor:pointer"><${Icon} name="scroll-text" cls="sm" />Log · ${job.log.length} lines</summary>
            <pre class="logbox" style="margin-top:8px" ref=${logRef}>${job.log.join('\n')}</pre>
          </details>`}
      </div>
    </div>`;
}

function EnvPane({ c, env, reload, jobId, setJobId, onRemoved, removeDiscard }) {
  const [details, setDetails] = useState(null);
  const [err, setErr] = useState(null);
  const up = env?.services?.server.state === 'running';
  const loadDetails = () => call('GET', `/env/details?${qs({ path: c.path })}`).then(setDetails).catch((e) => setDetails({ licenseError: e.message }));
  useEffect(() => { loadDetails(); }, [c.path, up]);
  if (!env) return html`<div class="scroll"><div class="muted">Loading…</div></div>`;
  // (a worktree being removed stops looking like ToolJet halfway; keep its progress visible)
  if (!env.tooljet) return html`<div class="scroll"><div class="stack">${jobId ? html`<${JobView} key=${jobId} jobId=${jobId} onDone=${(j) => j.title === 'Remove worktree' && j.status === 'done' && onRemoved()} />` : html`<div class="card"><div class="card-b muted">No ToolJet dev environment here.</div></div>`}</div></div>`;

  const st = envState(env);
  const s = env.services;
  const busy = env.job?.status === 'running';
  const anyUp = ['running', 'starting'].includes(s.server.state) || ['running', 'starting'].includes(s.frontend.state);
  const act = async (a) => {
    if (!(await okToStart(c, a))) return;
    setErr(null);
    try { setJobId((await call('POST', `/env/${a}`, { path: c.path })).id); reload(); } catch (e) { setErr(e); }
  };
  const applyKey = async () => {
    setErr(null);
    try { setJobId((await call('POST', '/env/license', { path: c.path })).id); } catch (e) { setErr(e); }
  };
  const jobDone = (j) => {
    reload();
    loadDetails();
    if (j.title === 'Remove worktree' && j.status === 'done') onRemoved();
  };
  const lic = details?.license;
  const org = env.org || details?.org;
  const url = s.frontend.url;

  return html`
    <div class="scroll"><div class="stack">
      <div class="card">
        <div class="hero">
          <div class=${`hero-icon ${st.cls}`}><${Icon} name=${st.icon} cls=${`lg ${st.icon === 'loader-circle' ? 'spin' : ''}`} /></div>
          <div class="hero-text"><b>${st.label}</b><span>${st.sub}</span></div>
          <div class="hero-actions">
            ${!anyUp && html`<button class="btn primary" disabled=${busy} onClick=${() => act('start')}><${Icon} name="play" />${env.ready ? 'Start' : 'Set up & start'}</button>`}
            ${!anyUp && !env.ready && html`<button class="btn" disabled=${busy} onClick=${() => act('setup')}>Set up only</button>`}
            ${anyUp && html`<button class="btn" disabled=${busy} onClick=${() => act('stop')}><${Icon} name="square" />Stop</button>`}
            ${anyUp && html`<button class="btn" disabled=${busy} onClick=${() => act('restart')}><${Icon} name="rotate-cw" />Restart</button>`}
            ${s.frontend.state === 'running' && html`<a class="btn hide-phone" href=${url} target="_blank" rel="noopener"><${Icon} name="external-link" />Open app</a>`}
          </div>
        </div>
        <div class="facts">
          <div class="fact"><div>Frontend</div><b class="mono">${s.frontend.port ? `:${s.frontend.port} · ${s.frontend.state}` : '—'}</b></div>
          <div class="fact"><div>Server</div><b class="mono">${s.server.port ? `:${s.server.port} · ${s.server.state}` : '—'}</b></div>
          <div class="fact"><div>Database</div><b class="mono" title=${env.db || ''}>${env.db ? (env.dbExists ? env.db : `${env.db} (missing)`) : '—'}</b></div>
          <div class="fact"><div>Edition</div><b>${env.edition.toUpperCase()}${env.deps ? '' : ' · no deps'}</b></div>
        </div>
      </div>
      <${ErrorBox} error=${err} />
      ${jobId && html`<${JobView} key=${jobId} jobId=${jobId} onDone=${jobDone} onDiscard=${removeDiscard} />`}

      <div class="cols">
        <div class="card">
          <div class="card-h"><h3><${Icon} name="key-round" />Sign in</h3>${url && s.frontend.state === 'running' && html`<a class="linkish hide-phone" href=${url} target="_blank" rel="noopener">Open <${Icon} name="external-link" cls="sm" /></a>`}</div>
          <div class="card-b">
            <dl class="kv">
              <dt>URL</dt><dd>${url ? html`<span class="mono ellipsis">${url.replace('http://', '')}</span><${Copy} text=${url} />` : html`<span class="muted">after setup</span>`}</dd>
              <dt>Email</dt><dd><span class="mono ellipsis">${env.login.email}</span><${Copy} text=${env.login.email} /></dd>
              <dt>Password</dt><dd><span class="mono">${env.login.password}</span><${Copy} text=${env.login.password} /></dd>
              <dt>Workspace</dt><dd>${org ? html`<span class="ellipsis">${org.name || org.id}</span>` : html`<span class="muted">${up ? '—' : 'once the server runs'}</span>`}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-h">
            <h3><${Icon} name="sparkles" />License</h3>
            ${lic && html`<span class=${`pill ${lic.valid && !lic.expired ? 'ok' : 'bad'}`}>${lic.expired ? 'Expired' : lic.valid ? 'Valid' : 'Basic plan'}</span>`}
          </div>
          <div class="card-b">
            ${!details ? html`<span class="muted">Loading…</span>` : !lic ? html`<span class="muted">${details.licenseError}</span>` : html`
              <dl class="kv">
                ${lic.expiry && html`<dt>Expires</dt><dd>${fmtDate(lic.expiry)}</dd>`}
                ${lic.type && html`<dt>Type</dt><dd>${lic.type}</dd>`}
                <dt>Features</dt><dd>${lic.features.filter((f) => f.on).length} of ${lic.features.length} on</dd>
                <dt>Auto-apply</dt><dd>${env.licenseKeySet ? html`<span>on${env.licensed ? ` · …${env.licensed}` : ''}</span>${up && html`<button class="btn sm ghost" onClick=${applyKey}>Apply now</button>`}` : html`<span class="muted">add a key in Settings</span>`}</dd>
              </dl>`}
          </div>
          ${lic?.limits?.length > 0 && html`
            <details class="disclose" style="border-top:1px solid var(--border)">
              <summary>Limits & features<${Icon} name="chevron-down" cls="chev" /></summary>
              <div class="card-b" style="display:grid;gap:12px">
                <div class="limits">${lic.limits.map((l) => html`<div><b>${l.value === 'UNLIMITED' ? '∞' : l.value}</b>${l.name}</div>`)}</div>
                <div class="chips">${lic.features.map((f) => html`<span class=${`chip ${f.on ? 'on' : 'off'}`}>${f.name}</span>`)}</div>
              </div>
            </details>`}
        </div>
      </div>

      <${Logs} path=${c.path} />
    </div></div>`;
}

// The newest lines of a server's log, kept at the bottom and refreshed every 5 s while open (unless you scroll up
// to read). Earlier runs (each server start begins a new log; the last 5 are kept) are picked from the list.
function Logs({ path }) {
  const [name, setName] = useState('server');
  const [run, setRun] = useState('');
  const [log, setLog] = useState(null);
  const [open, setOpen] = useState(false);
  const box = useRef();
  const load = () => call('GET', `/env/log?${qs({ path, name, run, lines: 400 })}`).then(setLog).catch((e) => setLog({ text: e.message }));
  useEffect(() => { setLog(null); if (box.current) delete box.current.dataset.read; }, [path, name, run]);
  usePoll(() => open && (!run || !log) && load(), 5000, [path, name, run, open, !log]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && (!el.dataset.read || el.scrollHeight - el.scrollTop - el.clientHeight < 40)) el.scrollTop = el.scrollHeight;
    if (el && log) el.dataset.read = '1';
  }, [log?.text]);
  const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return html`
    <details class="card disclose" onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary><${Icon} name="scroll-text" />Logs<${Icon} name="chevron-down" cls="chev" /></summary>
      <div class="card-b" style="display:grid;gap:10px">
        <div class="row wrap">
          <div class="seg">${['server', 'frontend', 'setup'].map((n) => html`<button class=${n === name ? 'sel' : ''} onClick=${() => { setName(n); setRun(''); }}>${n}</button>`)}</div>
          ${log?.runs?.length > 0 && html`
            <select class="run-pick" value=${run} onChange=${(e) => setRun(e.target.value)} title="Earlier runs: each start begins a new log">
              <option value="">Latest run</option>
              ${log.runs.map((r) => html`<option value=${r.id}>Run of ${when(r.updated)}</option>`)}
            </select>`}
          <span class="grow"></span>
          ${log?.file && html`<span class="small subtle ellipsis" title=${log.file}>${log.updated ? `updated ${ago(log.updated / 1000)}` : 'no log yet'}</span>`}
        </div>
        <pre class="logbox tall" ref=${box}>${log ? log.text || 'Nothing logged yet.' : 'Loading…'}</pre>
      </div>
    </details>`;
}

// ---------- screens ----------

// Env controls for a ToolJet checkout, shared by the session and worktree screens.
// The main checkout's servers use the default ports; starting them by accident clashes with ones you run by hand.
const okToStart = async (c, a) => a !== 'start' || !c?.main || ask({ title: 'Start the main checkout\'s servers?', body: `${shortPath(c.path)} runs on the default ports, which servers you start by hand also use.`, ok: 'Start servers' });

function useEnvControls(co, fast) {
  const path = co?.path || '';
  const [env, reload] = useEnv(path, !!co?.tooljet, fast);
  const live = co?.servers ? `${!!co.servers.server}/${!!co.servers.frontend}` : '';
  useEffect(() => { if (live && env) reload(); }, [live]); // a server went up or down (started from a terminal, crashed…)
  const [jobId, setJobId] = useState(store.get(`job.${path}`, null));
  useEffect(() => { setJobId(store.get(`job.${path}`, null)); }, [path]);
  // follow a job the server reports (started from New, or from another device)
  useEffect(() => { if (env?.job?.status === 'running' && env.job.id !== jobId) setJobId(env.job.id); }, [env?.job?.id, env?.job?.status]);
  useEffect(() => { if (path) store.set(`job.${path}`, jobId); }, [jobId]);
  const s = env?.services;
  const anyUp = !!s && (['running', 'starting'].includes(s.server.state) || ['running', 'starting'].includes(s.frontend.state));
  const busy = env?.job?.status === 'running';
  const act = async (a) => {
    if (!(await okToStart(co, a))) return false;
    try { setJobId((await call('POST', `/env/${a}`, { path })).id); reload(); return true; } catch (e) { toast(e.message); return false; }
  };
  return { env, reload, jobId, setJobId, anyUp, busy, act, st: envState(env) };
}

function useLens(key, allowed, fallback) {
  const [lens, set] = useState(store.get(key, fallback));
  const [visited, setVisited] = useState({ [lens]: true });
  const cur = allowed.includes(lens) ? lens : fallback;
  const pick = (l) => { set(l); store.set(key, l); setVisited((v) => ({ ...v, [l]: true })); };
  return [cur, pick, visited];
}

function LensNav({ lenses, cur, pick, changes, bottom }) {
  const badge = (id) => id === 'changes' && changes > 0 && html`<span class="n">${changes}</span>`;
  return bottom
    ? html`<nav class="bottom-nav">${lenses.map(([id, label, icon]) => html`<button class=${cur === id ? 'sel' : ''} onClick=${() => pick(id)}><${Icon} name=${icon} />${label}${badge(id)}</button>`)}</nav>`
    : html`<nav class="lens-tabs">${lenses.map(([id, label, icon]) => html`<button class=${`lens-tab ${cur === id ? 'sel' : ''}`} onClick=${() => pick(id)}><${Icon} name=${icon} />${label}${badge(id)}</button>`)}</nav>`;
}

function EnvButtons({ co, ec, hide }) {
  if (!co?.tooljet || !ec.env || hide) return null;
  const { st, anyUp, busy, act, env } = ec;
  return html`
    ${st?.cls && html`<span class=${`pill ${st.cls} hide-phone`}><span class=${`dot ${st.cls}`}></span>${st.label}</span>`}
    ${!anyUp && html`<button class="btn sm hide-phone" disabled=${busy} onClick=${() => act('start')} title="Start the ToolJet servers"><${Icon} name="play" cls="sm" />${env.ready ? 'Start servers' : 'Set up & start'}</button>`}
    ${anyUp && html`<button class="btn sm hide-phone" disabled=${busy} onClick=${() => act('stop')}><${Icon} name="square" cls="sm" />Stop</button>`}`;
}

function MenuButton({ items }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="menu-wrap">
      <button class="icon-btn" onClick=${() => setOpen(!open)} aria-label="More"><${Icon} name="ellipsis" /></button>
      ${open && html`<${Menu} items=${items} onClose=${() => setOpen(false)} />`}
    </div>`;
}

async function removeWorktree(co, ec, discard) {
  if (!discard && !(await ask({ title: 'Remove this worktree?', body: `${shortPath(co.path)}\n\nThis will stop its servers, end its sessions, drop its databases and delete the folder. The branch will be kept.`, ok: 'Remove worktree', danger: true }))) return false;
  if (discard && !(await ask({ title: 'Discard changes and remove?', body: 'Uncommitted changes and unpushed EE commits will be lost, then the worktree will be removed.', ok: 'Discard & remove', danger: true }))) return false;
  try { ec.setJobId((await call('POST', '/worktrees/remove', { path: co.path, discard: !!discard })).id); return true; } catch (e) { toast(e.message); return false; }
}

const vscode = async (path) => { try { await call('POST', '/open/vscode', { path }); toast('Opened in VS Code on the Mac'); } catch (e) { toast(e.message); } };

// A session: terminal tabs in some folder, plus the folder's git and ToolJet tools when it has them.
function SessionView({ s, co, siblings, refresh, onBack, openWorktree, openSession, onRenamed, goHome }) {
  // Changes needs git; Code opens any folder (except your whole home folder)
  const lenses = [['terminal', 'Terminal', 'terminal'], s.git && ['changes', 'Changes', 'file-diff'], !isHome(s.path) && ['code', 'Code', 'code-xml'], co?.tooljet && ['env', 'Env', 'server']].filter(Boolean);
  const [cur, pick, visited] = useLens(`lens.s.${s.name}`, lenses.map(([id]) => id), 'terminal');
  const ec = useEnvControls(co, cur === 'env');
  const [renaming, setRenaming] = useState(false);
  // select the new name before the list refreshes, or the old one looks like it vanished
  const renameTo = (to) => renameSessionTo(s, to, refresh, (_, name) => onRenamed(name));
  const rename = () => {
    if (!phone()) return setRenaming(true); // in place, on the header
    const to = prompt('Rename session', s.name);
    if (to && to !== s.name) renameTo(to);
  };
  const end = async () => {
    if (!(await ask(END_SESSION(s)))) return;
    await call('DELETE', `/sessions/${encodeURIComponent(s.name)}`);
    refresh();
  };
  const items = [
    { icon: 'plus', label: 'New session here', run: () => sessionHere(s, refresh, openSession) },
    { icon: 'pencil', label: 'Rename session', run: rename },
    { icon: 'folder-input', label: 'Run in another folder…', run: () => ui.moveSession(s) },
    co && { icon: 'git-branch', label: 'Open worktree', run: () => openWorktree(co.path) },
    co?.tooljet && '-',
    co?.tooljet && !ec.anyUp && { icon: 'play', label: ec.env?.ready ? 'Start servers' : 'Set up & start servers', run: () => ec.act('start') && pick('env') },
    co?.tooljet && ec.anyUp && { icon: 'square', label: 'Stop servers', run: () => ec.act('stop') },
    '-',
    !isHome(s.path) && { icon: 'external-link', label: 'Open code in a new tab', run: () => window.open(codeUrl(s.path), '_blank', 'noopener') },
    !isHome(s.path) && { icon: 'monitor', label: 'Open in VS Code on the Mac', run: () => vscode(s.path) },
    { icon: 'copy', label: 'Copy folder path', run: () => copy(s.path) },
    '-',
    { icon: 'power', label: 'End session', danger: true, run: end },
  ];
  const changes = co?.stats?.changes || 0;
  const envActive = cur === 'env';
  // folder › session, then where it runs (the worktree opens its env, changes and code)
  const where = whereOf(s, co);
  const crumbs = [
    s.folder && { label: s.folder, icon: 'folder-closed', rename: (to) => renameFolderTo(s.folder, to, refresh) },
    { label: s.name, icon: 'terminal', rename: renameTo, editing: renaming, onEditEnd: () => setRenaming(false) },
    { node: co
      ? html`<button class="where-chip" title="Open this worktree" onClick=${() => openWorktree(co.path)}><${Icon} name=${where.icon} cls="xs" /><span class="ellipsis">${where.text}</span></button>`
      : html`<span class="where-chip plain" title=${shortPath(s.path)}><${Icon} name=${where.icon} cls="xs" /><span class="ellipsis">${where.text}</span></span>` },
  ].filter(Boolean);

  return html`
    <div class="view">
      <${TopBar} onBack=${onBack} crumbs=${crumbs} title=${s.name} lenses=${lenses} cur=${cur} pick=${pick} changes=${changes}
        sub=${co ? html`<button class="crumb" onClick=${() => openWorktree(co.path)}><${Icon} name="git-branch" cls="sm" />${coTitle(co)}<${Icon} name="chevron-right" cls="sm" /></button>${co.pr && html`<${PrBadge} pr=${co.pr} link />`}` : shortPath(s.path)}>
        ${co?.tooljet && ec.st && html`<button class=${`pill ${ec.st.cls} only-phone`} onClick=${() => pick('env')}><span class=${`dot ${ec.st.cls || 'off'}`}></span></button>`}
        <${EnvButtons} co=${co} ec=${ec} hide=${envActive} />
        ${co?.pr && html`<span class="hide-phone"><${PrBadge} pr=${co.pr} link /></span>`}
        <${MenuButton} items=${items} />
      </${TopBar}>
      <div class="pane" hidden=${cur !== 'terminal'}>${(visited.terminal || cur === 'terminal') && html`<${TerminalPane} key=${s.name} s=${s} siblings=${siblings} refresh=${refresh} openSession=${openSession} onRenamed=${onRenamed} />`}</div>
      ${cur === 'changes' && html`<div class="pane"><${ChangesPane} path=${s.path} /></div>`}
      <div class="pane" hidden=${cur !== 'code'}>${visited.code && html`<${CodePane} path=${s.path} active=${cur === 'code'} />`}</div>
      ${envActive && html`<div class="pane"><${EnvPane} c=${co} env=${ec.env} reload=${ec.reload} jobId=${ec.jobId} setJobId=${ec.setJobId} onRemoved=${() => toast('Worktree removed')} removeDiscard=${() => removeWorktree(co, ec, true)} /></div>`}
      ${lenses.length > 1 && html`<${LensNav} lenses=${lenses} cur=${cur} pick=${pick} changes=${changes} bottom />`}
    </div>`;
}

// A worktree: its dev environment, changes and code, and the sessions open in it.
function WorktreeView({ c, sessions, refresh, onBack, openSession, goHome }) {
  const lenses = [c.tooljet && ['env', 'Env', 'server'], ['changes', 'Changes', 'file-diff'], ['code', 'Code', 'code-xml']].filter(Boolean);
  const [cur, pick, visited] = useLens(`lens.w.${c.path}`, lenses.map(([id]) => id), lenses[0][0]);
  const ec = useEnvControls(c, cur === 'env');
  const [busy, setBusy] = useState(false);
  const here = sessions.filter((s) => s.checkout === c.path);
  const newSession = async () => {
    setBusy(true);
    try { const out = await call('POST', '/sessions', { path: c.path }); await refresh(); openSession(out.name); } catch (e) { toast(e.message); }
    setBusy(false);
  };
  const items = [
    { icon: 'terminal', label: 'New session here', run: newSession },
    c.tooljet && '-',
    c.tooljet && !ec.anyUp && { icon: 'play', label: ec.env?.ready ? 'Start servers' : 'Set up & start servers', run: () => ec.act('start') && pick('env') },
    c.tooljet && ec.anyUp && { icon: 'square', label: 'Stop servers', run: () => ec.act('stop') },
    '-',
    { icon: 'external-link', label: 'Open code in a new tab', run: () => window.open(codeUrl(c.path), '_blank', 'noopener') },
    { icon: 'monitor', label: 'Open in VS Code on the Mac', run: () => vscode(c.path) },
    { icon: 'copy', label: 'Copy path', run: () => copy(c.path) },
    !c.main && '-',
    !c.main && { icon: 'trash-2', label: 'Remove worktree', danger: true, run: async () => (await removeWorktree(c, ec, false)) && c.tooljet && pick('env') },
  ];
  return html`
    <div class="view">
      <${TopBar} onBack=${onBack} crumbs=${[{ label: c.project, icon: 'folder-git-2', go: goHome }, { label: coTitle(c), icon: 'git-branch' }]}
        title=${coTitle(c)} sub=${`${c.project} · ${shortPath(c.path)}`} lenses=${lenses} cur=${cur} pick=${pick} changes=${c.stats?.changes || 0}>
        ${c.tooljet && ec.st && html`<span class=${`pill ${ec.st.cls} only-phone`}><span class=${`dot ${ec.st.cls || 'off'}`}></span></span>`}
        <${EnvButtons} co=${c} ec=${ec} hide=${cur === 'env'} />
        ${c.pr && html`<span class="hide-phone"><${PrBadge} pr=${c.pr} link /></span>`}
        <${MenuButton} items=${items} />
      </${TopBar}>
      ${cur !== 'code' && html`<div class="here">
        <span class="here-l">${here.length ? 'Sessions' : 'No session here yet'}</span>
        ${here.map((s) => { const t = leadTab(s); return html`<button class="chip-btn" onClick=${() => openSession(s.name)}><span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>${s.name}</button>`; })}
        <button class="chip-btn add" disabled=${busy} onClick=${newSession}><${Icon} name="plus" cls="sm" />New session here</button>
      </div>`}
      ${cur === 'changes' && html`<${PrCard} key=${c.path} c=${c} />`}
      ${cur === 'env' && html`<div class="pane"><${EnvPane} c=${c} env=${ec.env} reload=${ec.reload} jobId=${ec.jobId} setJobId=${ec.setJobId} onRemoved=${() => toast('Worktree removed')} removeDiscard=${() => removeWorktree(c, ec, true)} /></div>`}
      ${cur === 'changes' && html`<div class="pane"><${ChangesPane} path=${c.path} /></div>`}
      <div class="pane" hidden=${cur !== 'code'}>${visited.code && html`<${CodePane} path=${c.path} active=${cur === 'code'} />`}</div>
      <${LensNav} lenses=${lenses} cur=${cur} pick=${pick} changes=${c.stats?.changes || 0} bottom />
    </div>`;
}

// ---------- overview ----------

const Section = ({ title, aside, children }) => html`
  <section class="ov-sec"><div class="ov-h"><h2>${title}</h2><span class="ov-rule"></span>${aside}</div>${children}</section>`;

const ago = (sec) => {
  const m = Math.floor((Date.now() / 1000 - sec) / 60);
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

// what's blocking a PR, for the "needs you" list (null when nothing is)
function prBlock(pr) {
  if (pr?.state !== 'OPEN' || prLook(pr).cls !== 'bad') return null;
  return pr.checks.failed ? `${plural(pr.checks.failed, 'failing check')}` : pr.conflicts ? 'conflicts' : 'changes requested';
}

// Desktop home: what needs you (agents asking, PRs blocked), recent sessions, active worktrees.
// The Mac's health lives in the status bar.
function Overview({ data, idx, refresh, openSession, openWorktree, onNew, onWorktrees }) {
  if (!data) return html`<div class="scroll muted">Loading…</div>`;
  const waiting = data.sessions.flatMap((s) => s.tabs.filter((t) => t.agent === 'waiting').map((t) => ({ s, t })));
  const all = checkoutsOf(data, idx);
  const blocked = all.filter((pl) => prBlock(pl.co.pr));
  const places = all.filter((p) => p.active);
  const recent = [...data.sessions].sort((a, b) => b.activity - a.activity).slice(0, 6);
  const needs = waiting.length + blocked.length;
  return html`
    <div class="scroll overview"><div class="ov">
      <${Section} title="Needs you" aside=${needs > 0 && html`<span class="ov-aside warn-text">${needs}</span>`}>
        ${needs ? html`<div class="ov-list">
          ${waiting.map(({ s, t }) => html`
            <div class="ov-ask">
              <button class="ov-row" onClick=${() => openSession(s.name)}>
                <span class="dot warn"></span><b class="ellipsis">${s.name}</b><span class="muted ellipsis">› ${t.program}</span>
                <span class="grow"></span><span class="warn-text">waiting for you</span><${Icon} name="arrow-up-right" cls="sm muted" /></button>
              <${Replies} t=${t} refresh=${refresh} />
            </div>`)}
          ${blocked.map((pl) => html`
            <button class="ov-row" onClick=${() => openWorktree(pl.key)}>
              <${PrBadge} pr=${pl.co.pr} /><b class="ellipsis">${coTitle(pl.co)}</b><span class="muted ellipsis">${pl.co.pr.title}</span>
              <span class="grow"></span><span class="bad-text">${prBlock(pl.co.pr)}</span><${Icon} name="arrow-up-right" cls="sm muted" /></button>`)}
        </div>` : html`<p class="ov-empty"><${Icon} name="circle-check" cls="sm" /> Nothing needs you right now.</p>`}
      </${Section}>
      <${Section} title="Recent sessions" aside=${html`<button class="btn sm" onClick=${onNew}><${Icon} name="plus" cls="sm" />New session</button>`}>
        ${recent.length ? html`<div class="ov-list">${recent.map((s) => {
          const t = leadTab(s);
          const a = t?.agent && t.agent !== 'idle' && AGENT[t.agent];
          const where = whereOf(s, s.checkout && idx.get(s.checkout));
          return html`
            <button class="ov-row" onClick=${() => openSession(s.name)}>
              <span class=${`dot ${t ? tabDot(t) : 'off'}`}></span><b class="ellipsis">${s.name}</b>
              <span class="muted ellipsis row"><${Icon} name=${where.icon} cls="xs" />${where.text}</span>
              <span class="grow"></span>${a && html`<span class=${a[2]}>${a[1]}</span>`}<span class="subtle">${ago(s.activity)}</span></button>`;
        })}</div>` : html`<p class="ov-empty">No sessions yet.</p>`}
      </${Section}>
      ${places.length > 0 && html`
        <${Section} title="Active worktrees" aside=${html`<button class="btn sm ghost" onClick=${onWorktrees}>All ${all.length}<${Icon} name="chevron-right" cls="sm" /></button>`}>
          <div class="ov-grid">${places.map((pl) => {
            const st = serverState(pl.co);
            return html`
              <button class="ov-card" onClick=${() => openWorktree(pl.key)}>
                <span class="ov-card-t"><${Icon} name="git-branch" cls="sm" /><span class="ellipsis">${coTitle(pl.co)}</span>${pl.co.pr && html`<${PrBadge} pr=${pl.co.pr} />`}</span>
                <span class="ov-card-s">${pl.project}${pl.co.stats?.changes ? ` · ${plural(pl.co.stats.changes, 'change')}` : ''}</span>
                <span class="ov-card-s">${st ? html`<span class=${`${st}-text`}><span class=${`dot ${st}`}></span> :${pl.co.servers.ports.frontend}</span>` : html`<span class="subtle">servers off</span>`} · ${plural(pl.sessions.length, 'session')}</span>
              </button>`;
          })}</div>
        </${Section}>`}
    </div></div>`;
}

// ---------- worktrees ----------

// Every checkout of your projects in one list: branch, PR, changes, servers and the sessions running there.
// Open one for its dev environment, changes and code; + starts a session in it.
function WorktreesView({ data, idx, openWorktree, openSession, addHere, adding, onNewWorktree }) {
  if (!data) return html`<div class="scroll muted">Loading…</div>`;
  const all = checkoutsOf(data, idx);
  return html`
    <div class="scroll"><div class="wts">
      ${data.projects.map((p) => {
        const rows = all.filter((x) => x.co.projectPath === p.path);
        return html`
          <section class="wt-sec">
            <div class="wt-h"><${Icon} name="folder-git-2" cls="sm" /><b>${p.name}</b><span class="muted small">${plural(rows.length, 'checkout')}</span><span class="grow"></span>
              <button class="btn sm" onClick=${onNewWorktree}><${Icon} name="git-branch" cls="sm" />New worktree</button></div>
            <div class="wt-list">${rows.map(({ key, co, sessions }) => {
              const st = serverState(co);
              return html`
                <div class="wt-row" onClick=${() => openWorktree(key)}>
                  <${Icon} name=${co.main ? 'folder-git-2' : 'git-branch'} cls="sm muted" />
                  <span class="wt-main">
                    <span class="wt-t"><span class="ellipsis">${coTitle(co)}</span>${co.main && html`<span class="tag">main checkout</span>`}${co.pr && html`<${PrBadge} pr=${co.pr} />`}</span>
                    <span class="wt-s">
                      ${co.stats?.changes > 0 ? html`<span>${plural(co.stats.changes, 'change')}</span>` : html`<span class="subtle">clean</span>`}
                      ${st ? html`<span class=${`port ${st}`}><span class=${`dot ${st}`}></span>:${co.servers.ports.frontend}</span>` : p.tooljet && html`<span class="subtle">servers off</span>`}
                      <span class="subtle ellipsis">${shortPath(co.path)}</span>
                    </span>
                  </span>
                  <span class="wt-sess">${sessions.map((s) => { const t = leadTab(s); return html`<button class="chip-btn" onClick=${(e) => { e.stopPropagation(); openSession(s.name); }}><span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>${s.name}</button>`; })}</span>
                  <button class="icon-btn sm" title="New session here" disabled=${adding === key} onClick=${(e) => { e.stopPropagation(); addHere(key); }}><${Icon} name=${adding === key ? 'loader-circle' : 'plus'} cls=${`sm ${adding === key ? 'spin' : ''}`} /></button>
                </div>`;
            })}</div>
          </section>`;
      })}
      ${!data.projects.length && html`<p class="ov-empty">No git projects found. Add the folder that holds them in Settings.</p>`}
    </div></div>`;
}

// ---------- new session ----------

// Which sidebar folder the new session goes in.
const FolderPick = ({ folders, value, onChange }) => folders.length > 0 && html`
  <div class="field"><label>Sidebar folder</label>
    <div class="chips">
      <button class=${`chip-btn ${!value ? 'sel' : ''}`} onClick=${() => onChange('')}>None</button>
      ${folders.map((f) => html`<button class=${`chip-btn ${value === f ? 'sel' : ''}`} onClick=${() => onChange(f)}><${Icon} name="folder-closed" cls="sm" />${f}</button>`)}
    </div>
  </div>`;

// Every place a session can live: Home, each checkout, plain folders, and the open session's folder.
function placesOf(folders, here) {
  const places = [
    { path: '~', icon: 'folder', title: 'Home', sub: '~' },
    ...(folders?.checkouts || []).map((c) => ({ path: c.path, icon: c.main ? 'folder-git-2' : 'git-branch', title: c.main ? c.project : c.name, sub: c.main ? `${c.branch} · ${shortPath(c.path)}` : `${c.project} · ${shortPath(c.path)}` })),
    ...(folders?.folders || []).map((c) => ({ path: c.path, icon: 'folder-open', title: c.name, sub: shortPath(c.path) })),
  ];
  if (here && !places.some((p) => p.path === here)) places.splice(1, 0, { path: here, icon: 'folder-open', title: here.split('/').pop(), sub: shortPath(here) });
  return places;
}

// Pick one of those places, browse to any folder, or type a path. Double-click a place (or Enter on a typed path)
// goes straight there.
function WherePicker({ folders, here, where, setWhere, go }) {
  const [filter, setFilter] = useState('');
  const [browse, setBrowse] = useState(null); // the folder being browsed: { path, parent, dirs }
  const places = placesOf(folders, here);
  const f = filter.trim().toLowerCase();
  const typed = /^[~/]/.test(filter.trim()) && !places.some((p) => p.path === filter.trim());
  // browsing: the folder you're in is the one chosen
  const open = async (path) => {
    try {
      const d = await call('GET', `/dirs?${qs({ path })}`);
      setBrowse(d);
      setWhere(d.path);
      setFilter('');
    } catch (e) { toast(e.message); }
  };
  const input = (placeholder, onEnter) => html`
    <input placeholder=${placeholder} value=${filter} onInput=${(e) => setFilter(e.target.value)} autocapitalize="off" spellcheck="false"
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }} />`;

  if (browse) {
    const dirs = browse.dirs.filter((d) => !f || d.name.toLowerCase().includes(f));
    return html`
      <div class="where">
        <div class="where-search"><${Icon} name="search" cls="sm" />
          ${input(`Filter, or type a path`, () => (typed ? open(filter.trim()) : dirs[0] && open(dirs[0].path)))}
          <button class="where-mode" onClick=${() => { setBrowse(null); setFilter(''); }}><${Icon} name="list-tree" cls="sm" />Places</button>
        </div>
        <div class="where-here">
          <button class="icon-btn sm" title="Up a folder" disabled=${!browse.parent} onClick=${() => open(browse.parent)}><${Icon} name="corner-left-up" cls="sm" /></button>
          <span class="where-t ellipsis">${shortPath(browse.path)}</span>
          <${Icon} name="check" cls="sm where-ok" />
        </div>
        <div class="where-list">
          ${dirs.map((d) => html`
            <button class="where-item" onClick=${() => open(d.path)}>
              <${Icon} name=${d.git ? 'folder-git-2' : 'folder'} cls="sm" /><span class="where-t ellipsis">${d.name}</span><${Icon} name="chevron-right" cls="sm where-go" />
            </button>`)}
          ${!dirs.length && html`<div class="where-empty">${f ? 'Nothing matches.' : 'No folders inside.'}</div>`}
        </div>
      </div>`;
  }
  const shown = places.filter((p) => !f || `${p.title} ${p.sub}`.toLowerCase().includes(f) || p.path === where);
  return html`
    <div class="where">
      <div class="where-search"><${Icon} name="search" cls="sm" />
        ${input('Filter, or type a path', () => (typed ? go(filter.trim()) : shown[0] && setWhere(shown[0].path)))}
        <button class="where-mode" title="Click through your folders to pick any one" onClick=${() => open(where || '~')}><${Icon} name="folder-search" cls="sm" />Browse</button>
      </div>
      <div class="where-list">
        ${!folders && html`<div class="where-empty">Loading…</div>`}
        ${typed && html`<button class="where-item" onClick=${() => go(filter.trim())}><${Icon} name="folder-open" cls="sm" /><span class="where-t ellipsis">Open ${filter.trim()}</span></button>`}
        ${shown.map((p) => html`
          <button class=${`where-item ${p.path === where ? 'sel' : ''}`} onClick=${() => setWhere(p.path)} onDblClick=${() => go(p.path)}>
            <${Icon} name=${p.icon} cls="sm" /><span class="where-t ellipsis">${p.title}</span><span class="where-s ellipsis">${p.sub}</span>
            ${p.path === where && html`<${Icon} name="check" cls="sm where-ok" />`}
          </button>`)}
        ${folders && !shown.length && !typed && html`<div class="where-empty">Nothing matches.</div>`}
      </div>
    </div>`;
}

// Run a session in another folder or worktree. Devdeck's views switch at once; an idle shell cds there, while a
// running program (Claude, a server) stays where it started until it's restarted.
function MoveSheet({ s, onClose, onDone }) {
  const [folders, setFolders] = useState(null);
  const [where, setWhere] = useState(s.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const t = leadTab(s);
  useEffect(() => {
    call('GET', '/folders').then(setFolders).catch(setError);
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  const go = async (path) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { onDone(await call('PUT', `/sessions/${encodeURIComponent(s.name)}/path`, { path }), t?.busy && t.program); } catch (e) { setError(e); setBusy(false); }
  };
  return html`
    <div class="backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet new-sheet" role="dialog" aria-label="Move session">
        <div class="grabber"></div>
        <div class="sheet-h">
          <h2 class="ellipsis">Move ${s.name}</h2>
          <span class="grow"></span>
          <button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
        </div>
        <div class="sheet-b">
          <div class="field"><label>To another folder or worktree</label>
            <${WherePicker} folders=${folders} here=${s.path} where=${where} setWhere=${setWhere} go=${go} />
          </div>
          ${t?.busy && html`<div class="alert info"><${Icon} name="info" /><div><b>${t.program} keeps running in ${shortPath(s.path)}</b>
            <span>Changes, Code and Env switch now. Quit ${t.program} and start it again to work in the new folder.</span></div></div>`}
          <${ErrorBox} error=${error} />
        </div>
        <div class="sheet-f">
          <button class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${busy || where === s.path} onClick=${() => go(where)}>Move</button>
        </div>
      </div>
    </div>`;
}

// New session: one screen. Pick where (defaults to what's open), name it if you like, Enter. Or a new worktree.
function NewSheet({ onClose, onDone, initial, here, folder: inFolder = '', groups = [] }) {
  const [mode, setMode] = useState(initial === 'worktree' ? 'worktree' : 'session');
  const [repos, setRepos] = useState(null);
  const [folders, setFolders] = useState(null);
  const [name, setName] = useState('');
  const [where, setWhere] = useState(here || null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState([]);
  const [startEnv, setStartEnv] = useState(store.get('startEnv', true));
  const [opts, setOpts] = useState(false);
  const [folder, setFolder] = useState(inFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef();
  const branchRef = useRef();

  useEffect(() => {
    call('GET', '/repos').then((r) => { setRepos(r); setRepo((cur) => cur || r.find((x) => x.tooljet)?.path || r[0]?.path || ''); }).catch(setError);
    call('GET', '/folders').then((f) => { setFolders(f); setWhere((w) => w || f.checkouts.find((c) => c.main && c.tooljet)?.path || f.checkouts.find((c) => c.main)?.path || '~'); }).catch(setError);
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  useEffect(() => { if (repo) call('GET', `/branches?${qs({ path: repo })}`).then(setBranches).catch(() => setBranches([])); }, [repo]);
  useEffect(() => { if (!phone()) (mode === 'session' ? nameRef : branchRef).current?.focus(); }, [mode]);

  const tooljet = repos?.find((r) => r.path === repo)?.tooljet;
  const start = async (body) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { onDone(await call('POST', '/sessions', { name: name.trim(), folder, ...body })); } catch (e) { setError(e); setBusy(false); }
  };
  const createWorktree = () => {
    if (!branch.trim()) return;
    store.set('startEnv', startEnv);
    start({ worktree: { repo, branch: branch.trim(), base: base.trim() }, start: tooljet && startEnv });
  };
  const create = () => (mode === 'session' ? where && start({ path: where }) : createWorktree());

  const picked = placesOf(folders, here).find((p) => p.path === where);
  const auto = picked ? (picked.path === '~' ? 'terminal' : picked.title.split('/').pop()) : where?.split('/').pop() || 'session';

  return html`
    <div class="backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet new-sheet" role="dialog" aria-label="New session">
        <div class="grabber"></div>
        <div class="sheet-h">
          <div class="seg">
            <button class=${mode === 'session' ? 'sel' : ''} onClick=${() => setMode('session')}><${Icon} name="terminal" cls="sm" />Session</button>
            <button class=${mode === 'worktree' ? 'sel' : ''} onClick=${() => setMode('worktree')}><${Icon} name="git-branch" cls="sm" />New worktree</button>
          </div>
          <span class="grow"></span>
          <button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
        </div>

        ${mode === 'session' && html`
          <div class="sheet-b">
            <div class="field"><label>Name</label>
              <input ref=${nameRef} placeholder=${auto} value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} autocapitalize="off" spellcheck="false" />
            </div>
            <${FolderPick} folders=${groups} value=${folder} onChange=${setFolder} />
            <div class="field"><label>Starts in</label>
              <${WherePicker} folders=${folders} here=${here} where=${where} setWhere=${setWhere} go=${(path) => start({ path })} />
            </div>
            <${ErrorBox} error=${error} />
          </div>`}

        ${mode === 'worktree' && html`
          <div class="sheet-b">
            ${repos?.length > 1 && html`
              <div class="field"><label>Project</label>
                <select value=${repo} onChange=${(e) => setRepo(e.target.value)}>${repos.map((r) => html`<option value=${r.path}>${r.name}</option>`)}</select>
              </div>`}
            ${repos?.length === 0 && html`<div class="alert info"><${Icon} name="info" /><div><b>No git repos found</b><span>Add your project in Settings.</span></div></div>`}
            <div class="field">
              <label>Branch</label>
              <input ref=${branchRef} placeholder="feat/custom-component" value=${branch} onInput=${(e) => setBranch(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && createWorktree()}
                list="dd-branches" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <datalist id="dd-branches">${branches.map((b) => html`<option value=${b.replace(/^origin\//, '')} />`)}</datalist>
              <div class="hint">New or existing. An existing remote branch is checked out as is.</div>
            </div>
            ${tooljet && html`
              <label class="switch-row">
                <${Switch} checked=${startEnv} onChange=${setStartEnv} />
                <span><b>Start dev environment</b><span>Its own .env, ports and database; installs dependencies, then starts ToolJet with your license</span></span>
              </label>`}
            <div>
              <button class="linkish" onClick=${() => setOpts(!opts)}><${Icon} name="chevron-down" cls="sm" style=${opts ? 'transform:rotate(180deg)' : ''} />Options</button>
              ${opts && html`
                <div style="display:grid;gap:12px;margin-top:10px">
                  <div class="field"><label>Base branch</label>
                    <input placeholder="origin's default branch (origin/main)" value=${base} onInput=${(e) => setBase(e.target.value)} list="dd-bases" autocapitalize="off" autocorrect="off" spellcheck="false" />
                    <datalist id="dd-bases">${branches.map((b) => html`<option value=${b} />`)}</datalist>
                    <div class="hint">Only used when the branch doesn't exist yet.</div>
                  </div>
                  <div class="field"><label>Session name</label>
                    <input placeholder="Defaults to the branch name" value=${name} onInput=${(e) => setName(e.target.value)} autocapitalize="off" spellcheck="false" />
                  </div>
                </div>`}
            </div>
            <${FolderPick} folders=${groups} value=${folder} onChange=${setFolder} />
            <${ErrorBox} error=${error} />
          </div>`}

        <div class="sheet-f">
          <span class="sheet-hint hide-phone">${mode === 'session' ? html`<kbd>⏎</kbd> to create · double-click a place to create there` : html`<kbd>⏎</kbd> to create`}</span>
          <button class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${busy || (mode === 'session' ? !where : !branch.trim() || !repo)} onClick=${create}>${busy ? html`<${Icon} name="loader-circle" cls="spin" />Creating…` : 'Create'}</button>
        </div>
      </div>
    </div>`;
}

// ---------- tools & settings ----------

function ToolsView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(store.get('toolsTab', 'cli') === 'shell' ? 'shell' : 'cli');
  useEffect(() => { call('GET', '/tools').then(setData).catch(setErr); }, []);
  const pick = (t) => { setTab(t); store.set('toolsTab', t); };
  return html`
    <div class="scroll"><div class="stack">
      <div class="seg">
        <button class=${tab === 'cli' ? 'sel' : ''} onClick=${() => pick('cli')}>Command line</button>
        <button class=${tab === 'shell' ? 'sel' : ''} onClick=${() => pick('shell')}>Shell</button>
      </div>
      <${ErrorBox} error=${err} />
      ${!data && !err && html`<div class="muted">Checking…</div>`}
      ${data && tab === 'cli' && html`
        <div class="card"><div class="card-b tight"><ul class="list">
          ${data.clis.map((c) => html`<li>
            <span class=${`dot ${c.installed ? 'ok' : 'off'}`}></span>
            <b style="width:96px;flex:none">${c.name}</b>
            <span class="grow ellipsis small ${c.installed ? '' : 'muted'}">${c.installed ? c.version : 'not installed'}</span>
            ${c.path && html`<span class="mono small subtle ellipsis hide-phone" style="max-width:40%">${shortPath(c.path)}</span>`}
          </li>`)}
        </ul></div></div>`}
      ${data && tab === 'shell' && data.shell.map((f) => html`
        <div class="card">
          <div class="card-h"><h3 class="mono" style="font-weight:600">${f.file}</h3><span class="small muted">${f.defs.length}</span></div>
          <div class="card-b tight"><ul class="list">${f.defs.map((d) => html`<li><span class="tag">${d.kind}</span><b class="mono">${d.name}</b><span class="grow ellipsis mono small muted">${d.body}</span></li>`)}</ul></div>
        </div>`)}
    </div></div>`;
}

function SettingsView({ onSaved }) {
  const [s, setS] = useState(null);
  const [roots, setRoots] = useState([]);
  const [license, setLicense] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ts, setTs] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const v = await call('GET', '/settings');
    setS(v);
    setRoots(v.roots.length ? v.roots : ['']);
    setLicense('');
    setEmail(v.login.email);
    setPassword(v.login.password);
  };
  useEffect(() => { load().catch(setErr); call('GET', '/tailscale').then(setTs).catch(() => {}); }, []);
  const save = async (extra = {}) => {
    setSaving(true);
    setErr(null);
    try {
      await call('PUT', '/settings', { roots: roots.map((r) => r.trim()).filter(Boolean), ...(license.trim() ? { license: license.trim() } : {}), login: { email: email.trim(), password }, ...extra });
      await load();
      onSaved();
      toast('Saved');
    } catch (e) {
      setErr(e);
    }
    setSaving(false);
  };
  const share = async () => { setErr(null); try { setTs(await call('POST', '/tailscale/share')); } catch (e) { setErr(e); } };
  if (!s) return html`<div class="scroll"><div class="muted">Loading…</div></div>`;
  const report = (i) => s.rootsReport[i] && s.rootsReport[i].root === roots[i] ? s.rootsReport[i] : null;

  return html`
    <div class="scroll"><div class="stack" style="max-width:680px">
      <${ErrorBox} error=${err} />
      <div class="card">
        <div class="card-h"><h3><${Icon} name="sun-moon" />Appearance</h3></div>
        <div class="card-b"><dl class="kv"><dt>Theme</dt><dd><${ThemeSwitch} labels /></dd></dl></div>
      </div>
      <div class="card">
        <div class="card-h"><h3><${Icon} name="folder-git-2" />Projects</h3></div>
        <div class="card-b" style="display:grid;gap:10px">
          <div class="small muted">A repo (like ~/Work/ToolJet) or a folder that contains repos (like ~/Work). Worktrees are found automatically.</div>
          ${roots.map((r, i) => {
            const rep = report(i);
            return html`
              <div>
                <div class="row">
                  <input value=${r} placeholder="~/Work/ToolJet" autocapitalize="off" onInput=${(e) => setRoots(roots.map((x, j) => (j === i ? e.target.value : x)))} />
                  <button class="icon-btn" title="Remove" onClick=${() => setRoots(roots.filter((_, j) => j !== i))}><${Icon} name="x" /></button>
                </div>
                ${rep && html`<div class="small" style="margin:5px 2px 0;color:${rep.found ? 'var(--muted)' : 'var(--danger)'}">${!rep.found ? 'Folder not found' : rep.kind === 'repo' ? 'Git repo' : `Folder with ${plural(rep.repos, 'repo')}`}</div>`}
              </div>`;
          })}
          <div class="row"><button class="btn sm" onClick=${() => setRoots([...roots, ''])}><${Icon} name="plus" cls="sm" />Add</button><span class="grow"></span><button class="btn primary sm" disabled=${saving} onClick=${() => save()}>Save</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3><${Icon} name="sparkles" />ToolJet license</h3>${s.license ? html`<span class="pill ok">${s.license}</span>` : html`<span class="pill">None</span>`}</div>
        <div class="card-b" style="display:grid;gap:10px">
          <div class="small muted">Applied automatically whenever servers start (EE). Leave empty to skip.</div>
          <textarea rows="3" placeholder=${s.license ? 'Paste a new key to replace it' : 'Paste the license key'} value=${license} onInput=${(e) => setLicense(e.target.value)}></textarea>
          <div class="row">
            ${s.license && html`<button class="btn sm danger" disabled=${saving} onClick=${async () => (await ask({ title: 'Remove the saved license key?', body: 'New dev environments will start without a license until you add one.', ok: 'Remove key', danger: true })) && save({ license: '' })}>Remove key</button>`}
            <span class="grow"></span>
            <button class="btn primary sm" disabled=${saving || !license.trim()} onClick=${() => save()}>Save key</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3><${Icon} name="key-round" />Dev login</h3></div>
        <div class="card-b" style="display:grid;gap:12px">
          <div class="small muted">Created as the admin on a new database, then used to apply the license and read data.</div>
          <div class="cols">
            <div class="field"><label>Email</label><input value=${email} onInput=${(e) => setEmail(e.target.value)} autocapitalize="off" /></div>
            <div class="field"><label>Password</label><input value=${password} onInput=${(e) => setPassword(e.target.value)} autocapitalize="off" /></div>
          </div>
          <div class="row"><span class="grow"></span><button class="btn primary sm" disabled=${saving} onClick=${() => save()}>Save</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3><${Icon} name="smartphone" />Phone access</h3>
          ${ts && html`<span class=${`pill ${ts.running ? 'ok' : ''}`}><span class=${`dot ${ts.running ? 'ok' : 'off'}`}></span>${ts.installed ? (ts.running ? 'Tailscale on' : 'Tailscale off') : 'No Tailscale'}</span>`}</div>
        <div class="card-b" style="display:grid;gap:10px">
          ${!ts ? html`<span class="muted">Checking…</span>` : !ts.installed ? html`<span class="muted">Install Tailscale on the Mac and the phone and sign in to the same account.</span>` : html`
            <dl class="kv"><dt>URL</dt><dd>${ts.url ? html`<span class="mono ellipsis">${ts.url}</span><${Copy} text=${ts.url} />` : '—'}</dd><dt>Shared</dt><dd>${ts.shared ? 'Yes' : 'No'}</dd></dl>
            ${!ts.running && html`<span class="small muted">Turn Tailscale on in the menu bar first.</span>`}
            ${!ts.shared && html`<div class="row wrap"><button class="btn sm" disabled=${!ts.running} onClick=${share}>Share on port 8444</button><span class="small muted">Leaves your main tailnet URL (HexoKit) alone.</span></div>`}`}
        </div>
      </div>
    </div></div>`;
}

// ---------- app ----------

function App() {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(store.get('sel', null)); // { kind: 'session', name } | { kind: 'worktree', path }
  const [view, setView] = useState(store.get('view', 'main') === 'board' ? 'main' : store.get('view', 'main')); // main | worktrees | tools | settings
  const [adding, setAdding] = useState(null); // place being given a new session
  const [home, setHome] = useState(true); // phone: list screen
  const [filter, setFilter] = useState('');
  const [sheet, setSheet] = useState(null); // { mode: 'session' | 'worktree', folder }
  const [newFolder, setNewFolder] = useState(false);
  const [host, setHost] = useState(null);
  const [sideHidden, setSideHidden] = useState(store.get('sideHidden', false));
  const [palette, setPalette] = useState(false);
  const [rowMenu, setRowMenu] = useState(null); // { items, rect }
  const [moving, setMoving] = useState(null); // a session to run in another folder
  const [asking, setAsking] = useState(null); // an open ask() dialog

  const refresh = () => call('GET', '/projects').then((d) => { setData(d); return d; }).catch(() => {});
  usePoll(refresh, 5000, []); // sessions, agent states, worktrees (GitHub data inside is cached; see prs.ts)
  usePoll(() => !phone() && call('GET', '/host').then(setHost).catch(() => {}), 10000, []);

  ui.openMenu = (el, items) => setRowMenu({ items, rect: el.getBoundingClientRect() });
  ui.palette = () => setPalette(true);
  ui.toggleSide = () => setSideHidden((v) => { store.set('sideHidden', !v); return !v; });
  ui.moveSession = setMoving;
  ui.ask = setAsking;
  const moved = (r, program) => {
    setMoving(null);
    toast(r.moved ? `Now in ${shortPath(r.path)}` : `Moved to ${shortPath(r.path)}. Restart ${program} there to work in it`);
    refresh();
  };

  // ⌘K opens the palette even while a terminal has focus (capture phase, before xterm sees the key);
  // ⌘1–9 / ⌃1–9 jump to that tab of the folder (Chrome keeps ⌘1–9 for its own tabs outside the installed app)
  useEffect(() => {
    const k = (e) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); setPalette((v) => !v); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && hop.current?.(Number(e.key))) { e.preventDefault(); e.stopPropagation(); }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, []);

  // phone: the list is the home screen; the system back gesture returns to it
  useEffect(() => {
    const pop = () => setHome(true);
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const show = (v, next) => {
    setView(v);
    store.set('view', v);
    if (next !== undefined) { setSel(next); store.set('sel', next); }
    if (phone() && home) history.pushState({ dd: 1 }, '');
    setHome(false);
  };
  const back = () => (history.state?.dd ? history.back() : setHome(true));
  const goHome = () => { setSel(null); store.set('sel', null); setView('main'); store.set('view', 'main'); if (phone()) back(); };

  // a background browser tab still shows when an agent needs you: "(2) devdeck"
  const waiting = data ? data.sessions.flatMap((x) => x.tabs).filter((t) => t.agent === 'waiting').length : 0;
  useEffect(() => { document.title = waiting ? `(${waiting}) devdeck` : 'devdeck'; }, [waiting]);

  const idx = checkoutIndex(data);
  ui.checkout = (path) => idx.get(path);
  const s = sel?.kind === 'session' ? data?.sessions.find((x) => x.name === sel.name) : null;
  const w = sel?.kind === 'worktree' ? idx.get(sel.path) : null;

  // What's open went away (ended here or on another device, worktree removed): drop it, and on the phone go back.
  useEffect(() => {
    if (!data || !sel || s || w) return;
    setSel(null);
    store.set('sel', null);
    if (phone() && !home && view === 'main') back();
  }, [data]);

  const openSession = (name) => show('main', { kind: 'session', name });
  const openWorktree = (path) => show('main', { kind: 'worktree', path });
  // the open session's folder, in sidebar order: its tabs above the terminal
  const siblings = s ? data.sessions.filter((x) => (x.folder || '') === (s.folder || '')).sort((a, b) => sessKey(a) - sessKey(b)) : [];
  const hop = useRef();
  hop.current = (n) => {
    const x = view === 'main' && siblings.length > 1 && siblings[n - 1];
    if (x && x.name !== s.name) openSession(x.name);
    return !!x;
  };
  // keep what's open when it gets a new name
  const sessionRenamed = (from, to) => { if (sel?.kind === 'session' && sel.name === from) { const next = { kind: 'session', name: to }; setSel(next); store.set('sel', next); } };
  const addHere = async (path) => {
    setAdding(path);
    try { const out = await call('POST', '/sessions', { path }); await refresh(); openSession(out.name); } catch (e) { toast(e.message); }
    setAdding(null);
  };
  // a new session goes in the folder of the one that's open, unless said otherwise
  const newSession = (folder = s?.folder || '') => setSheet({ mode: 'session', folder });
  const done = async (out) => {
    setSheet(null);
    if (out.jobId) { store.set(`lens.s.${out.name}`, 'env'); store.set(`job.${out.path}`, out.jobId); }
    await refresh();
    openSession(out.name);
  };

  const commands = () => {
    const cmds = [];
    for (const x of data?.sessions || []) {
      const t = leadTab(x);
      cmds.push({ group: 'Sessions', icon: 'terminal', label: x.name, hint: `${x.checkout ? coTitle(idx.get(x.checkout) || { name: '' }) : shortPath(x.path)}${t?.agent ? ` · ${t.program} ${AGENT[t.agent][1]}` : ''}`, run: () => openSession(x.name) });
    }
    for (const c of idx.values()) cmds.push({ group: 'Worktrees', icon: 'git-branch', label: coTitle(c), hint: `${c.project}${c.pr ? ` · #${c.pr.number}` : ''}${serverState(c) ? ` · :${c.servers.ports.frontend}` : ''}`, run: () => openWorktree(c.path) });
    cmds.push(
      { group: 'Actions', icon: 'plus', label: 'New session…', run: () => newSession() },
      { group: 'Actions', icon: 'git-branch', label: 'New worktree…', run: () => setSheet({ mode: 'worktree', folder: s?.folder || '' }) },
      { group: 'Actions', icon: 'folder-plus', label: 'New sidebar folder…', run: () => { if (sideHidden) ui.toggleSide(); setNewFolder(true); } },
      { group: 'Actions', icon: 'git-fork', label: 'Worktrees', run: () => show('worktrees') },
      { group: 'Actions', icon: 'layout-grid', label: 'Overview', run: goHome },
      { group: 'Actions', icon: 'panel-left', label: sideHidden ? 'Show sidebar' : 'Hide sidebar', run: () => ui.toggleSide() },
      { group: 'Actions', icon: 'wrench', label: 'Tools', run: () => show('tools') },
      { group: 'Actions', icon: 'settings', label: 'Settings', run: () => show('settings') },
      ...THEMES.map(([id, icon, label]) => ({ group: 'Theme', icon, label: `Theme: ${label}`, run: () => { store.set('theme', id); applyTheme(id); } })),
    );
    return cmds;
  };

  const pageHead = (t) => html`<${TopBar} onBack=${back} crumbs=${[{ label: 'devdeck', icon: 'terminal', go: goHome }, { label: t }]} title=${t} />`;

  let main;
  if (view === 'worktrees') main = html`<div class="view">${pageHead('Worktrees')}<div class="pane"><${WorktreesView} data=${data} idx=${idx} openWorktree=${openWorktree} openSession=${openSession}
      addHere=${addHere} adding=${adding} onNewWorktree=${() => setSheet({ mode: 'worktree', folder: '' })} /></div></div>`;
  else if (view === 'tools') main = html`<div class="view">${pageHead('Tools')}<div class="pane"><${ToolsView} /></div></div>`;
  else if (view === 'settings') main = html`<div class="view">${pageHead('Settings')}<div class="pane"><${SettingsView} onSaved=${refresh} /></div></div>`;
  else if (s) main = html`<${SessionView} key=${s.name} s=${s} co=${s.checkout && idx.get(s.checkout)} siblings=${siblings} refresh=${refresh} onBack=${back} openWorktree=${openWorktree} openSession=${openSession} goHome=${goHome}
      onRenamed=${(name) => sessionRenamed(s.name, name)} />`;
  else if (w) main = html`<${WorktreeView} key=${w.path} c=${w} sessions=${data.sessions} refresh=${refresh} onBack=${back} openSession=${openSession} goHome=${goHome} />`;
  else main = html`<div class="view">
    <${TopBar} onBack=${back} crumbs=${[{ label: 'devdeck', icon: 'terminal' }, { label: 'Overview' }]} title="Overview" />
    <${Overview} data=${data} idx=${idx} refresh=${refresh} openSession=${openSession} openWorktree=${openWorktree} onNew=${() => newSession()} onWorktrees=${() => show('worktrees')} /></div>`;

  const stCo = s ? s.checkout && idx.get(s.checkout) : w;
  return html`
    <div class=${`shell ${home ? 'home' : ''} ${sideHidden ? 'side-hidden' : ''}`}>
      <aside class="side">
        <div class="side-head">
          <button class="logo" title="Overview" onClick=${goHome}><${DeckMark} /></button>
          <span class="brand">devdeck</span>
          <button class="icon-btn only-phone" title="Worktrees" onClick=${() => show('worktrees')}><${Icon} name="git-fork" /></button>
          <button class="icon-btn only-phone" title="Tools" onClick=${() => show('tools')}><${Icon} name="wrench" /></button>
          <button class="icon-btn only-phone" title="Settings" onClick=${() => show('settings')}><${Icon} name="settings" /></button>
          <button class="btn primary sm" onClick=${() => newSession()}><${Icon} name="plus" cls="sm" />New</button>
        </div>
        <div class="side-search"><${Icon} name="search" cls="sm" /><input placeholder="Filter sessions" value=${filter} onInput=${(e) => setFilter(e.target.value)} autocapitalize="off" /></div>
        <div class="side-body">
          <${Panel} id="places" title="Sessions" count=${data?.sessions.length || 0}
            action=${html`
              <button class="icon-btn sm" title="New folder" onClick=${() => setNewFolder(true)}><${Icon} name="folder-plus" cls="sm" /></button>
              <button class="icon-btn sm" title="New session" onClick=${() => newSession()}><${Icon} name="plus" cls="sm" /></button>`}>
            <${SessionTree} data=${data} idx=${idx} sel=${view === 'main' ? sel : null} filter=${filter} onSelect=${(x) => show('main', x)} onNew=${(f) => newSession(f)}
              refresh=${refresh} onRenamed=${sessionRenamed} openSession=${openSession} adding=${newFolder} setAdding=${setNewFolder} />
          </${Panel}>
        </div>
        <div class="side-foot">
          <button class=${`nav-row ${view === 'worktrees' ? 'sel' : ''}`} onClick=${() => show('worktrees')}><${Icon} name="git-fork" />Worktrees
            ${data && html`<span class="nav-n">${checkoutsOf(data, idx).length || ''}</span>`}</button>
          <button class=${`nav-row ${view === 'tools' ? 'sel' : ''}`} onClick=${() => show('tools')}><${Icon} name="wrench" />Tools</button>
          <button class=${`nav-row ${view === 'settings' ? 'sel' : ''}`} onClick=${() => show('settings')}><${Icon} name="settings" />Settings</button>
          <div class="theme-row"><span>Theme</span><${ThemeSwitch} /></div>
        </div>
      </aside>
      <main class="main">
        ${main}
        <${StatusBar} s=${view === 'main' ? s : null} co=${view === 'main' ? stCo : null} host=${host} />
      </main>
    </div>
    ${sheet && html`<${NewSheet} initial=${sheet.mode} folder=${sheet.folder} groups=${data?.folders || []} here=${s?.path || w?.path} onClose=${() => setSheet(null)} onDone=${done} />`}
    ${asking && html`<${Ask} ...${asking} close=${() => setAsking(null)} />`}
    ${moving && html`<${MoveSheet} s=${moving} onClose=${() => setMoving(null)} onDone=${moved} />`}
    ${palette && html`<${Palette} commands=${commands()} onClose=${() => setPalette(false)} />`}
    ${rowMenu && html`<${Popover} rect=${rowMenu.rect} onClose=${() => setRowMenu(null)} width=${272}><${MenuItems} items=${rowMenu.items} onClose=${() => setRowMenu(null)} /></${Popover}>`}`;
}

render(html`<${App} />`, document.getElementById('app'));
applyTheme(store.get('theme', 'system'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
