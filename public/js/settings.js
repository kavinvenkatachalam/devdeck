// Tools and Settings screens.
import { html, useEffect, useRef, useState } from '/vendor/preact.js';
import { TERM_THEMES, setTermTheme } from './terminal.js';
import { Copy, ErrorBox, Icon, ThemeSwitch, WORKING_STYLES, Working, ask, call, isIOS, plural, setWorking, shortPath, store, toast, useInstall, useWorking } from './lib.js';

// ---------- tools & settings ----------

export function ToolsView() {
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

// Picks how "working" shows, each choice drawn as it would look. Your GIF is kept in this browser (up to 500 KB).
function WorkingPick() {
  const w = useWorking();
  const file = useRef();
  const upload = (f) => {
    if (!f) return;
    if (f.size > 500 * 1024) return toast('That GIF is over 500 KB: pick a smaller one');
    const r = new FileReader();
    r.onload = () => setWorking({ style: 'gif', gif: r.result });
    r.readAsDataURL(f);
  };
  return html`
    <div class="seg working-seg" role="radiogroup" aria-label="Working status">
      ${WORKING_STYLES.map(([id, label]) => html`
        <button class=${w.style === id ? 'sel' : ''} role="radio" aria-checked=${w.style === id} title=${label}
          onClick=${() => (id === 'gif' && !w.gif ? file.current.click() : setWorking({ style: id }))}>
          ${id === 'gif' && !w.gif ? html`<${Icon} name="plus" cls="xs" />GIF` : html`<${Working} style=${id} />`}
        </button>`)}
    </div>
    ${w.gif && html`<button class="linkish small" onClick=${() => file.current.click()}>Change GIF</button>`}
    <input ref=${file} type="file" accept="image/gif,image/webp,image/png" hidden onChange=${(e) => { upload(e.target.files[0]); e.target.value = ''; }} />`;
}

// The terminal's colors: each choice a swatch of its background, text and a few of its colors.
function TermThemePick() {
  const [id, setId] = useState(store.get('termTheme', 'match'));
  const pick = (v) => { setId(v); setTermTheme(v); };
  const swatch = (t) => html`<span class="tt-sw" style=${`background:${t.background};color:${t.foreground}`}>Aa<i style=${`background:${t.red}`}></i><i style=${`background:${t.green}`}></i><i style=${`background:${t.blue}`}></i></span>`;
  return html`
    <div class="tt-pick" role="radiogroup" aria-label="Terminal colors">
      <button class=${`tt ${id === 'match' ? 'sel' : ''}`} role="radio" aria-checked=${id === 'match'} onClick=${() => pick('match')} title="devdeck's own colors, light or dark with the app">
        <span class="tt-sw tt-match"><span style=${`background:${TERM_THEMES.light.background};color:${TERM_THEMES.light.foreground}`}>A</span><span style=${`background:${TERM_THEMES.dark.background};color:${TERM_THEMES.dark.foreground}`}>a</span></span>devdeck<span class="tt-def">default</span>
      </button>
      ${Object.entries(TERM_THEMES).map(([k, t]) => html`
        <button class=${`tt ${id === k ? 'sel' : ''}`} role="radio" aria-checked=${id === k} onClick=${() => pick(k)}>${swatch(t)}${t.label}</button>`)}
    </div>`;
}

export function SettingsView({ onSaved }) {
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
  const install = useInstall();
  const share = async () => { setErr(null); try { setTs(await call('POST', '/tailscale/share')); } catch (e) { setErr(e); } };
  if (!s) return html`<div class="scroll"><div class="muted">Loading…</div></div>`;
  const report = (i) => s.rootsReport[i] && s.rootsReport[i].root === roots[i] ? s.rootsReport[i] : null;

  return html`
    <div class="scroll"><div class="stack" style="max-width:680px">
      <${ErrorBox} error=${err} />
      <div class="card">
        <div class="card-h"><h3><${Icon} name="sun-moon" />Appearance</h3></div>
        <div class="card-b"><dl class="kv"><dt>Theme</dt><dd><${ThemeSwitch} labels /></dd><dt>Working</dt><dd class="working-dd"><${WorkingPick} /></dd><dt>Terminal</dt><dd><${TermThemePick} /></dd></dl>
          <div class="small muted" style="margin-top:10px">Claude Code picks its own colors: if its text looks off on a light terminal, run <span class="mono">/theme</span> in it and choose a light one.</div></div>
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
          <dl class="kv"><dt>App</dt><dd>${install.installed ? html`<span class="ok-text">Installed</span>`
            : install.ready ? html`<button class="btn sm primary" onClick=${install.run}><${Icon} name="smartphone" cls="sm" />Install devdeck</button>`
            : html`<span class="small muted">${isIOS() ? 'In Safari: Share → Add to Home Screen' : 'Open devdeck on the phone, then Install from here or from the browser menu (Add to Home screen)'}</span>`}</dd></dl>
        </div>
      </div>
    </div></div>`;
}
