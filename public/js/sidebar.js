// The sidebar: your folders › sessions, with drag to file or reorder, rename and menus.
import { html, useState } from '/vendor/preact.js';
import { Icon, InlineEdit, ask, call, phone, plural, shortPath, store, toast, ui } from './lib.js';
import { AGENT, AgentLabel, PrBadge, endSession, leadTab, quietWhere, renameFolderTo, renameSessionTo, serverState, sessKey, sessionHere, tabDot, treeOf, whereOf } from './model.js';

// A collapsible sidebar section: ▾ TITLE  count  [actions]
export function Panel({ id, cls = '', title, count, action, drop, over, children }) {
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
          ${!editing && a && t.agent !== 'idle' && html`<span class=${`trow-st ${a[2]}`}><${AgentLabel} a=${a} /></span>`}
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

async function lockFolder(f, on, refresh) {
  await call('PUT', `/groups/${encodeURIComponent(f.name)}/lock`, { locked: on }).catch((e) => toast(e.message));
  refresh();
}

async function deleteFolder(f, refresh) {
  if (ui.locked(f.name)) return ask({ title: `"${f.name}" is locked`, body: 'Unlock it (its ⋯ menu) to delete it.', ok: 'OK', cancel: null });
  if (f.sessions.length && !(await ask({ title: `Delete the folder "${f.name}"?`, body: `This will also end its ${plural(f.sessions.length, 'session')} and close their terminals. Dev servers started from Env will keep running.`, ok: 'Delete folder', danger: true }))) return;
  await call('DELETE', `/groups/${encodeURIComponent(f.name)}`).catch((e) => toast(e.message));
  refresh();
}

export function SessionTree({ data, idx, sel, filter, onSelect, onNew, refresh, onRenamed, openSession, adding, setAdding }) {
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
            ${ui.locked(f.name)
              ? html`<button class="trow-btn lock locked" title="Locked: its sessions can't be ended. Click to unlock" onClick=${(e) => { e.stopPropagation(); lockFolder(f, false, refresh); }}><${Icon} name="lock" cls="xs" /></button>`
              : html`<button class="trow-btn lock" title="Lock: keep its sessions from being ended" onClick=${(e) => { e.stopPropagation(); lockFolder(f, true, refresh); }}><${Icon} name="lock-open" cls="xs" /></button>`}
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
