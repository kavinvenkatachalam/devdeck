// Top bar, status bar, ⌘K palette and the lens tabs (Terminal / Changes / Code / Env).
import { html, useEffect, useRef, useState } from '/vendor/preact.js';
import { Icon, InlineEdit, keyLabel, keyMods, placeKey, plural, shortPath, store, toast, ui } from './lib.js';
import { AGENT, AgentLabel, leadTab, prLook, serverState } from './model.js';

// ---------- top & status bars ----------


// ⟳: GitHub's PR states (devdeck doesn't poll GitHub), change counts and the session list, fetched now.
function ReloadButton() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try { await ui.reload(); } catch (e) { toast(e.message); }
    setBusy(false);
  };
  return html`<button class="icon-btn reload-btn" title="Reload: pull requests from GitHub, changes, sessions" disabled=${busy} onClick=${go}>
    <${Icon} name="rotate-cw" cls=${`sm ${busy ? 'spin' : ''}`} /></button>`;
}

// crumbs: [{ label, icon, go }] — the last one is the current place. On the phone: back + title + sub.
// A crumb with `rename` renames in place on double-click (or when `editing` is set, e.g. from a menu).
// ⌥1–9 (or the key set in Settings → Keyboard) picks a lens by its place, even from the terminal or the Code editor
// (it's the same page, so its keys come here too). Leaving the terminal takes the keyboard from it, so typing doesn't
// go on into a hidden terminal.
const lensKeys = { current: null };
const onLensKey = (e) => {
  const n = placeKey(e, keyMods().views);
  if (!n || !lensKeys.current?.(n)) return;
  e.preventDefault();
  e.stopPropagation();
};
addEventListener('keydown', onLensKey, true);
export const lensKeysIn = (frame) => { try { frame.contentWindow.addEventListener('keydown', onLensKey, true); } catch {} };

// a button's name (and its key) under it on hover; the button needs class has-tip
const Tip = ({ text, keys }) => html`<span class="tip" aria-hidden="true">${text}${keys && html`<kbd>${keys}</kbd>`}</span>`;

export function TopBar({ onBack, crumbs, title, sub, lenses, cur, pick, changes, children }) {
  const badge = (id) => id === 'changes' && changes > 0 && html`<span class="n">${changes}</span>`;
  const go = (id) => {
    pick(id);
    setTimeout(() => (id === 'terminal' ? ui.focusTerm?.() : document.activeElement?.blur()));
  };
  lensKeys.current = lenses?.length > 1 ? (n) => !!lenses[n - 1] && (go(lenses[n - 1][0]), true) : null;
  const [editingAt, setEditingAt] = useState(null);
  const last = crumbs.map((x) => !x.node).lastIndexOf(true);
  const chip = (c, i) => {
    const cls = `crumb-chip ${i === last ? 'cur' : ''} ${c.cls || ''}`;
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
        ${lenses?.length > 1 && html`<div class="lens-group">${lenses.map(([id, label, icon], i) => html`
          <button class=${`lens has-tip ${cur === id ? 'sel' : ''}`} aria-label=${label} onClick=${() => go(id)}><${Icon} name=${icon} cls="sm" />${badge(id)}
            <${Tip} text=${label} keys=${keyLabel(keyMods().views, i + 1)} /></button>`)}</div>`}
        <${ReloadButton} />
        <button class="icon-btn palette-btn has-tip" aria-label="Go to a session or worktree" onClick=${() => ui.palette()}><${Icon} name="command" cls="sm" /><${Tip} text="Go to a session or worktree" keys="⌘K" /></button>
      </div>
    </header>`;
}

const gb = (n) => `${(n / 2 ** 30).toFixed(n >= 100 * 2 ** 30 ? 0 : 1)}G`;

// Desktop footer: what the open place is doing (branch, PR, agent, servers) and how the Mac is doing.
export function StatusBar({ s, co, host }) {
  const t = s && leadTab(s);
  const a = t?.agent && AGENT[t.agent];
  const st = co && serverState(co);
  const memPct = host ? Math.round((host.mem.used / host.mem.total) * 100) : 0;
  return html`
    <footer class="status">
      ${co && html`<span class="st-i"><${Icon} name="git-branch" cls="xs" />${co.branch || co.name}</span>`}
      ${co?.pr && html`<a class=${`st-i pr-${prLook(co.pr).cls}`} href=${co.pr.url} target="_blank" rel="noopener">pr #${co.pr.number} · ${prLook(co.pr).label.toLowerCase()}</a>`}
      ${co?.stats && html`<span class="st-i">${co.stats.changes ? plural(co.stats.changes, 'change') : 'clean'}${co.stats.ahead ? ` ↑${co.stats.ahead}` : ''}${co.stats.behind ? ` ↓${co.stats.behind}` : ''}</span>`}
      ${a && html`<span class=${`st-i ${a[2]}`}><span class=${`dot ${a[0]}`}></span>${t.program} <${AgentLabel} a=${a} /></span>`}
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

export function Palette({ commands, onClose }) {
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

export function useLens(key, allowed, fallback) {
  const [lens, set] = useState(store.get(key, fallback));
  const [visited, setVisited] = useState({ [lens]: true });
  const cur = allowed.includes(lens) ? lens : fallback;
  const pick = (l) => { set(l); store.set(key, l); setVisited((v) => ({ ...v, [l]: true })); };
  return [cur, pick, visited];
}
