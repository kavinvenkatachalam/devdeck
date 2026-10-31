// The Changes, Code and Preview lenses.
import { html, useEffect, useState } from '/vendor/preact.js';
import { lensKeysIn } from './chrome.js';
import { JobView } from './env.js';
import { ErrorBox, Icon, call, isDark, onThemeChange, plural, qs, store, toast } from './lib.js';

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

export function ChangesPane({ path }) {
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

export const codeUrl = (path) => `/code/?${qs({ folder: path })}`;

export function CodePane({ path, active }) {
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
  const repair = async () => {
    setErr(null);
    try { setJobId((await call('POST', '/code/repair')).id); } catch (e) { setErr(e); }
  };
  const vscode = async () => {
    setErr(null);
    try { await call('POST', '/open/vscode', { path }); toast('Opened in VS Code on the Mac'); } catch (e) { setErr(e); }
  };
  // your editor's settings and extensions come along on their own (see codeserver.ts); full screen is in the ⋯ menu
  if (st?.running && !st.stale && !st.broken && active)
    return html`<div class="code-frame"><iframe key=${path} src=${codeUrl(path)} title="Code" allow="clipboard-read; clipboard-write" onLoad=${(e) => lensKeysIn(e.target)}></iframe></div>`;
  return html`
    <div class="empty"><div class="empty-box" style="max-width:380px">
      <div class="empty-ic"><${Icon} name="code-xml" /></div>
      <h2>${st?.broken ? 'code-server needs a repair' : 'Browse & edit the code'}</h2>
      <p>${st?.broken ? `It crashes as it starts, so its terminal, extensions and git don't work. Usually Homebrew upgraded a library its ${st.node || 'node'} uses; upgrading ${st.node || 'node'} and code-server fixes it.`
        : st && !st.installed ? 'VS Code in the browser needs code-server, a one-time install.' : 'VS Code in the browser, on the Mac or your phone.'}</p>
      ${st?.broken && html`<pre class="small muted" style="text-align:left;white-space:pre-wrap">${st.broken}</pre>`}
      <div class="row wrap" style="justify-content:center">
        ${!st ? html`<span class="muted">Loading…</span>` : st.broken
          ? html`<button class="btn primary" disabled=${!st.brew || !!jobId} onClick=${repair}><${Icon} name="wrench" />Repair</button>`
          : st.installed
          ? html`<button class="btn primary" disabled=${busy} onClick=${start}><${Icon} name="play" />${busy ? 'Starting…' : 'Open in browser'}</button>`
          : html`<button class="btn primary" disabled=${!st.brew || !!jobId} onClick=${install}><${Icon} name="package" />Install code-server</button>`}
        <button class="btn hide-phone" onClick=${vscode}><${Icon} name="monitor" />VS Code on this Mac</button>
      </div>
      ${err && html`<div style="margin-top:14px;text-align:left"><${ErrorBox} error=${err} /></div>`}
      ${jobId && html`<div style="margin-top:14px;text-align:left"><${JobView} jobId=${jobId} onDone=${() => { setJobId(null); load(); }} /></div>`}
    </div></div>`;
}

// ---------- preview ----------

// The worktree's running app, beside its terminal. It stays loaded while another lens shows (hidden), so the page
// you were on survives a look at the terminal. ToolJet signs in here only with devdeck on localhost (index.html).
export function PreviewPane({ ec, active }) {
  const [n, setN] = useState(0); // bumped by ⟳: a fresh frame (the app's own page is another origin, out of reach)
  const fe = ec.env?.services?.frontend;
  const url = fe?.state === 'running' ? fe.url : '';
  if (url) return html`
    <div class="preview">
      <div class="preview-bar">
        <button class="icon-btn sm" title="Reload" onClick=${() => setN(n + 1)}><${Icon} name="rotate-cw" cls="sm" /></button>
        <span class="mono ellipsis muted">${url.replace('http://', '')}</span>
        ${location.hostname !== 'localhost' && html`<span class="small warn ellipsis">Update the devdeck app to sign in here</span>`}
        <a class="icon-btn sm" href=${url} target="_blank" rel="noopener" title="Open in your browser"><${Icon} name="external-link" cls="sm" /></a>
      </div>
      <div class="code-frame"><iframe key=${n} src=${url} title="Preview" allow="clipboard-read; clipboard-write"></iframe></div>
    </div>`;
  if (!active) return null;
  const { env, st, busy, act } = ec;
  const starting = fe?.state === 'starting' || busy;
  return html`
    <div class="empty"><div class="empty-box">
      <div class="empty-ic"><${Icon} name=${starting ? 'loader-circle' : 'app-window'} cls=${starting ? 'spin' : ''} /></div>
      <h2>${starting ? 'Starting the app…' : 'See the app here'}</h2>
      <p class="muted">${starting ? st?.sub || 'It shows here once the frontend answers.' : "Start this worktree's servers, and its app opens here, beside the terminal."}</p>
      ${env && !starting && html`<button class="btn primary" onClick=${() => act('start')}><${Icon} name="play" />${env.ready ? 'Start servers' : 'Set up & start'}</button>`}
    </div></div>`;
}

export const vscode = async (path) => { try { await call('POST', '/open/vscode', { path }); toast('Opened in VS Code on the Mac'); } catch (e) { toast(e.message); } };
