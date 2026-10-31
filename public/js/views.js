// Screens: a session, a worktree, the overview and the worktrees list.
import { html, useEffect, useState } from '/vendor/preact.js';
import { ArtifactList, TopBar, useLens } from './chrome.js';
import { EnvButtons, EnvPane, removeWorktree, useEnvControls } from './env.js';
import { Copy, Icon, MenuButton, Section, ago, call, copy, isHome, phone, plural, reloadAll, shortPath, store, toast, ui } from './lib.js';
import { AGENT, AgentLabel, PrBadge, PrCard, checkoutsOf, coTitle, confirmEnd, leadTab, prBlock, prLook, prStatus, renameFolderTo, renameSessionTo, serverState, sessionHere, tabDot, whereOf } from './model.js';
import { ChangesPane, CodePane, PreviewPane, codeUrl, vscode } from './panes.js';
import { ProjectsSheet } from './sheets.js';
import { Replies, TerminalPane } from './terminal.js';

// The phone's top bar keeps only back, the name, the lenses and ⋯; where it runs, its PR, its servers and ⟳ are the
// first items in ⋯ instead, each saying its state.
const phoneDetails = ({ co, ec, pick, openWorktree }) => phone() ? [
  co && openWorktree && { icon: co.main ? 'folder-git-2' : 'git-branch', label: `Worktree: ${coTitle(co)}`, run: () => openWorktree(co.path) },
  co?.pr && { icon: prLook(co.pr).icon, label: `PR #${co.pr.number} · ${prStatus(co.pr)}`, run: () => window.open(co.pr.url, '_blank', 'noopener') },
  co?.tooljet && ec.st && { icon: 'server', label: `Servers: ${ec.st.label.toLowerCase()}`, run: () => pick('env') },
  { icon: 'rotate-cw', label: 'Reload pull requests and changes', run: reloadAll },
  '-',
] : [];

// Preview with the app showing gives it the whole height (the top bar waits above: see .immersive). Not before the
// app runs: then the bar, its tabs and Start stay put.
const immersive = (cur, ec) => cur === 'preview' && ec.env?.services?.frontend?.state === 'running';

// A session: terminal tabs in some folder, plus the folder's git and ToolJet tools when it has them.
export function SessionView({ s, co, siblings, refresh, onBack, openWorktree, openSession, onRenamed, goHome }) {
  // Changes needs git; Code opens any folder (except your whole home folder)
  // (no Code on the phone: VS Code is a heavy first load over a slow link, and hard to use on a phone keyboard)
  const lenses = [['terminal', 'Terminal', 'terminal'], s.git && ['changes', 'Changes', 'file-diff'], !isHome(s.path) && !phone() && ['code', 'Code', 'code-xml'], co?.tooljet && !phone() && ['preview', 'Preview', 'app-window'], s.artifacts > 0 && ['artifacts', 'Artifacts', 'layers'], co?.tooljet && ['env', 'Env', 'server']].filter(Boolean);
  const [cur, pick, visited] = useLens(`lens.s.${s.name}`, lenses.map(([id]) => id), 'terminal');
  const ec = useEnvControls(co, cur === 'env' || cur === 'preview');
  const [renaming, setRenaming] = useState(false);
  // select the new name before the list refreshes, or the old one looks like it vanished
  const renameTo = (to) => renameSessionTo(s, to, refresh, (_, name) => onRenamed(name));
  const rename = () => {
    if (!phone()) return setRenaming(true); // in place, on the header
    const to = prompt('Rename session', s.name);
    if (to && to !== s.name) renameTo(to);
  };
  const end = async () => {
    if (!(await confirmEnd(s))) return;
    await call('DELETE', `/sessions/${encodeURIComponent(s.name)}`);
    refresh();
  };
  const items = [
    ...phoneDetails({ co, ec, pick, openWorktree }),
    phone() && { icon: 'copy', label: 'Copy from history…', run: () => ui.copyText(s.name) },
    { icon: 'plus', label: 'New session here', run: () => sessionHere(s, refresh, openSession) },
    { icon: 'pencil', label: 'Rename session', run: rename },
    { icon: 'folder-input', label: 'Run in another folder…', run: () => ui.moveSession(s) },
    co && !phone() && { icon: 'git-branch', label: 'Open worktree', run: () => openWorktree(co.path) },
    co && { icon: 'git-fork', label: 'New worktree from this branch…', run: () => ui.newWorktreeFrom(co) },
    co?.tooljet && '-',
    co?.tooljet && !ec.anyUp && { icon: 'play', label: ec.env?.ready ? 'Start servers' : 'Set up & start servers', run: () => ec.act('start') && pick('env') },
    co?.tooljet && ec.anyUp && { icon: 'square', label: 'Stop servers', run: () => ec.act('stop') },
    '-',
    !phone() && { icon: 'rotate-cw', label: 'Reload pull requests and changes', run: reloadAll },
    !isHome(s.path) && !phone() && { icon: 'external-link', label: 'Open code in a new tab', run: () => window.open(codeUrl(s.path), '_blank', 'noopener') },
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
    s.folder && { label: s.folder, icon: 'folder-closed', cls: 'crumb-folder', rename: (to) => renameFolderTo(s.folder, to, refresh) },
    { label: s.name, icon: 'terminal', rename: renameTo, editing: renaming, onEditEnd: () => setRenaming(false) },
    { node: co
      ? html`<button class="where-chip" title="Open this worktree" onClick=${() => openWorktree(co.path)}><${Icon} name=${where.icon} cls="xs" /><span class="ellipsis">${where.text}</span></button>`
      : html`<span class="where-chip plain" title=${shortPath(s.path)}><${Icon} name=${where.icon} cls="xs" /><span class="ellipsis">${where.text}</span></span>` },
  ].filter(Boolean);

  return html`
    <div class=${`view ${immersive(cur, ec) ? 'immersive' : ''}`}>
      ${immersive(cur, ec) && html`<div class="top-reveal" aria-hidden="true"></div>`}
      <${TopBar} onBack=${onBack} crumbs=${crumbs} title=${s.name} lenses=${lenses} cur=${cur} pick=${pick} changes=${changes}
        sub=${co ? html`<button class="crumb" onClick=${() => openWorktree(co.path)}><${Icon} name="git-branch" cls="sm" />${coTitle(co)}<${Icon} name="chevron-right" cls="sm" /></button>${co.pr && html`<${PrBadge} pr=${co.pr} link />`}` : shortPath(s.path)}>
        ${co?.tooljet && ec.st && html`<button class=${`pill ${ec.st.cls} only-phone`} onClick=${() => pick('env')}><span class=${`dot ${ec.st.cls || 'off'}`}></span></button>`}
        <${EnvButtons} co=${co} ec=${ec} hide=${envActive} />
        ${co?.pr && html`<span class="hide-phone top-pr"><${PrBadge} pr=${co.pr} link /></span>`}
        <${MenuButton} items=${items} />
      </${TopBar}>
      <div class="pane" hidden=${cur !== 'terminal'}>${(visited.terminal || cur === 'terminal') && html`<${TerminalPane} key=${s.name} s=${s} siblings=${siblings} refresh=${refresh} openSession=${openSession} onRenamed=${onRenamed} />`}</div>
      ${cur === 'changes' && html`<div class="pane"><${ChangesPane} path=${s.path} /></div>`}
      <div class="pane" hidden=${cur !== 'code'}>${visited.code && html`<${CodePane} path=${s.path} active=${cur === 'code'} />`}</div>
      <div class="pane" hidden=${cur !== 'preview'}>${visited.preview && co?.tooljet && html`<${PreviewPane} key=${co.path} ec=${ec} active=${cur === 'preview'} />`}</div>
      ${cur === 'artifacts' && html`<div class="pane"><div class="scroll"><div class="stack" style="max-width:760px"><div class="card"><div class="card-b tight"><${ArtifactList} name=${s.name} /></div></div></div></div></div>`}
      ${envActive && html`<div class="pane"><${EnvPane} c=${co} env=${ec.env} reload=${ec.reload} jobId=${ec.jobId} setJobId=${ec.setJobId} onRemoved=${() => toast('Worktree removed')} removeDiscard=${() => removeWorktree(co, ec, true)} /></div>`}
    </div>`;
}

// A worktree: its dev environment, changes and code, and the sessions open in it.
export function WorktreeView({ c, sessions, refresh, onBack, openSession, goHome }) {
  const lenses = [c.tooljet && ['env', 'Env', 'server'], ['changes', 'Changes', 'file-diff'], !phone() && ['code', 'Code', 'code-xml'], c.tooljet && !phone() && ['preview', 'Preview', 'app-window']].filter(Boolean);
  const [cur, pick, visited] = useLens(`lens.w.${c.path}`, lenses.map(([id]) => id), lenses[0][0]);
  const ec = useEnvControls(c, cur === 'env' || cur === 'preview');
  const [busy, setBusy] = useState(false);
  const here = sessions.filter((s) => s.checkout === c.path);
  const newSession = async () => {
    setBusy(true);
    try { const out = await call('POST', '/sessions', { path: c.path }); await refresh(); openSession(out.name); } catch (e) { toast(e.message); }
    setBusy(false);
  };
  const items = [
    ...phoneDetails({ co: c, ec, pick }),
    { icon: 'terminal', label: 'New session here', run: newSession },
    { icon: 'git-fork', label: 'New worktree from this branch…', run: () => ui.newWorktreeFrom(c) },
    c.tooljet && '-',
    c.tooljet && !ec.anyUp && { icon: 'play', label: ec.env?.ready ? 'Start servers' : 'Set up & start servers', run: () => ec.act('start') && pick('env') },
    c.tooljet && ec.anyUp && { icon: 'square', label: 'Stop servers', run: () => ec.act('stop') },
    '-',
    !phone() && { icon: 'rotate-cw', label: 'Reload pull requests and changes', run: reloadAll },
    !phone() && { icon: 'external-link', label: 'Open code in a new tab', run: () => window.open(codeUrl(c.path), '_blank', 'noopener') },
    { icon: 'monitor', label: 'Open in VS Code on the Mac', run: () => vscode(c.path) },
    { icon: 'copy', label: 'Copy path', run: () => copy(c.path) },
    !c.main && '-',
    !c.main && { icon: 'trash-2', label: 'Remove worktree', danger: true, run: async () => (await removeWorktree(c, ec, false)) && c.tooljet && pick('env') },
  ];
  return html`
    <div class=${`view ${immersive(cur, ec) ? 'immersive' : ''}`}>
      ${immersive(cur, ec) && html`<div class="top-reveal" aria-hidden="true"></div>`}
      <${TopBar} onBack=${onBack} crumbs=${[{ label: c.project, icon: 'folder-git-2', go: goHome }, { label: coTitle(c), icon: 'git-branch' }]}
        title=${coTitle(c)} sub=${`${c.project} · ${shortPath(c.path)}`} lenses=${lenses} cur=${cur} pick=${pick} changes=${c.stats?.changes || 0}>
        ${c.tooljet && ec.st && html`<span class=${`pill ${ec.st.cls} only-phone`}><span class=${`dot ${ec.st.cls || 'off'}`}></span></span>`}
        <${EnvButtons} co=${c} ec=${ec} hide=${cur === 'env'} />
        ${c.pr && html`<span class="hide-phone top-pr"><${PrBadge} pr=${c.pr} link /></span>`}
        <${MenuButton} items=${items} />
      </${TopBar}>
      ${cur !== 'code' && cur !== 'preview' && html`<div class="here">
        <span class="here-l">${here.length ? 'Sessions' : 'No session here yet'}</span>
        ${here.map((s) => { const t = leadTab(s); return html`<button class="chip-btn" onClick=${() => openSession(s.name)}><span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>${s.name}</button>`; })}
        <button class="chip-btn add" disabled=${busy} onClick=${newSession}><${Icon} name="plus" cls="sm" />New session here</button>
      </div>`}
      ${cur === 'changes' && html`<${PrCard} key=${c.path} c=${c} />`}
      ${cur === 'env' && html`<div class="pane"><${EnvPane} c=${c} env=${ec.env} reload=${ec.reload} jobId=${ec.jobId} setJobId=${ec.setJobId} onRemoved=${() => toast('Worktree removed')} removeDiscard=${() => removeWorktree(c, ec, true)} /></div>`}
      ${cur === 'changes' && html`<div class="pane"><${ChangesPane} path=${c.path} /></div>`}
      <div class="pane" hidden=${cur !== 'code'}>${visited.code && html`<${CodePane} path=${c.path} active=${cur === 'code'} />`}</div>
      <div class="pane" hidden=${cur !== 'preview'}>${visited.preview && html`<${PreviewPane} ec=${ec} active=${cur === 'preview'} />`}</div>
    </div>`;
}

// Claude's usage limits (5-hour and weekly) for each Claude subscription on this Mac (API-key accounts have none, so
// they aren't listed). Claude hands them to its status line; Connect puts devdeck in front of that account's status
// line, one click, and the one it had keeps showing (see claude.ts). Nothing polls: the server pushes new numbers
// when Claude saves them (after each reply in that account), and a window drops off at its reset time.
// compact: one line per connected account (the phone's home).
export function ClaudeUsage({ compact }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    const es = new EventSource('/api/claude/usage/events'); // reconnects on its own if dropped
    es.onmessage = (e) => setList(JSON.parse(e.data));
    return () => es.close();
  }, []);
  // one timer, for the next reset, so a window that has reset stops showing its old use
  useEffect(() => {
    const next = Math.min(...(list || []).flatMap((u) => [u.fiveHour?.resetsAt, u.week?.resetsAt]).filter((t) => t > Date.now()));
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => redraw((n) => n + 1), Math.min(next - Date.now() + 1000, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [list]);
  if (!list?.length) return null;
  const now = Date.now();
  const fresh = (w) => (w && w.resetsAt > now ? w : undefined);
  const act = async (what, account) => {
    setBusy(account);
    try { setList(await call('POST', `/claude/${what}`, { account })); } catch (e) { toast(e.message); }
    setBusy(null);
  };
  const at = (ms) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  };
  const level = (w) => (w.used >= 90 ? 'bad' : w.used >= 70 ? 'warn' : '');
  const shown = list.map((u) => ({ ...u, fiveHour: fresh(u.fiveHour), week: fresh(u.week) }));
  const live = shown.filter((u) => u.connected && (u.fiveHour || u.week));
  if (compact) return live.length > 0 && html`
    <div class="cu-compact">${live.map((u) => html`
      <div class="cu-line">
        <span class="cu-acct ellipsis">${u.account.split('@')[0]}</span>
        <span class=${`cu-n ${u.fiveHour ? level(u.fiveHour) : 'subtle'}`}>5h ${u.fiveHour ? `${Math.floor(u.fiveHour.used)}%` : '–'}</span>
        <span class=${`cu-n ${u.week ? level(u.week) : 'subtle'}`}>week ${u.week ? `${Math.floor(u.week.used)}%` : '–'}</span>
      </div>`)}</div>`;
  const row = (label, w) => w && html`
    <div class="cu-w"><span class="cu-l">${label}</span><span class="cu-bar"><i class=${level(w)} style=${`width:${Math.min(100, w.used)}%`}></i></span><b class=${`${level(w)}-text`}>${Math.floor(w.used)}%</b><span class="cu-note">resets ${at(w.resetsAt)}</span></div>`;
  return html`
    <${Section} title="Claude usage">
      <div class="ov-grid cu-grid">${shown.map((u) => html`
        <div class="ov-card cu-card">
          <span class="ov-card-t"><${Icon} name="sparkles" cls="sm" /><span class="ellipsis">${u.account}</span><span class="tag">${u.plan}</span><span class="grow"></span>
            ${u.connected && html`<button class="linkish small" disabled=${busy === u.account} title="Put this account's Claude status line back as it was" onClick=${() => act('disconnect', u.account)}>Disconnect</button>`}</span>
          ${!u.connected ? html`
            <p class="cu-pitch">See this account's 5-hour and weekly limits here, live.</p>
            <div class="row"><button class="btn sm primary" disabled=${busy === u.account} onClick=${() => act('connect', u.account)}><${Icon} name="plus" cls="sm" />Connect</button>
              <span class="cu-note">Adds devdeck to its Claude status line. Yours keeps showing.</span></div>`
          : u.fiveHour || u.week ? html`${row('5-hour', u.fiveHour)}${row('This week', u.week)}<span class="cu-note">updated ${ago(u.at / 1000)}</span>`
          : html`<p class="cu-pitch">Connected. Your limits show here after Claude's next reply in this account.</p>`}
        </div>`)}</div>
    </${Section}>`;
}

// Desktop home: what needs you (agents asking, PRs blocked), recent sessions, active worktrees.
// The Mac's health lives in the status bar.
// First run: what devdeck needs from you, each with its fix. Projects (a folder holding a repo) and GitHub (gh,
// for pull requests; optional). Gone once both are done, or hidden: Settings has the rest.
export function SetupCard({ refresh, compact }) {
  const [s, setS] = useState(null);
  const [picking, setPicking] = useState(false);
  const [hidden, setHidden] = useState(store.get('setupHidden', false));
  const check = () => call('GET', '/setup').then(setS).catch(() => {});
  useEffect(() => { if (!hidden) check(); }, []);
  if (hidden || !s) return null;
  const projects = s.projects.repos > 0;
  const github = s.github.installed && s.github.signedIn;
  if (projects && github) return null;
  const cmd = (c) => html`<span class="setup-cmd"><span class="mono">${c}</span><${Copy} text=${c} /></span>`;
  return html`
    <section class=${`setup ${compact ? 'compact' : ''}`}>
      <div class="setup-h"><b>Get set up</b><span class="grow"></span>
        <button class="linkish" onClick=${check}><${Icon} name="rotate-cw" cls="xs" />Check again</button>
        <button class="icon-btn sm" title="Hide: set these up later in Settings" onClick=${() => { store.set('setupHidden', true); setHidden(true); }}><${Icon} name="x" cls="sm" /></button>
      </div>
      <div class=${`setup-row ${projects ? 'done' : ''}`}>
        <${Icon} name=${projects ? 'circle-check' : 'circle'} cls="sm" />
        <div class="grow">
          <b>Projects folder</b>
          <span class="muted">${projects ? `${s.projects.roots.join(', ')}` : 'Pick the folder your repos are in, so sessions and worktrees can start there.'}</span>
        </div>
        ${!projects && html`<button class="btn sm primary" onClick=${() => setPicking(true)}><${Icon} name="folder-search" cls="sm" />Choose folder</button>`}
      </div>
      <div class=${`setup-row ${github ? 'done' : ''}`}>
        <${Icon} name=${github ? 'circle-check' : 'circle'} cls="sm" />
        <div class="grow">
          <span><b>GitHub</b> <span class="subtle">· optional</span></span>
          <span class="muted">${github ? 'Signed in: pull requests show on their worktrees.'
            : s.github.installed ? html`Sign in for pull request status. In Terminal: ${cmd('gh auth login')}`
            : html`Install the GitHub CLI for pull request status. In Terminal: ${cmd('brew install gh && gh auth login')}`}</span>
        </div>
      </div>
      ${picking && html`<${ProjectsSheet} onClose=${() => setPicking(false)} onDone=${() => { setPicking(false); check(); refresh(); }} />`}
    </section>`;
}

export function Overview({ data, idx, refresh, openSession, openWorktree, onNew, onWorktrees }) {
  if (!data) return html`<div class="scroll muted">Loading…</div>`;
  const waiting = data.sessions.flatMap((s) => s.tabs.filter((t) => t.agent === 'waiting').map((t) => ({ s, t })));
  const all = checkoutsOf(data, idx);
  const blocked = all.filter((pl) => prBlock(pl.co.pr));
  const places = all.filter((p) => p.active);
  const recent = [...data.sessions].sort((a, b) => b.activity - a.activity).slice(0, 6);
  const needs = waiting.length + blocked.length;
  return html`
    <div class="scroll overview"><div class="ov">
      <${SetupCard} refresh=${refresh} />
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
            <div class="ov-pr">
              <a class="ov-row" href=${pl.co.pr.url} target="_blank" rel="noopener" title="Open the pull request on GitHub">
                <${PrBadge} pr=${pl.co.pr} /><b class="ellipsis">${coTitle(pl.co)}</b><span class="muted ellipsis">${pl.co.pr.title}</span>
                <span class="grow"></span><span class="bad-text">${prBlock(pl.co.pr)}</span><${Icon} name="arrow-up-right" cls="sm muted" /></a>
              <button class="icon-btn sm" title="Open its worktree here" onClick=${() => openWorktree(pl.key)}><${Icon} name="git-branch" cls="sm" /></button>
            </div>`)}
        </div>` : html`<p class="ov-empty"><${Icon} name="circle-check" cls="sm" /> Nothing needs you right now.</p>`}
      </${Section}>
      <${ClaudeUsage} />
      <${Section} title="Recent sessions" aside=${html`<button class="btn sm" onClick=${onNew}><${Icon} name="plus" cls="sm" />New session</button>`}>
        ${recent.length ? html`<div class="ov-list">${recent.map((s) => {
          const t = leadTab(s);
          const a = t?.agent && t.agent !== 'idle' && AGENT[t.agent];
          const where = whereOf(s, s.checkout && idx.get(s.checkout));
          return html`
            <button class="ov-row" onClick=${() => openSession(s.name)}>
              <span class=${`dot ${t ? tabDot(t) : 'off'}`}></span><b class="ellipsis">${s.name}</b>
              <span class="muted ellipsis row"><${Icon} name=${where.icon} cls="xs" />${where.text}</span>
              <span class="grow"></span>${a && html`<span class=${a[2]}><${AgentLabel} a=${a} /></span>`}<span class="subtle">${ago(s.activity)}</span></button>`;
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
export function WorktreesView({ data, idx, openWorktree, openSession, addHere, adding, onNewWorktree }) {
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
