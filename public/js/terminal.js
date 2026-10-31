// The terminal (xterm over a WebSocket to tmux), the phone compose box, quick replies and the folder tabs above it.
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact.js';
import { ErrorBox, Icon, InlineEdit, ask, call, copy, isDark, keyLabel, keyMods, onKeyboard, onThemeChange, phone, qs, store, toast, ui } from './lib.js';
import { AGENT, confirmEnd, leadTab, renameSessionTo, sessionHere, tabDot } from './model.js';

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
// Settings › Appearance › Terminal: devdeck (the default: its dark or light, following the theme switch) or one palette
// always. Dark and Light are devdeck's own two, kept whatever the app's theme.
const ansi = (s) => Object.fromEntries(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((c, i) => {
  const v = s.split(' ');
  return [[c, v[i]], [`bright${c[0].toUpperCase()}${c.slice(1)}`, v[i + 8]]];
}));
const SOLARIZED = ansi('#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3');
export const TERM_THEMES = {
  dark: { label: 'Always dark', ...TERM_THEME },
  light: { label: 'Always light', ...TERM_THEME_LIGHT },
  'one-dark': { label: 'One Dark', background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451',
    ...ansi('#3f4451 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #d7dae0 #4f5666 #be5046 #98c379 #d19a66 #61afef #c678dd #56b6c2 #e6e6e6') },
  dracula: { label: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    ...ansi('#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff') },
  nord: { label: 'Nord', background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    ...ansi('#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4') },
  'solarized-dark': { label: 'Solarized Dark', background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642', ...SOLARIZED },
  'solarized-light': { label: 'Solarized Light', background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5', ...SOLARIZED },
};
const termThemeId = () => (TERM_THEMES[store.get('termTheme', 'match')] ? store.get('termTheme') : 'match');
const termTheme = () => (termThemeId() === 'match' ? (isDark() ? TERM_THEME : TERM_THEME_LIGHT) : TERM_THEMES[termThemeId()]);
const isLightBg = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};
// On a light background, colors a program picked for dark ones (Claude Code's dark theme: white bullets, pale grays
// and links) are darkened until they read; dark themes keep programs' dim text as it is.
const termOptions = () => {
  const theme = termTheme();
  return { theme, minimumContrastRatio: isLightBg(theme.background) ? 4.5 : 1 };
};
// The frame around the terminal (and the logs) takes a fixed palette's background too.
function applyTermFrame() {
  const root = document.documentElement.style;
  const t = termThemeId() === 'match' ? null : TERM_THEMES[termThemeId()];
  if (t) { root.setProperty('--term-bg', t.background); root.setProperty('--term-fg', t.foreground); }
  else { root.removeProperty('--term-bg'); root.removeProperty('--term-fg'); }
}
applyTermFrame();
const termListeners = new Set();
export function setTermTheme(id) {
  store.set('termTheme', id);
  applyTermFrame();
  termListeners.forEach((f) => f());
}

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

function Terminal({ session, tabIndex, sendRef, ctlRef, onGone, small, autofocus = true }) {
  const el = useRef();
  const wsRef = useRef();
  const termRef = useRef();
  const [dropping, setDropping] = useState(false);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState(null); // { found, more }: tmux's count of matches
  const [panes, setPanes] = useState([]); // a split terminal's panes, on tmux's grid (see the server); [] unsplit
  // Input is numbered and kept until the server confirms it (see the effect); the server writes each number once.
  const unacked = useRef([]);
  const inputId = useRef(Math.random().toString(36).slice(2));
  const inputSeq = useRef(0);
  const paneRef = useRef(() => {});
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
      ...termOptions(),
      allowProposedApi: true, // unicode graphemes
      macOptionIsMeta: true, // ⌥ sends Meta to the CLI instead of composing characters
      macOptionClickForcesSelection: true, // ⌥-drag selects in the browser even while tmux has the mouse
      // links whose text isn't the address (OSC 8: Claude's "⧉ Plan" for an artifact): a click opens them, a hover
      // shows where they go
      linkHandler: {
        activate: (_e, uri) => window.open(uri, '_blank', 'noopener'),
        hover: (_e, uri) => { if (el.current) el.current.title = uri; },
        leave: () => { if (el.current) el.current.title = ''; },
      },
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
    const restyle = () => Object.assign(term.options, termOptions());
    const offTheme = onThemeChange(restyle);
    termListeners.add(restyle);
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
      // ⌘F searches the history; ⌘D / ⇧⌘D split the terminal right / down (as in iTerm)
      if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'f' || e.key.toLowerCase() === 'd')) {
        e.preventDefault();
        if (e.type === 'keydown') e.key === 'f' ? setFinding(true) : send({ t: 'p', do: e.shiftKey ? 'down' : 'right' });
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

    // The connection comes and goes (the phone slept, the network changed, devdeck restarted); the terminal stays, so a
    // reconnect doesn't flash or rebuild it: tmux redraws the screen when the new connection attaches.
    let ws = null;
    let retry = 0;
    let reconnect = 0;
    const again = (wait) => { clearTimeout(reconnect); reconnect = setTimeout(connect, wait); };
    const send = (m) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    };
    // Input is never lost: each piece is numbered and kept until the server confirms it, and re-sent after a reconnect
    // (the server writes each number once). Unconfirmed after 3 s means the connection is dead though it looks open,
    // as a phone's often is after sleeping or changing network: drop it and reconnect.
    const deliver = (m) => { if (send({ t: 'i', d: m.d, id: inputId.current, seq: m.seq })) m.at = Date.now(); };
    const drop = () => {
      if (!ws) return;
      ws.onopen = ws.onclose = ws.onmessage = null;
      ws.close();
      ws = wsRef.current = null;
    };
    function connect() {
      drop();
      for (const m of unacked.current) m.at = 0;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws?${qs({ session, window: String(tabIndex ?? ''), cols: term.cols, rows: term.rows })}`);
      ws = wsRef.current = sock;
      sock.binaryType = 'arraybuffer'; // the server's confirmations come as binary frames, terminal output as text
      sock.onopen = () => {
        retry = 0;
        for (const m of unacked.current) deliver(m);
      };
      sock.onmessage = (e) => {
        if (typeof e.data === 'string') return term.write(e.data);
        const reply = JSON.parse(new TextDecoder().decode(e.data));
        if ('found' in reply) return setFound(reply);
        if ('panes' in reply) return setPanes(reply.panes);
        if ('busy' in reply) return confirmClose(reply);
        unacked.current = unacked.current.filter((m) => m.seq > reply.ack);
      };
      // Dropped: reconnect on its own, soon at first.
      sock.onclose = (e) => {
        ws = wsRef.current = null;
        if (e.code === 4404) return onGone();
        term.write('\r\n\x1b[2m[reconnecting…]\x1b[0m');
        again(Math.min(5000, 300 * 2 ** retry++));
      };
    }
    const type = (d) => {
      const m = { seq: ++inputSeq.current, d, at: 0 };
      unacked.current.push(m);
      if (ws?.readyState === WebSocket.OPEN) deliver(m);
      else if (!ws || ws.readyState > WebSocket.OPEN) again(0);
    };
    sendRef.current = (d, focus = true) => {
      type(d);
      if (focus) term.focus();
    };
    // search and split, from the frame's buttons and the panes' own (tmux does them: see the server)
    const pane = (what, id, force) => { send({ t: 'p', do: what, pane: id, force }); term.focus(); };
    paneRef.current = pane;
    ui.focusTerm = () => term.focus(); // back to the Terminal lens from the keyboard (TopBar)
    const confirmClose = async ({ busy, pane: id }) => {
      if (await ask({ title: `Close this pane?`, body: `${busy} is running in it, and will be ended.`, ok: 'Close pane', danger: true })) pane('close', id, true);
    };
    if (ctlRef) ctlRef.current = { find: () => setFinding(true), pane };
    const watchdog = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) for (const m of unacked.current) if (!m.at) deliver(m); // queued while it was down
      const m = unacked.current[0];
      if (m?.at && Date.now() - m.at > 3000) again(0);
    }, 1000);
    connect();
    // back in the app, or back online: reconnect now if it's closed; if it looks open, an empty input checks it's alive
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (ws?.readyState === WebSocket.OPEN) type('');
      else if (!ws || ws.readyState > WebSocket.OPEN) again(0);
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
        endSel(); // the text moves: a selection would point at other text
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
    // Copy on the phone, as in a native terminal app: a long press (the finger held still) selects the word under it,
    // with a buzz; two handles drag its ends; the bar copies it or selects the whole screen. Touching the terminal
    // anywhere else ends it. Older output: scroll back to it first, or ⋯ → Copy from history (CopySheet).
    // Positions are row * cols + col on the visible screen (xterm keeps no history of its own: tmux has it).
    const ov = document.createElement('div');
    ov.className = 'tsel';
    ov.hidden = true;
    ov.innerHTML = '<div class="tsel-h a"></div><div class="tsel-h b"></div>'
      + '<div class="tsel-bar"><button data-do="copy">Copy</button><button data-do="all">All</button><button data-do="done" aria-label="Done">✕</button></div>';
    el.current.appendChild(ov);
    const [handleA, handleB, bar] = ov.children;
    let sel = null; // { a, b }: the two ends, in any order
    let anchor = 0; // while a handle is dragged: the other end
    let swallowClick = false; // the tap that ended a selection, or a long press, isn't a tap on the terminal
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const grid = () => {
      const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { r, w: r.width / term.cols, h: r.height / term.rows };
    };
    const posAt = (x, y) => {
      const { r, w, h } = grid();
      return clamp(Math.floor((y - r.top) / h), 0, term.rows - 1) * term.cols + clamp(Math.floor((x - r.left) / w), 0, term.cols - 1);
    };
    const showSel = () => {
      const [s, e] = [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
      term.select(s % term.cols, term.buffer.active.viewportY + Math.floor(s / term.cols), e - s + 1);
      const { r, w, h } = grid();
      const o = el.current.getBoundingClientRect();
      const [dx, dy] = [r.left - o.left + el.current.scrollLeft, r.top - o.top + el.current.scrollTop];
      const xy = (pos, after) => [dx + ((pos % term.cols) + (after ? 1 : 0)) * w, dy + (Math.floor(pos / term.cols) + 1) * h];
      const [ax, ay] = xy(s);
      const [bx, by] = xy(e, true);
      handleA.style.transform = `translate(${ax - 22}px, ${ay}px)`;
      handleB.style.transform = `translate(${bx}px, ${by}px)`;
      ov.hidden = false;
      // above the selection, or below if there's no room; always inside the visible terminal (All selects all of it)
      const [view, barH] = [el.current.scrollTop, bar.offsetHeight];
      const top = ay - h - barH - 8 >= view ? ay - h - barH - 8 : by + 30;
      bar.style.transform = `translate(${clamp(ax, 4, o.width - bar.offsetWidth - 4)}px, ${clamp(top, view + 4, view + el.current.clientHeight - barH - 4)}px)`;
    };
    const endSel = () => {
      if (!sel) return;
      sel = null;
      ov.hidden = true;
      term.clearSelection();
    };
    // the word under the finger (a run of non-space cells; the second half of a wide character counts as its first)
    const selectWord = (x, y) => {
      const pos = posAt(x, y);
      const [row, col] = [Math.floor(pos / term.cols), pos % term.cols];
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
      const inWord = (i) => { const c = line?.getCell(i); return !!c && (c.getWidth() === 0 || /\S/.test(c.getChars())); };
      let [s, e] = [col, col];
      if (inWord(col)) {
        while (s > 0 && inWord(s - 1)) s--;
        while (e < term.cols - 1 && inWord(e + 1)) e++;
      }
      sel = { a: row * term.cols + s, b: row * term.cols + e };
      showSel();
    };
    for (const [handle, end] of [[handleA, 'start'], [handleB, 'end']]) {
      handle.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        const [s, en] = [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
        anchor = end === 'start' ? en : s;
      }, { passive: true });
      handle.addEventListener('touchmove', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const t = e.touches[0];
        sel = { a: anchor, b: posAt(t.clientX, t.clientY - grid().h) }; // the finger is under the handle, below the text
        showSel();
      }, { passive: false });
      handle.addEventListener('touchend', (e) => e.stopPropagation());
    }
    // the bar's touches are its own: the terminal's handlers would end the selection, or cancel the button's click
    bar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    bar.addEventListener('touchend', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      const what = e.target.closest('button')?.dataset.do;
      if (what === 'all') { sel = { a: 0, b: term.rows * term.cols - 1 }; return showSel(); }
      if (what === 'copy') {
        const text = term.getSelection();
        navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast("Couldn't copy"));
      }
      endSel();
    });
    const selGone = term.onSelectionChange(() => { if (sel && !term.hasSelection()) { sel = null; ov.hidden = true; } });

    let press = 0, pressed = false, startX = 0, startY = 0;
    const touchStart = (e) => {
      if (e.touches.length !== 1) return;
      cancelAnimationFrame(glide);
      if (sel) { endSel(); swallowClick = true; } // a touch elsewhere ends the selection
      const t = e.touches[0];
      [startX, startY, pressed] = [t.clientX, t.clientY, false];
      clearTimeout(press);
      if (phone()) press = setTimeout(() => { pressed = swallowClick = true; navigator.vibrate?.(12); selectWord(startX, startY); }, 500);
      const box = term.element.getBoundingClientRect();
      const cell = (n, from, size, count) => Math.min(count, Math.max(1, Math.floor(((n - from) / size) * count) + 1));
      at = [cell(t.clientX, box.left, box.width, term.cols), cell(t.clientY, box.top, box.height, term.rows)];
      [lastY, lastT, acc, speed] = [t.clientY, e.timeStamp, 0, 0];
    };
    const touchMove = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault(); // ours: iOS would otherwise start its own page bounce and stop sending the touch
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clearTimeout(press); // a drag, not a press
      if (pressed) return;
      const dy = lastY - t.clientY;
      speed = 0.8 * (dy / Math.max(1, e.timeStamp - lastT)) + 0.2 * speed;
      [lastY, lastT] = [t.clientY, e.timeStamp];
      scrollBy(dy);
    };
    const touchEnd = (e) => {
      clearTimeout(press);
      if (pressed) { // no mouse events after a long press: xterm would drop the selection
        pressed = false;
        return void e.preventDefault();
      }
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
    for (const [ev, fn] of touch) el.current.addEventListener(ev, fn, { passive: ev === 'touchstart' });

    // Phone keyboards (autocorrect, predictions, composing) type badly into a terminal: there you write in the
    // message box under it, and a tap on the terminal opens that instead. A hardware keyboard still types here.
    let tapped = null;
    const noMenu = (e) => e.preventDefault(); // the browser's own long-press menu would cover the selection
    if (phone()) {
      term.textarea?.setAttribute('inputmode', 'none');
      tapped = () => (swallowClick ? (swallowClick = false) : ui.focusCompose());
      el.current.addEventListener('click', tapped);
      el.current.addEventListener('contextmenu', noMenu);
    }

    return () => {
      if (ui.focusTerm) ui.focusTerm = null;
      el.current?.removeEventListener('paste', onPaste, true);
      if (tapped) el.current?.removeEventListener('click', tapped);
      el.current?.removeEventListener('contextmenu', noMenu);
      clearTimeout(press);
      selGone.dispose();
      ov.remove();
      for (const [ev, fn] of touch) el.current?.removeEventListener(ev, fn);
      cancelAnimationFrame(glide);
      cancelAnimationFrame(flush);
      offTheme();
      termListeners.delete(restyle);
      clearTimeout(reconnect);
      clearInterval(watchdog);
      drop();
      moved.dispose();
      offKeys();
      cancelAnimationFrame(follow);
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('online', wake);
      ro.disconnect();
      input.dispose();
      term.dispose();
    };
  }, [session]);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'w', w: tabIndex }));
  }, [tabIndex]);

  const find = (q, dir) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ t: 'f', q, dir }));
  const endFind = () => {
    find('', 'end');
    setFinding(false);
    setFound(null);
    termRef.current?.focus();
  };
  return html`
    <div class=${`term ${dropping ? 'dropping' : ''}`} ref=${el}
      onDragOver=${(e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
      onDragLeave=${(e) => { if (!el.current.contains(e.relatedTarget)) setDropping(false); }}
      onDrop=${(e) => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(false); putFiles([...e.dataTransfer.files]); }}></div>
    ${panes.length > 1 && html`<${PaneBars} panes=${panes} term=${termRef.current} box=${el.current} act=${(...a) => paneRef.current(...a)} />`}
    ${finding && html`<${FindBar} found=${found} onFind=${find} onClose=${endFind} />`}`;
}

// A split terminal: over the header line tmux leaves above each pane, its name (the program's title, as Claude sets
// it, else the program and folder) and its own buttons. Clicking a header puts that pane in focus.
function PaneBars({ panes, term, box, act }) {
  const screen = term?.element?.querySelector('.xterm-screen');
  if (!screen || !box) return null;
  const r = screen.getBoundingClientRect();
  const card = box.parentElement.getBoundingClientRect();
  const [w, h] = [r.width / term.cols, r.height / term.rows];
  const [x0, y0] = [r.left - card.left, r.top - card.top - box.scrollTop];
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  return panes.map((p) => html`
    <div class=${`pane-bar ${p.active ? 'on' : ''}`} key=${p.id} onClick=${() => act('focus', p.id)}
      style=${`left:${x0 + p.x * w}px;top:${y0 + (p.y - 1) * h}px;width:${p.w * w}px;height:${h}px`}>
      <span class="ellipsis">${p.title || html`${p.command}<span class="pane-dir"> · ${p.dir}</span>`}</span>
      <span class="grow"></span>
      <button title="Split right" onClick=${stop(() => act('right', p.id))}><${Icon} name="columns-2" cls="xs" /></button>
      <button title="Split down" onClick=${stop(() => act('down', p.id))}><${Icon} name="rows-2" cls="xs" /></button>
      <button class="pane-x" title="Close pane" onClick=${stop(() => act('close', p.id))}><${Icon} name="x" cls="xs" /></button>
    </div>`);
}

// Search the terminal's whole history (tmux searches it and highlights the matches; see the server). Typing searches up
// from the bottom; Enter / ↑ goes to the older match, ⇧Enter / ↓ to the newer one; Esc goes back to the live screen.
function FindBar({ found, onFind, onClose }) {
  const input = useRef();
  const [q, setQ] = useState('');
  const typing = useRef(0);
  useEffect(() => { input.current?.focus(); return () => clearTimeout(typing.current); }, []);
  const change = (v) => {
    setQ(v);
    clearTimeout(typing.current);
    typing.current = setTimeout(() => (v ? onFind(v, 'new') : onFind('', 'end')), 150);
  };
  const step = (dir) => q && onFind(q, dir);
  const count = !q || !found ? '' : found.found ? `${found.found}${found.more ? '+' : ''} found` : 'No results';
  return html`
    <div class="findbar" onKeyDown=${(e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? 'down' : 'up'); }
      else if (e.key === 'f' && e.metaKey) { e.preventDefault(); input.current.select(); }
    }}>
      <${Icon} name="search" cls="sm" />
      <input ref=${input} value=${q} placeholder="Search history" onInput=${(e) => change(e.target.value)}
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
      <span class=${`small ${found && !found.found && q ? 'find-none' : 'muted'}`}>${count}</span>
      <button class="icon-btn sm" title="Older (Enter)" disabled=${!q} onClick=${() => step('up')}><${Icon} name="arrow-up" cls="sm" /></button>
      <button class="icon-btn sm" title="Newer (⇧Enter)" disabled=${!q} onClick=${() => step('down')}><${Icon} name="arrow-down" cls="sm" /></button>
      <button class="icon-btn sm" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" cls="sm" /></button>
    </div>`;
}

const KEYS = [
  ['esc', '\x1b'], ['tab', '\t'], ['⇧tab', '\x1b[Z'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['⏎', '\r'],
];

// Write a message into the terminal as one paste, then press Enter. Easier than typing into the terminal on a
// phone, and multi-line text arrives as one prompt (bracketed paste) instead of one line per Enter.
// Photos, screenshots and files (the paperclip, or pasted into the box) are saved on the Mac like a file dropped on the
// terminal and wait above the box as chips; sending puts their paths in front of the message, so Claude opens them.
function Compose({ sendRef }) {
  const ta = useRef();
  const picker = useRef();
  const [files, setFiles] = useState([]); // { key, name, path?, preview? } (no path yet: still uploading)
  const uploading = files.some((f) => !f.path);
  // read from the box itself, not from state: Android keyboards (Gboard) can still be composing the last word
  const go = () => {
    if (uploading) return;
    const el = ta.current;
    const v = [...files.map((f) => shellEscape(f.path)), el.value].filter(Boolean).join(' ');
    // sendRef is looked up each time: the terminal may have reconnected in between
    if (v) sendRef.current(`\x1b[200~${v}\x1b[201~`, false);
    setTimeout(() => sendRef.current('\r', false), v ? 60 : 0);
    el.value = '';
    el.style.height = '';
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    setFiles([]);
    el.focus();
  };
  const grow = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; };
  useEffect(() => { ui.focusCompose = () => ta.current?.focus(); return () => { ui.focusCompose = () => {}; }; }, []);
  const attach = (list) => {
    for (const file of list) {
      const key = Math.random().toString(36).slice(2);
      const chip = { key, name: file.name || 'pasted', preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '' };
      setFiles((fs) => [...fs, chip]);
      uploadFiles([file])
        .then(([path]) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, path } : f))))
        .catch((e) => { toast(e.message); remove(key); });
    }
  };
  const remove = (key) => setFiles((fs) => fs.filter((f) => {
    if (f.key === key && f.preview) URL.revokeObjectURL(f.preview);
    return f.key !== key;
  }));
  const onPaste = (e) => {
    const list = [...(e.clipboardData?.files || [])];
    if (!list.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    attach(list);
  };
  // The keyboard's Return starts a new line, the Send button sends (⌘/Ctrl+Return too, on a hardware keyboard): a
  // message of several lines arrives as one prompt. Commands aren't words, so no autocorrect.
  return html`
    ${files.length > 0 && html`
      <div class="attachments">${files.map((f) => html`
        <span class=${`att ${f.path ? '' : 'busy'}`} key=${f.key} title=${f.name}>
          ${f.preview ? html`<img src=${f.preview} alt="" />` : html`<${Icon} name="paperclip" cls="sm" />`}
          <span class="ellipsis">${f.name}</span>
          ${f.path ? html`<button title="Remove" onPointerDown=${(e) => e.preventDefault()} onClick=${() => remove(f.key)}><${Icon} name="x" cls="xs" /></button>` : html`<${Icon} name="loader-circle" cls="xs spin" />`}
        </span>`)}
      </div>`}
    <div class="compose">
      <input ref=${picker} type="file" multiple hidden onChange=${(e) => { attach([...e.target.files]); e.target.value = ''; }} />
      <button class="btn sm ghost attach" onPointerDown=${(e) => e.preventDefault()} onClick=${() => picker.current.click()} title="Attach photos or files">
        <${Icon} name="paperclip" cls="sm" /></button>
      <textarea ref=${ta} rows="1" placeholder=${files.length ? 'Say what to look at' : 'Message'} enterkeyhint="enter"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"
        onInput=${(e) => grow(e.target)} onPaste=${onPaste}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); go(); } }}></textarea>
      <button class="btn sm primary" disabled=${uploading} onPointerDown=${(e) => e.preventDefault()} onClick=${go} title=${uploading ? 'Uploading…' : 'Send'}><${Icon} name="send" cls="sm" /></button>
    </div>`;
}

// ⋯ → Copy from history: a session's text (its history, not only the screen) as plain text, full screen, where the
// phone's own long-press selection and Copy work. The button copies what's selected, or everything.
export function CopySheet({ session, onClose }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(false);
  const box = useRef();
  useEffect(() => {
    call('GET', `/sessions/${encodeURIComponent(session)}/text?${qs({ lines: 2000 })}`).then((r) => setText(r.text)).catch(setError);
    const k = (e) => e.key === 'Escape' && onClose();
    const sel = () => setSelected(!!String(getSelection()).trim());
    addEventListener('keydown', k);
    document.addEventListener('selectionchange', sel);
    return () => { removeEventListener('keydown', k); document.removeEventListener('selectionchange', sel); };
  }, [session]);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [text]); // newest at the bottom, as in the terminal
  return html`
    <div class="copy-view" role="dialog" aria-label="Copy text">
      <div class="copy-h">
        <button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
        <div class="grow" style="min-width:0"><b class="ellipsis">${session}</b><div class="small muted">Long-press to select</div></div>
        <button class="btn sm primary" disabled=${!text} onPointerDown=${(e) => e.preventDefault()} onClick=${() => copy(selected ? String(getSelection()) : text)}>
          <${Icon} name="copy" cls="sm" />${selected ? 'Copy selection' : 'Copy all'}</button>
      </div>
      ${error ? html`<div style="padding:12px"><${ErrorBox} error=${error} /></div>` : html`<pre ref=${box} class="copy-text">${text ?? 'Loading…'}</pre>`}
    </div>`;
}

// One tap answers an agent's prompt: an option's number, or Esc to cancel.
export function Replies({ t, refresh }) {
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
function FolderTabs({ s, siblings, refresh, openSession, onRenamed, ctlRef }) {
  const [editing, setEditing] = useState(null);
  if (!siblings.length) return null;
  const close = async (e, x) => {
    e.stopPropagation();
    if (!(await confirmEnd(x))) return;
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
            title=${`${x.name}${a ? ` · ${t.program} ${a[1]}` : ''}${i < 9 && keyMods().sessions !== 'off' ? ` (${keyLabel(keyMods().sessions, i + 1)})` : ''} · double-click to rename`}
            onDblClick=${(e) => { e.preventDefault(); setEditing(x.name); }}>
            ${i < 9 && html`<span class="ftab-k">${i + 1}</span>`}<span class=${`dot ${t ? tabDot(t) : 'off'}`}></span>
            ${editing === x.name
              ? html`<${InlineEdit} value=${x.name} onSave=${(v) => { setEditing(null); renameSessionTo(x, v, refresh, (_, to) => x.name === s.name && onRenamed(to)); }} onCancel=${() => setEditing(null)} />`
              : html`<span class="ellipsis">${x.name}</span>`}
            <button class="x" title="End session" onClick=${(e) => close(e, x)}><${Icon} name="x" cls="xs" /></button>
          </div>`;
      })}
      <button class="icon-btn sm" title=${s.folder ? `New session in ${s.folder}` : 'New session here'} onClick=${() => sessionHere(s, refresh, openSession)}><${Icon} name="plus" cls="sm" /></button>
      <span class="grow"></span>
      <div class="term-acts">
        <button class="icon-btn sm" title="Search (⌘F)" onClick=${() => ctlRef.current?.find()}><${Icon} name="search" cls="sm" /></button>
        <button class="icon-btn sm hide-phone" title="Split right (⌘D)" onClick=${() => ctlRef.current?.pane('right')}><${Icon} name="columns-2" cls="sm" /></button>
        <button class="icon-btn sm hide-phone" title="Split down (⇧⌘D)" onClick=${() => ctlRef.current?.pane('down')}><${Icon} name="rows-2" cls="sm" /></button>
      </div>
    </div>`;
}

// The session's terminal, framed: the folder's sessions as tabs on top, one-tap replies when an agent asks.
export function TerminalPane({ s, siblings, refresh, openSession, onRenamed }) {
  const sendRef = useRef(() => {});
  const ctlRef = useRef(null);
  const t = s.tabs[0];
  if (!t) return null;
  return html`
    <div class="term-unit">
      <${FolderTabs} s=${s} siblings=${siblings} refresh=${refresh} openSession=${openSession} onRenamed=${onRenamed} ctlRef=${ctlRef} />
      <${Replies} t=${t} refresh=${refresh} />
      <div class="term-card">
        <${Terminal} key=${s.name} session=${s.name} tabIndex=${t.index} sendRef=${sendRef} ctlRef=${ctlRef} onGone=${refresh} />
      </div>
    </div>
    <div class="keys">${KEYS.map(([l, seq]) => html`<button onPointerDown=${(e) => e.preventDefault()} onClick=${() => sendRef.current(seq, !phone())}>${l}</button>`)}</div>
    ${phone() && html`<${Compose} sendRef=${sendRef} />`}`;
}
