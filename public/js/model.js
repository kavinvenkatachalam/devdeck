// What the data means (sessions, worktrees, agent and PR states) and the small actions and badges built on it.
import { html } from '/vendor/preact.js';
import { Icon, Working, ask, call, plural, shortPath, toast, ui } from './lib.js';

// Ending a session closes its terminal, and whatever runs in it stops. Dev servers started from Env run on their own,
// outside any terminal, so they keep running; the dialog says so only when that worktree has some up.
export const END_SESSION = (s) => {
  const t = leadTab(s);
  const co = s.checkout && ui.checkout(s.checkout);
  const what = t?.busy ? `This will close its terminal and stop ${t.program}, which is running in it.` : 'This will close its terminal.';
  const servers = serverState(co) ? `\n\nThe dev servers of ${co.main ? co.project : co.branch || co.name} will keep running: they run on their own, not in this terminal. Stop them from Env.` : '';
  return { title: `End the session "${s.name}"?`, body: what + servers, ok: 'End session', danger: true };
};

export async function renameSessionTo(s, to, refresh, onRenamed) {
  try { const r = await call('PATCH', `/sessions/${encodeURIComponent(s.name)}`, { name: to }); onRenamed?.(s.name, r.name); await refresh(); } catch (e) { toast(e.message); }
}
// A session in a locked folder can't be ended until the folder is unlocked: say so instead of asking.
export async function confirmEnd(s) {
  if (ui.locked(s.folder)) {
    await ask({ title: `"${s.name}" is locked`, body: `It's in the folder "${s.folder}", which is locked. Unlock the folder (its ⋯ menu) to end the session.`, ok: 'OK', cancel: null });
    return false;
  }
  return ask(END_SESSION(s));
}
export async function endSession(s, refresh) {
  if (!(await confirmEnd(s))) return;
  await call('DELETE', `/sessions/${encodeURIComponent(s.name)}`).catch((e) => toast(e.message));
  refresh();
}

// ---------- model ----------

// /api/projects → { sessions, projects }. A session is a terminal in any folder. When that folder is a
// worktree of a known project, `checkout` points at it and the worktree's tools (changes, code, env) come along.
export function checkoutIndex(data) {
  const m = new Map();
  for (const p of data?.projects || []) for (const c of p.checkouts) m.set(c.path, { ...c, project: p.name, projectPath: p.path, tooljet: p.tooljet });
  return m;
}

export const coTitle = (c) => c.branch || c.name;

export function serverState(c) {
  const s = c?.servers;
  if (s?.server && s?.frontend) return 'ok';
  if (s?.server || s?.frontend) return 'warn';
  return null;
}

// Claude / Codex tabs report what the agent is doing; other tabs just whether something runs in them.
export const AGENT = { working: ['run', 'working', 'accent-text'], waiting: ['warn', 'needs you', 'warn-text'], idle: ['ok', 'idle', 'muted'] };
// an agent's state as shown on rows: "working" in the style picked in Settings
export const AgentLabel = ({ a }) => (a[1] === 'working' ? html`<${Working} />` : a[1]);
export const tabDot = (t) => (t.agent ? AGENT[t.agent][0] : t.busy ? 'ok' : 'off');
const RANK = { waiting: 3, working: 2, idle: 1 };
// the tab that says most about a session: one that needs you, then one that's working
export const leadTab = (s) => [...s.tabs].sort((a, b) => (RANK[b.agent] || 0) - (RANK[a.agent] || 0) || Number(b.busy) - Number(a.busy))[0];

// PR look: merged / closed / draft, else by what's blocking it (failing checks, conflicts, changes asked), else pending checks
export function prLook(pr) {
  if (pr.state === 'MERGED') return { cls: 'merged', icon: 'git-merge', label: 'Merged' };
  if (pr.state === 'CLOSED') return { cls: 'closed', icon: 'git-pull-request-closed', label: 'Closed' };
  if (pr.draft) return { cls: 'draft', icon: 'git-pull-request-draft', label: 'Draft' };
  const k = pr.checks;
  const rereview = pr.review === 'CHANGES_REQUESTED' && pr.requested?.length > 0;
  if (k.failed || pr.conflicts || (pr.review === 'CHANGES_REQUESTED' && !rereview)) return { cls: 'bad', icon: 'git-pull-request', label: 'Open' };
  if (k.pending || rereview) return { cls: 'warn', icon: 'git-pull-request', label: 'Open' };
  return { cls: 'ok', icon: 'git-pull-request', label: 'Open' };
}

export const PrBadge = ({ pr, link }) => {
  const l = prLook(pr);
  const inner = html`<${Icon} name=${l.icon} cls="xs" />#${pr.number}`;
  const title = `${l.label} · ${pr.title}`;
  return link
    ? html`<a class=${`pr-badge ${l.cls}`} href=${pr.url} target="_blank" rel="noopener" title=${title}>${inner}</a>`
    : html`<span class=${`pr-badge ${l.cls}`} title=${title}>${inner}</span>`;
};

const REVIEW = { APPROVED: ['Approved', 'ok-text'], CHANGES_REQUESTED: ['Changes requested', 'bad-text'], REVIEW_REQUIRED: ['Review required', 'muted'] };

// The worktree's PR: state, checks, review, and the failing checks (each links to its run).
// (from the list's data: refreshed from GitHub by ⟳ in the header, not polled)
export function PrCard({ c }) {
  const pr = c.pr;
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
export function checkoutsOf(data, idx) {
  return data.projects.flatMap((p) => p.checkouts.map((c) => {
    const sessions = data.sessions.filter((s) => s.checkout === c.path);
    return { key: c.path, co: idx.get(c.path), project: p.name, sessions, active: sessions.length > 0 || !!(c.servers?.server || c.servers?.frontend) };
  }));
}

// The sidebar is your own tree: folders you make (named groups, not folders on disk) › sessions (one terminal each).
// Sessions outside any folder come after the folders. Where a session runs is a detail on its row.
export const sessKey = (s) => s.order || s.created; // placed ones (1, 2, …) first, the rest by age
export function treeOf(data, idx, filter) {
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
export const quietWhere = (co) => co?.main && !serverState(co) && !co.pr;
export function whereOf(s, co) {
  if (co) return { icon: co.main ? 'folder-git-2' : 'git-branch', text: co.main ? `${co.project} · ${co.branch}` : coTitle(co) };
  const p = shortPath(s.path);
  return p === '~' ? { icon: 'house', text: 'Home' } : { icon: 'folder', text: p };
}

// Another terminal in the same place: a new session in the same folder on disk and sidebar folder, named after this one.
export async function sessionHere(s, refresh, openSession) {
  try {
    const out = await call('POST', '/sessions', { path: s.path, folder: s.folder, name: s.name });
    await refresh();
    openSession(out.name);
  } catch (e) { toast(e.message); }
}

export async function renameFolderTo(from, to, refresh) {
  try { await call('PATCH', `/groups/${encodeURIComponent(from)}`, { name: to }); } catch (e) { toast(e.message); }
  refresh();
}
// what's blocking a PR, for the "needs you" list (null when nothing is)
export function prBlock(pr) {
  if (pr?.state !== 'OPEN' || prLook(pr).cls !== 'bad') return null;
  return pr.checks.failed ? `${plural(pr.checks.failed, 'failing check')}` : pr.conflicts ? 'conflicts' : 'changes requested';
}

// a PR in a few words, for the phone's ⋯ menu: "draft", "merged", "1 failing check", "checks running"…
export const prStatus = (pr) =>
  pr.state !== 'OPEN' ? prLook(pr).label.toLowerCase() : pr.draft ? 'draft' : prBlock(pr) || (pr.checks.pending ? 'checks running' : pr.review === 'APPROVED' ? 'approved' : 'checks passing');
