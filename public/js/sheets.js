// Sheets: new session / worktree, and moving a session to another folder.
import { html, useEffect, useRef, useState } from '/vendor/preact.js';
import { ErrorBox, Icon, Switch, call, phone, qs, shortPath, store, toast } from './lib.js';
import { leadTab } from './model.js';

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
// goes straight there. browseFrom: start out browsing that folder.
function WherePicker({ folders, here, where, setWhere, go, browseFrom }) {
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
  useEffect(() => { if (browseFrom) open(browseFrom); }, []);
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

// The folder that holds your projects (a repo, or a folder of repos), browsed to and added to Settings. Folders in
// Settings that don't exist (the ~/Work default on a Mac without one) give way to it.
export function ProjectsSheet({ onClose, onDone }) {
  const [where, setWhere] = useState('~');
  const [busy, setBusy] = useState(false);
  const save = async (path = where) => {
    setBusy(true);
    try {
      const s = await call('GET', '/settings');
      const kept = s.roots.filter((r, i) => s.rootsReport[i]?.found && r !== path);
      await call('PUT', '/settings', { roots: [...kept, path] });
      onDone();
    } catch (e) { toast(e.message); setBusy(false); }
  };
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  return html`
    <div class="backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-label="Projects folder">
        <div class="grabber"></div>
        <div class="sheet-h"><h2>Projects folder</h2><span class="grow"></span><button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>
        <div class="sheet-sub">A repo, like ~/Work/ToolJet, or a folder of repos, like ~/Work. Worktrees are found on their own.</div>
        <div class="sheet-b"><${WherePicker} folders=${{ checkouts: [], folders: [] }} where=${where} setWhere=${setWhere} go=${save} browseFrom="~" /></div>
        <div class="sheet-f">
          <span class="sheet-hint ellipsis">${shortPath(where)}</span>
          <button class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" disabled=${busy} onClick=${() => save()}>Use this folder</button>
        </div>
      </div>
    </div>`;
}

// Run a session in another folder or worktree. Devdeck's views switch at once; an idle shell cds there, while a
// running program (Claude, a server) stays where it started until it's restarted.
export function MoveSheet({ s, onClose, onDone }) {
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

// What a new worktree's databases start as; `who` is the checkout they come from.
const DB_MODES = [
  ['share', 'Same', (who) => `Uses ${who}'s databases as they are. The quickest, but changes show in both, and this branch's migrations aren't run.`],
  ['copy', 'Copy', (who) => `Its own copy of ${who}'s data, with this branch's migrations on top. Changes stay in this worktree.`],
  ['new', 'New', () => 'Empty databases, set up from scratch. The slowest.'],
];

// New session: one screen. Pick where (defaults to what's open), name it if you like, Enter. Or a new worktree, started
// from a checkout (`from`): its branch and its databases.
export function NewSheet({ onClose, onDone, initial, here, folder: inFolder = '', groups = [], repo: inRepo = '', from: inFrom = '' }) {
  const [mode, setMode] = useState(initial === 'worktree' ? 'worktree' : 'session');
  const [repos, setRepos] = useState(null);
  const [folders, setFolders] = useState(null);
  const [name, setName] = useState('');
  const [where, setWhere] = useState(here || null);
  const [repo, setRepo] = useState(inRepo);
  const [branch, setBranch] = useState('');
  const [startFrom, setStartFrom] = useState(inFrom); // a checkout's path, or 'other' (a branch typed in)
  const [other, setOther] = useState('');
  const [dbMode, setDbMode] = useState('share');
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
  // Where a new branch starts: main (origin's default branch, so it's up to date) or a worktree's branch, with that
  // checkout's databases; or another branch, with main's. One not set up yet lends main's too.
  const mine = (folders?.checkouts || []).filter((c) => c.repo === repo && (c.main || c.branch));
  const main = mine.find((c) => c.main);
  const at = startFrom === 'other' ? null : mine.find((c) => c.path === startFrom) || main;
  const base = at ? (at.main ? '' : at.branch) : other.trim();
  const dbFrom = at?.db ? at : main?.db ? main : null;
  const who = (c) => (c.main ? 'main' : c.branch);
  const start = async (body) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { onDone(await call('POST', '/sessions', { name: name.trim(), folder, ...body })); } catch (e) { setError(e); setBusy(false); }
  };
  const createWorktree = () => {
    if (!branch.trim()) return;
    store.set('startEnv', startEnv);
    const db = tooljet && dbMode !== 'new' && dbFrom ? { from: dbFrom.path, share: dbMode === 'share' } : undefined;
    start({ worktree: { repo, branch: branch.trim(), base, db }, start: tooljet && startEnv });
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
            <div class="field"><label>Start from</label>
              <select value=${at ? at.path : 'other'} onChange=${(e) => setStartFrom(e.target.value)}>
                ${mine.map((c) => html`<option value=${c.path}>${c.main ? `${c.project} (main)` : c.branch}</option>`)}
                <option value="other">Another branch…</option>
              </select>
              ${!at && html`
                <input placeholder="origin/lts-3.16" value=${other} onInput=${(e) => setOther(e.target.value)} list="dd-bases" autocapitalize="off" autocorrect="off" spellcheck="false" />
                <datalist id="dd-bases">${branches.map((b) => html`<option value=${b} />`)}</datalist>`}
              <div class="hint">
                For a new branch: ${at?.main ? "origin's latest default branch" : at ? `${at.branch}'s commits (not its uncommitted changes)` : 'that branch'}${tooljet && dbFrom ? `, with ${who(dbFrom)}'s data${at && at !== dbFrom ? ` (${at.branch} has no database yet)` : ''}` : ''}.
              </div>
            </div>
            ${tooljet && dbFrom && html`
              <div class="field"><label>Database</label>
                <div class="seg db-modes">${DB_MODES.map(([id, label]) => html`<button class=${dbMode === id ? 'sel' : ''} onClick=${() => setDbMode(id)}>${label}</button>`)}</div>
                <div class="hint">${DB_MODES.find(([id]) => id === dbMode)?.[2](who(dbFrom))}</div>
              </div>`}
            ${tooljet && html`
              <label class="switch-row">
                <${Switch} checked=${startEnv} onChange=${setStartEnv} />
                <span><b>Start dev environment</b><span>Its own .env and ports; installs dependencies, sets up the database, then starts ToolJet with your license</span></span>
              </label>`}
            <div>
              <button class="linkish" onClick=${() => setOpts(!opts)}><${Icon} name="chevron-down" cls="sm" style=${opts ? 'transform:rotate(180deg)' : ''} />Options</button>
              ${opts && html`
                <div style="display:grid;gap:12px;margin-top:10px">
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
