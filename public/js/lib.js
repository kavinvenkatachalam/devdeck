// Shared basics: API calls, storage, toasts, theme, the phone keyboard, dialogs, menus and small widgets.
import { html, useEffect, useRef, useState } from '/vendor/preact.js';

export const phone = () => matchMedia('(max-width: 760px)').matches;

// devdeck's mark: a small deck of terminal cards.
export const DeckMark = () => html`
  <svg class="deckmark" viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id="dd-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--accent)" /><stop offset="1" style="stop-color:color-mix(in srgb, var(--accent) 70%, var(--text))" /></linearGradient></defs>
    <rect x="8" y="2.5" width="13" height="9" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3" />
    <rect x="5.5" y="6" width="13" height="9" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".55" />
    <rect x="3" y="9.5" width="13.5" height="11" rx="2.4" fill="url(#dd-grad)" />
    <path d="M6.6 13.4l2.3 1.8-2.3 1.8M10.6 17.2h2.6" fill="none" stroke="var(--on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

// Lucide icons from /icons.svg (built by scripts/icons.mjs).
export const Icon = ({ name, cls = '', style }) => html`<svg class=${`i ${cls}`} style=${style} aria-hidden="true"><use href=${`/icons.svg#${name}`} /></svg>`;

class ApiError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

export async function call(method, path, data) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const out = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new ApiError(out.error || res.statusText, out.hint);
  return out;
}
export const qs = (o) => new URLSearchParams(o).toString();

// Per-device conveniences; storage can be unavailable (private mode), so failures are ignored.
export const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`devdeck.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`devdeck.${k}`, JSON.stringify(v)); } catch {} },
};

// Shortcuts that pick by place, 1–9 (Settings → Keyboard): session tabs and the views (Terminal, Changes, Code…).
// Each is one modifier (or none); ⌘ / ⌃ takes either, since Chrome keeps ⌘1–9 for its own tabs outside the app.
export const KEY_MODS = {
  'cmd-ctrl': { label: '⌘ / ⌃', uses: ['cmd', 'ctrl'], test: (e) => (e.metaKey || e.ctrlKey) && !e.altKey },
  cmd: { label: '⌘', uses: ['cmd'], test: (e) => e.metaKey && !e.ctrlKey && !e.altKey },
  ctrl: { label: '⌃', uses: ['ctrl'], test: (e) => e.ctrlKey && !e.metaKey && !e.altKey },
  alt: { label: '⌥', uses: ['alt'], test: (e) => e.altKey && !e.metaKey && !e.ctrlKey },
  'cmd-alt': { label: '⌥⌘', uses: ['cmd-alt'], test: (e) => e.altKey && e.metaKey && !e.ctrlKey },
  off: { label: 'Off', uses: [], test: () => false },
};
export const keyMods = () => ({ sessions: 'cmd-ctrl', views: 'alt', ...store.get('keys', {}) });
// the place (1–9) a key picks with this modifier, or 0 (the key's code: ⌥ changes what the key types)
export const placeKey = (e, mod) => (!e.shiftKey && KEY_MODS[mod]?.test(e) && /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0);
export const keyLabel = (mod, n) => (mod === 'off' ? '' : `${KEY_MODS[mod].label.split(' ')[0]}${n}`);

export const shortPath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
// the home folder (or /): too big to open as a code project
export const isHome = (p) => ['~', '/'].includes(shortPath(p).replace(/\/$/, '') || '/');
export const fmtDate = (s) => { try { return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return s; } };
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy:', text);
  }
}
export const Copy = ({ text }) => html`<button class="copy" title="Copy" onClick=${() => copy(text)}><${Icon} name="copy" cls="sm" /></button>`;

// Theme: system (follows macOS / iOS), light or dark. index.html applies the saved one before first paint.
export const THEMES = [['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']];
export function applyTheme(t) {
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
export const onKeyboard = (fn) => { keyboardListeners.add(fn); return () => keyboardListeners.delete(fn); };
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
export const isDark = () => (document.documentElement.dataset.theme || (DARK_OS.matches ? 'dark' : 'light')) === 'dark';
const themeListeners = new Set();
export const onThemeChange = (fn) => { themeListeners.add(fn); return () => themeListeners.delete(fn); };
DARK_OS.addEventListener('change', () => themeListeners.forEach((f) => f()));
// How an agent at work shows: the word, a small animation, or a GIF you pick. Per device, like the theme.
export const WORKING_STYLES = [['text', 'Word'], ['dots', 'Dots'], ['spinner', 'Spinner'], ['sparkle', 'Sparkle'], ['bars', 'Bars'], ['gif', 'Your GIF']];
let working = { style: store.get('working', 'text'), gif: store.get('workingGif', '') };
const workingListeners = new Set();
export function setWorking(next) {
  working = { ...working, ...next };
  store.set('working', working.style);
  if ('gif' in next) store.set('workingGif', working.gif);
  workingListeners.forEach((f) => f());
}
export function useWorking() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); workingListeners.add(f); return () => workingListeners.delete(f); }, []);
  return working;
}
export function Working({ style }) {
  const w = useWorking();
  const s = style || (w.style === 'gif' && !w.gif ? 'text' : w.style);
  if (s === 'text') return 'working';
  if (s === 'gif') return html`<img class="wk wk-gif" src=${w.gif} alt="working" title="working" />`;
  return html`<span class=${`wk wk-${s}`} role="img" aria-label="working" title="working">${s === 'dots' || s === 'bars' ? html`<i></i><i></i><i></i>` : ''}</span>`;
}

export function ThemeSwitch({ labels }) {
  const [t, setT] = useState(store.get('theme', 'system'));
  const pick = (v) => { setT(v); store.set('theme', v); applyTheme(v); };
  return html`<div class="seg theme-seg" role="radiogroup" aria-label="Theme">${THEMES.map(([id, icon, label]) => html`
    <button class=${t === id ? 'sel' : ''} role="radio" aria-checked=${t === id} title=${label} onClick=${() => pick(id)}><${Icon} name=${icon} cls="sm" />${labels && label}</button>`)}</div>`;
}

// A text field that replaces a label while renaming: Enter saves, Esc cancels, clicking away saves.
export function InlineEdit({ value, onSave, onCancel }) {
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
export const ask = (opts) => new Promise((done) => ui.ask({ ...opts, done }));
export function Ask({ title, body, ok = 'OK', cancel = 'Cancel', danger, done, close }) {
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
          ${cancel && html`<button class="btn" onClick=${() => finish(false)}>${cancel}</button>`}
          <button ref=${okRef} class=${`btn ${danger ? 'danger-fill' : 'primary'}`} onClick=${() => finish(true)}>${ok}</button>
        </div>
      </div>
    </div>`;
}
export function usePoll(fn, ms, deps) {
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

export function useJob(id, onDone) {
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

export function ErrorBox({ error }) {
  if (!error) return null;
  return html`<div class="alert bad"><${Icon} name="triangle-alert" /><div><b>${error.message || String(error)}</b>${error.hint && html`<span>${error.hint}</span>`}</div></div>`;
}

export function Switch({ checked, onChange }) {
  return html`<span class="switch"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} /><i></i></span>`;
}

// App-wide openers (menus, palette, sidebar) registered by App, so any row can call them.
// Installing devdeck as an app (PWA). Chrome on Android says when it can (beforeinstallprompt, caught in index.html in
// case it comes before this module), and that event drives our Install button. It comes only after some use of the
// page, and never once installed; iOS has none (Share → Add to Home Screen). useInstall: { installed, ready, run }.
let installEvent = window.ddInstall ?? null;
const installListeners = new Set();
const installChanged = () => installListeners.forEach((f) => f());
addEventListener('dd-installable', () => { installEvent = window.ddInstall; installChanged(); });
addEventListener('appinstalled', () => { installEvent = window.ddInstall = null; installChanged(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((n) => n + 1); installListeners.add(f); return () => installListeners.delete(f); }, []);
  const run = async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') installEvent = window.ddInstall = null;
    installChanged();
  };
  return { installed: standalone(), ready: !!installEvent, run };
}

// ⟳ / Reload: every PR from GitHub, change counts and the list (ui.reload is set by App)
export const reloadAll = () => ui.reload().then(() => toast('Up to date'), (e) => toast(e.message));

export const ui = { copyText: () => {}, openMenu: () => {}, palette: () => {}, reload: async () => {}, toggleSide: () => {}, moveSession: () => {}, focusCompose: () => {}, ask: (o) => o.done(confirm(o.title)), checkout: () => null, locked: () => false, newWorktreeFrom: () => {} };

// ---------- popovers ----------

// Anchored to a button on the desktop; a bottom sheet on the phone.
export function Popover({ rect, onClose, children, width = 260 }) {
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
export const MenuItems = ({ items, onClose }) => items.filter(Boolean).map((it) => (it === '-' ? html`<hr />` : html`
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

export function MenuButton({ items }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class="menu-wrap">
      <button class="icon-btn" onClick=${() => setOpen(!open)} aria-label="More"><${Icon} name="ellipsis" /></button>
      ${open && html`<${Menu} items=${items} onClose=${() => setOpen(false)} />`}
    </div>`;
}

// ---------- overview ----------

export const Section = ({ title, aside, children }) => html`
  <section class="ov-sec"><div class="ov-h"><h2>${title}</h2><span class="ov-rule"></span>${aside}</div>${children}</section>`;

export const ago = (sec) => {
  const m = Math.floor((Date.now() / 1000 - sec) / 60);
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};
