// The Env lens: a ToolJet checkout's servers, jobs, sign-in, license and logs.
import { html, useCallback, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact.js';
import { Copy, ErrorBox, Icon, ago, ask, call, fmtDate, qs, shortPath, store, toast, useJob, usePoll } from './lib.js';

// ---------- env ----------

function envState(env) {
  if (!env?.tooljet) return null;
  const s = env.services;
  if (env.job?.status === 'running') return { cls: 'warn', icon: 'loader-circle', label: env.job.title, sub: 'Working…' };
  const up = (x) => x.state === 'running';
  if (up(s.server) && up(s.frontend)) return { cls: 'ok', icon: 'server', label: 'Running', sub: `Frontend :${s.frontend.port} · server :${s.server.port}` };
  // (no job runs, see above) alive but its port is closed: rebuilding after an edit, or stuck on an error
  if (s.server.state === 'starting' || s.frontend.state === 'starting') return { cls: 'warn', icon: 'triangle-alert', label: 'Not answering', sub: 'A server is running but its port is closed: rebuilding, or stuck on an error. See its log' };
  if (up(s.server) || up(s.frontend)) return { cls: 'warn', icon: 'server', label: up(s.server) ? 'Server only' : 'Frontend only', sub: 'One service is down' };
  if (s.server.state === 'busy' || s.frontend.state === 'busy') return { cls: 'bad', icon: 'triangle-alert', label: 'Port in use', sub: 'Another process holds a port' };
  if (!env.ready) return { cls: '', icon: 'package', label: 'Not set up', sub: 'Set up creates .env, database and dependencies' };
  return { cls: '', icon: 'server', label: 'Stopped', sub: `Ready on :${s.frontend.port}` };
}

// Env status: polled every 5 s on the Env tab or while a job runs. Elsewhere it's read once and then again only
// when the session list (refreshed every 5 s anyway) sees a server go up or down: see useEnvControls.
function useEnv(path, enabled, fast) {
  const [env, setEnv] = useState(null);
  const load = useCallback(() => enabled && call('GET', `/env?${qs({ path })}`).then(setEnv).catch(() => {}), [path, enabled]);
  const poll = fast || env?.job?.status === 'running';
  usePoll(load, poll ? 5000 : 3_600_000, [path, enabled, poll]);
  return [env, load];
}

export function JobView({ jobId, onDone, onDiscard }) {
  const job = useJob(jobId, onDone);
  const logRef = useRef();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [job?.log.length]);
  if (!job) return null;
  const done = job.steps.filter((s) => ['done', 'skipped'].includes(s.status)).length;
  const secs = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  return html`
    <div class="card">
      <div class="card-h">
        <h3>${job.status === 'running' ? html`<${Icon} name="loader-circle" cls="spin" />` : job.status === 'done' ? html`<${Icon} name="check" />` : html`<${Icon} name="triangle-alert" />`}${job.title}</h3>
        <span class=${`pill ${job.status === 'running' ? 'warn' : job.status === 'done' ? 'ok' : 'bad'}`}>${job.status === 'running' ? `${done}/${job.steps.length}` : job.status === 'done' ? 'Done' : 'Failed'} · ${secs}s</span>
      </div>
      <div class="card-b">
        ${job.status === 'running' && html`<div class="progress"><div style=${`width:${(done / job.steps.length) * 100}%`}></div></div>`}
        <div class="steps">
          ${job.steps.map((s) => html`
            <div class=${`step ${s.status}`}>
              <span class="si">${s.status === 'done' ? html`<${Icon} name="check" />` : s.status === 'failed' ? html`<${Icon} name="x" />` : ''}</span>
              <span>${s.label}</span>${s.detail && html`<span class="sd">${s.detail}</span>`}
            </div>`)}
        </div>
        ${job.error && html`<div style="margin-top:10px"><${ErrorBox} error=${{ message: job.error, hint: job.hint }} /></div>`}
        ${onDiscard && job.status === 'failed' && /unsaved work/.test(job.error || '') && html`<div class="row" style="margin-top:10px"><button class="btn danger" onClick=${onDiscard}><${Icon} name="trash-2" />Remove anyway, discard changes</button></div>`}
        ${job.log.length > 0 && html`
          <details style="margin-top:10px" open=${job.status === 'failed'}>
            <summary class="linkish" style="cursor:pointer"><${Icon} name="scroll-text" cls="sm" />Log · ${job.log.length} lines</summary>
            <pre class="logbox" style="margin-top:8px" ref=${logRef}>${job.log.join('\n')}</pre>
          </details>`}
      </div>
    </div>`;
}

export function EnvPane({ c, env, reload, jobId, setJobId, onRemoved, removeDiscard }) {
  const [details, setDetails] = useState(null);
  const [err, setErr] = useState(null);
  const up = env?.services?.server.state === 'running';
  const loadDetails = () => call('GET', `/env/details?${qs({ path: c.path })}`).then(setDetails).catch((e) => setDetails({ licenseError: e.message }));
  useEffect(() => { loadDetails(); }, [c.path, up]);
  if (!env) return html`<div class="scroll"><div class="muted">Loading…</div></div>`;
  // (a worktree being removed stops looking like ToolJet halfway; keep its progress visible)
  if (!env.tooljet) return html`<div class="scroll"><div class="stack">${jobId ? html`<${JobView} key=${jobId} jobId=${jobId} onDone=${(j) => j.title === 'Remove worktree' && j.status === 'done' && onRemoved()} />` : html`<div class="card"><div class="card-b muted">No ToolJet dev environment here.</div></div>`}</div></div>`;

  const st = envState(env);
  const s = env.services;
  const busy = env.job?.status === 'running';
  const anyUp = ['running', 'starting'].includes(s.server.state) || ['running', 'starting'].includes(s.frontend.state);
  const act = async (a) => {
    if (!(await okToStart(c, a))) return;
    setErr(null);
    try { setJobId((await call('POST', `/env/${a}`, { path: c.path })).id); reload(); } catch (e) { setErr(e); }
  };
  const applyKey = async () => {
    setErr(null);
    try { setJobId((await call('POST', '/env/license', { path: c.path })).id); } catch (e) { setErr(e); }
  };
  const jobDone = (j) => {
    reload();
    loadDetails();
    if (j.title === 'Remove worktree' && j.status === 'done') onRemoved();
  };
  const lic = details?.license;
  const org = env.org || details?.org;
  const url = s.frontend.url;

  return html`
    <div class="scroll"><div class="stack">
      <div class="card">
        <div class="hero">
          <div class=${`hero-icon ${st.cls}`}><${Icon} name=${st.icon} cls=${`lg ${st.icon === 'loader-circle' ? 'spin' : ''}`} /></div>
          <div class="hero-text"><b>${st.label}</b><span>${st.sub}</span></div>
          <div class="hero-actions">
            ${!anyUp && html`<button class="btn primary" disabled=${busy} onClick=${() => act('start')}><${Icon} name="play" />${env.ready ? 'Start' : 'Set up & start'}</button>`}
            ${!anyUp && !env.ready && html`<button class="btn" disabled=${busy} onClick=${() => act('setup')}>Set up only</button>`}
            ${anyUp && html`<button class="btn" disabled=${busy} onClick=${() => act('stop')}><${Icon} name="square" />Stop</button>`}
            ${anyUp && html`<button class="btn" disabled=${busy} onClick=${() => act('restart')}><${Icon} name="rotate-cw" />Restart</button>`}
            ${s.frontend.state === 'running' && html`<a class="btn hide-phone" href=${url} target="_blank" rel="noopener"><${Icon} name="external-link" />Open app</a>`}
          </div>
        </div>
        <div class="facts">
          <div class="fact"><div>Frontend</div><b class="mono">${s.frontend.port ? `:${s.frontend.port} · ${s.frontend.state}` : '—'}</b></div>
          <div class="fact"><div>Server</div><b class="mono">${s.server.port ? `:${s.server.port} · ${s.server.state}` : '—'}</b></div>
          <div class="fact"><div>Database</div><b class="mono" title=${env.db || ''}>${env.db ? (env.dbExists ? env.db : `${env.db} (missing)`) : '—'}</b></div>
          <div class="fact"><div>Edition</div><b>${env.edition.toUpperCase()}${env.deps ? '' : ' · no deps'}</b></div>
        </div>
      </div>
      <${ErrorBox} error=${err} />
      ${jobId && html`<${JobView} key=${jobId} jobId=${jobId} onDone=${jobDone} onDiscard=${removeDiscard} />`}

      <div class="cols">
        <div class="card">
          <div class="card-h"><h3><${Icon} name="key-round" />Sign in</h3>${url && s.frontend.state === 'running' && html`<a class="linkish hide-phone" href=${url} target="_blank" rel="noopener">Open <${Icon} name="external-link" cls="sm" /></a>`}</div>
          <div class="card-b">
            <dl class="kv">
              <dt>URL</dt><dd>${url ? html`<span class="mono ellipsis">${url.replace('http://', '')}</span><${Copy} text=${url} />` : html`<span class="muted">after setup</span>`}</dd>
              <dt>Email</dt><dd><span class="mono ellipsis">${env.login.email}</span><${Copy} text=${env.login.email} /></dd>
              <dt>Password</dt><dd><span class="mono">${env.login.password}</span><${Copy} text=${env.login.password} /></dd>
              <dt>Workspace</dt><dd>${org ? html`<span class="ellipsis">${org.name || org.id}</span>` : html`<span class="muted">${up ? '—' : 'once the server runs'}</span>`}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-h">
            <h3><${Icon} name="sparkles" />License</h3>
            ${lic && html`<span class=${`pill ${lic.valid && !lic.expired ? 'ok' : 'bad'}`}>${lic.expired ? 'Expired' : lic.valid ? 'Valid' : 'Basic plan'}</span>`}
          </div>
          <div class="card-b">
            ${!details ? html`<span class="muted">Loading…</span>` : !lic ? html`<span class="muted">${details.licenseError}</span>` : html`
              <dl class="kv">
                ${lic.expiry && html`<dt>Expires</dt><dd>${fmtDate(lic.expiry)}</dd>`}
                ${lic.type && html`<dt>Type</dt><dd>${lic.type}</dd>`}
                <dt>Features</dt><dd>${lic.features.filter((f) => f.on).length} of ${lic.features.length} on</dd>
                <dt>Auto-apply</dt><dd>${env.licenseKeySet ? html`<span>on${env.licensed ? ` · …${env.licensed}` : ''}</span>${up && html`<button class="btn sm ghost" onClick=${applyKey}>Apply now</button>`}` : html`<span class="muted">add a key in Settings</span>`}</dd>
              </dl>`}
          </div>
          ${lic?.limits?.length > 0 && html`
            <details class="disclose" style="border-top:1px solid var(--border)">
              <summary>Limits & features<${Icon} name="chevron-down" cls="chev" /></summary>
              <div class="card-b" style="display:grid;gap:12px">
                <div class="limits">${lic.limits.map((l) => html`<div><b>${l.value === 'UNLIMITED' ? '∞' : l.value}</b>${l.name}</div>`)}</div>
                <div class="chips">${lic.features.map((f) => html`<span class=${`chip ${f.on ? 'on' : 'off'}`}>${f.name}</span>`)}</div>
              </div>
            </details>`}
        </div>
      </div>

      <${Logs} path=${c.path} />
    </div></div>`;
}

// The newest lines of a server's log, kept at the bottom and refreshed every 5 s while open (unless you scroll up
// to read). Earlier runs (each server start begins a new log; the last 5 are kept) are picked from the list.
function Logs({ path }) {
  const [name, setName] = useState('server');
  const [run, setRun] = useState('');
  const [log, setLog] = useState(null);
  const [open, setOpen] = useState(false);
  const box = useRef();
  const load = () => call('GET', `/env/log?${qs({ path, name, run, lines: 400 })}`).then(setLog).catch((e) => setLog({ text: e.message }));
  useEffect(() => { setLog(null); if (box.current) delete box.current.dataset.read; }, [path, name, run]);
  usePoll(() => open && (!run || !log) && load(), 5000, [path, name, run, open, !log]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && (!el.dataset.read || el.scrollHeight - el.scrollTop - el.clientHeight < 40)) el.scrollTop = el.scrollHeight;
    if (el && log) el.dataset.read = '1';
  }, [log?.text]);
  const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return html`
    <details class="card disclose" onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary><${Icon} name="scroll-text" />Logs<${Icon} name="chevron-down" cls="chev" /></summary>
      <div class="card-b" style="display:grid;gap:10px">
        <div class="row wrap">
          <div class="seg">${['server', 'frontend', 'setup'].map((n) => html`<button class=${n === name ? 'sel' : ''} onClick=${() => { setName(n); setRun(''); }}>${n}</button>`)}</div>
          ${log?.runs?.length > 0 && html`
            <select class="run-pick" value=${run} onChange=${(e) => setRun(e.target.value)} title="Earlier runs: each start begins a new log">
              <option value="">Latest run</option>
              ${log.runs.map((r) => html`<option value=${r.id}>Run of ${when(r.updated)}</option>`)}
            </select>`}
          <span class="grow"></span>
          ${log?.file && html`<span class="small subtle ellipsis" title=${log.file}>${log.updated ? `updated ${ago(log.updated / 1000)}` : 'no log yet'}</span>`}
        </div>
        <pre class="logbox tall" ref=${box}>${log ? log.text || 'Nothing logged yet.' : 'Loading…'}</pre>
      </div>
    </details>`;
}

// ---------- screens ----------

// Env controls for a ToolJet checkout, shared by the session and worktree screens.
// The main checkout's servers use the default ports; starting them by accident clashes with ones you run by hand.
const okToStart = async (c, a) => a !== 'start' || !c?.main || ask({ title: 'Start the main checkout\'s servers?', body: `${shortPath(c.path)} runs on the default ports, which servers you start by hand also use.`, ok: 'Start servers' });

export function useEnvControls(co, fast) {
  const path = co?.path || '';
  const [env, reload] = useEnv(path, !!co?.tooljet, fast);
  const live = co?.servers ? `${!!co.servers.server}/${!!co.servers.frontend}` : '';
  useEffect(() => { if (live && env) reload(); }, [live]); // a server went up or down (started from a terminal, crashed…)
  const [jobId, setJobId] = useState(store.get(`job.${path}`, null));
  useEffect(() => { setJobId(store.get(`job.${path}`, null)); }, [path]);
  // follow a job the server reports (started from New, or from another device)
  useEffect(() => { if (env?.job?.status === 'running' && env.job.id !== jobId) setJobId(env.job.id); }, [env?.job?.id, env?.job?.status]);
  useEffect(() => { if (path) store.set(`job.${path}`, jobId); }, [jobId]);
  const s = env?.services;
  const anyUp = !!s && (['running', 'starting'].includes(s.server.state) || ['running', 'starting'].includes(s.frontend.state));
  const busy = env?.job?.status === 'running';
  const act = async (a) => {
    if (!(await okToStart(co, a))) return false;
    try { setJobId((await call('POST', `/env/${a}`, { path })).id); reload(); return true; } catch (e) { toast(e.message); return false; }
  };
  return { env, reload, jobId, setJobId, anyUp, busy, act, st: envState(env) };
}

export function EnvButtons({ co, ec, hide }) {
  if (!co?.tooljet || !ec.env || hide) return null;
  const { st, anyUp, busy, act, env } = ec;
  return html`
    ${st?.cls && html`<span class=${`pill ${st.cls} hide-phone`}><span class=${`dot ${st.cls}`}></span>${st.label}</span>`}
    ${!anyUp && html`<button class="btn sm hide-phone" disabled=${busy} onClick=${() => act('start')} title="Start the ToolJet servers"><${Icon} name="play" cls="sm" /><span class="btn-label">${env.ready ? 'Start servers' : 'Set up & start'}</span></button>`}
    ${anyUp && html`<button class="btn sm hide-phone" disabled=${busy} onClick=${() => act('stop')} title="Stop the servers"><${Icon} name="square" cls="sm" /><span class="btn-label">Stop</span></button>`}`;
}

export async function removeWorktree(co, ec, discard) {
  if (!discard && !(await ask({ title: 'Remove this worktree?', body: `${shortPath(co.path)}\n\nThis will stop its servers, end its sessions, drop its databases and delete the folder. The branch will be kept.`, ok: 'Remove worktree', danger: true }))) return false;
  if (discard && !(await ask({ title: 'Discard changes and remove?', body: 'Uncommitted changes and unpushed EE commits will be lost, then the worktree will be removed.', ok: 'Discard & remove', danger: true }))) return false;
  try { ec.setJobId((await call('POST', '/worktrees/remove', { path: co.path, discard: !!discard })).id); return true; } catch (e) { toast(e.message); return false; }
}
