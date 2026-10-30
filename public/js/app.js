// devdeck's page: the app shell, routing between screens, and the keyboard shortcuts.
import { html, render, useEffect, useRef, useState } from '/vendor/preact.js';
import { Palette, StatusBar, TopBar } from './chrome.js';
import { Ask, DeckMark, Icon, MenuItems, Popover, THEMES, ThemeSwitch, applyTheme, ask, call, isIOS, phone, reloadAll, shortPath, store, toast, ui, useInstall, usePoll } from './lib.js';
import { AGENT, checkoutIndex, checkoutsOf, coTitle, leadTab, serverState, sessKey } from './model.js';
import { SettingsView, ToolsView } from './settings.js';
import { MoveSheet, NewSheet } from './sheets.js';
import { Panel, SessionTree } from './sidebar.js';
import { CopySheet } from './terminal.js';
import { ClaudeUsage, Overview, SessionView, SetupCard, WorktreeView, WorktreesView } from './views.js';

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
  const install = useInstall();
  const [, setHidden] = useState(0); // the install banner dismissed
  const [copying, setCopying] = useState(null); // a session whose text is open to copy (phone)
  const [asking, setAsking] = useState(null); // an open ask() dialog

  const refresh = () => call('GET', '/projects').then((d) => { setData(d); return d; }).catch(() => {});
  usePoll(refresh, 5000, []); // sessions, agent states, worktrees (GitHub data inside is cached; see prs.ts)
  usePoll(() => !phone() && call('GET', '/host').then(setHost).catch(() => {}), 10000, []);
  // A newer devdeck (the server asks GitHub once a day): Update, below Settings. Once the server is back on another
  // version, the page reloads onto it too.
  const [updating, setUpdating] = useState(false);
  const firstVersion = useRef(null);
  useEffect(() => {
    if (!host) return;
    firstVersion.current ??= host.version;
    if (host.version !== firstVersion.current) location.reload();
  }, [host?.version]);
  const update = async () => {
    const to = host.update.available;
    if (!(await ask({ title: `Update devdeck to ${to}?`, body: 'devdeck restarts on the new version (and so does the app, if it\'s open). Your terminals and servers keep running.', ok: 'Update' }))) return;
    setUpdating(true);
    try { await call('POST', '/update'); } catch (e) { setUpdating(false); toast(e.message); }
  };

  ui.openMenu = (el, items) => setRowMenu({ items, rect: el.getBoundingClientRect() });
  ui.palette = () => setPalette(true);
  ui.toggleSide = () => setSideHidden((v) => { store.set('sideHidden', !v); return !v; });
  ui.moveSession = setMoving;
  ui.copyText = setCopying;
  ui.ask = setAsking;
  ui.reload = () => call('POST', '/refresh').then(refresh);
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
  ui.locked = (folder) => !!folder && !!data?.locked?.includes(folder);
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
  // a worktree branched off a checkout (main: off origin's default), starting from its databases
  ui.newWorktreeFrom = (c) => setSheet({ mode: 'worktree', folder: s?.folder || '', repo: c.projectPath, from: c.path });
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
      { group: 'Actions', icon: 'rotate-cw', label: 'Reload pull requests and changes', run: reloadAll },
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
  // Opening a worktree, or a session in one, fetches its PR (devdeck doesn't poll GitHub; ⟳ fetches them all). So does
  // coming back to this page from another tab or app (e.g. after reviewing on GitHub).
  const focused = view === 'main' ? stCo?.path || '' : '';
  useEffect(() => {
    if (!focused) return;
    const fetchPr = () => call('POST', '/refresh', { path: focused }).then(refresh).catch(() => {});
    fetchPr();
    const back = () => document.visibilityState === 'visible' && fetchPr();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [focused]);
  return html`
    <div class=${`shell ${home ? 'home' : ''} ${sideHidden ? 'side-hidden' : ''}`}>
      <aside class="side">
        <div class="side-head">
          <button class="logo" title="Overview" onClick=${goHome}><${DeckMark} /></button>
          <button class="brand" title="Overview" onClick=${goHome}>devdeck</button>
          <button class="icon-btn only-phone" title="Worktrees" onClick=${() => show('worktrees')}><${Icon} name="git-fork" /></button>
          <button class="icon-btn only-phone" title="Tools" onClick=${() => show('tools')}><${Icon} name="wrench" /></button>
          <button class="icon-btn only-phone" title="Settings" onClick=${() => show('settings')}><${Icon} name="settings" /></button>
          <button class="btn primary sm" onClick=${() => newSession()}><${Icon} name="plus" cls="sm" />New</button>
        </div>
        <div class="side-search"><${Icon} name="search" cls="sm" /><input placeholder="Filter sessions" value=${filter} onInput=${(e) => setFilter(e.target.value)} autocapitalize="off" /></div>
        ${phone() && !install.installed && !store.get('installHidden', false) && html`
          <div class="install-banner">
            <img src="/icons/icon-192.png" alt="" />
            <div class="grow"><b>Install devdeck</b><span>${install.ready ? 'Full screen, from your home screen'
              : isIOS() ? 'In Safari: Share, then Add to Home Screen' : 'In Chrome: ⋮ menu, then Install app (or Add to Home screen)'}</span></div>
            ${install.ready && html`<button class="btn sm primary" onClick=${install.run}>Install</button>`}
            <button class="icon-btn sm" title="Not now" onClick=${() => { store.set('installHidden', true); setHidden((n) => n + 1); }}><${Icon} name="x" cls="sm" /></button>
          </div>`}
        ${phone() && html`<${SetupCard} refresh=${refresh} compact />`}
        ${phone() && html`<${ClaudeUsage} compact />`}
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
          ${host?.update?.available && html`
            <button class="nav-row update-row" disabled=${updating || host.update.updating} onClick=${update} title=${`devdeck ${host.version} → ${host.update.available}`}>
              <${Icon} name=${updating || host.update.updating ? 'loader-circle' : 'arrow-down'} cls=${updating || host.update.updating ? 'spin' : ''} />
              ${updating || host.update.updating ? 'Updating…' : `Update to ${host.update.available}`}
            </button>`}
          <div class="theme-row"><span>Theme</span><${ThemeSwitch} /></div>
        </div>
      </aside>
      <main class="main">
        ${main}
        <${StatusBar} s=${view === 'main' ? s : null} co=${view === 'main' ? stCo : null} host=${host} />
      </main>
    </div>
    ${sheet && html`<${NewSheet} initial=${sheet.mode} folder=${sheet.folder} repo=${sheet.repo} from=${sheet.from} groups=${data?.folders || []} here=${s?.path || w?.path} onClose=${() => setSheet(null)} onDone=${done} />`}
    ${asking && html`<${Ask} ...${asking} close=${() => setAsking(null)} />`}
    ${moving && html`<${MoveSheet} s=${moving} onClose=${() => setMoving(null)} onDone=${moved} />`}
    ${copying && html`<${CopySheet} session=${copying} onClose=${() => setCopying(null)} />`}
    ${palette && html`<${Palette} commands=${commands()} onClose=${() => setPalette(false)} />`}
    ${rowMenu && html`<${Popover} rect=${rowMenu.rect} onClose=${() => setRowMenu(null)} width=${272}><${MenuItems} items=${rowMenu.items} onClose=${() => setRowMenu(null)} /></${Popover}>`}`;
}

render(html`<${App} />`, document.getElementById('app'));
applyTheme(store.get('theme', 'system'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
