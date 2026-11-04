// Schedules: commands devdeck runs quietly at a time, on a cron expression, or when a Claude limit resets (schedules.ts).
import { html, useEffect, useRef, useState } from '/vendor/preact.js';
import { ErrorBox, Icon, Switch, ask, call, shortPath, toast, ui, usePoll } from './lib.js';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WINDOWS = { fiveHour: '5-hour', week: 'weekly' };

// "today 9:00", "tomorrow 9:00", "Fri 9:00", "14 Nov 9:00"
function when(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (n) => new Date(Date.now() + n * 864e5).toDateString();
  if (d.toDateString() === day(0)) return `today ${time}`;
  if (d.toDateString() === day(1)) return `tomorrow ${time}`;
  if (d.toDateString() === day(-1)) return `yesterday ${time}`;
  if (Math.abs(ms - Date.now()) < 6 * 864e5) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function daysText(days) {
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (days.join() === '0,6') return 'Weekends';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

const whenText = (w, account) =>
  w.kind === 'time' ? `${daysText(w.days)} at ${w.time}${account ? ` · ${account}` : ''}`
  : w.kind === 'cron' ? html`Cron <span class="mono">${w.expr}</span>${account ? ` · ${account}` : ''}`
  : `When the ${WINDOWS[w.window]} limit resets${w.idle === false ? '' : ' or no window is running'}${w.quiet ? `, not ${w.quiet.from}–${w.quiet.to}` : ''} · ${w.account}`;

const RUN = { ok: ['ok', 'Done'], failed: ['bad', 'Failed'], running: ['run', 'Running'], unknown: ['off', 'No result'] };
const runText = (r) => `${RUN[r.status][1]}${r.status === 'failed' && r.code !== undefined ? ` (exit ${r.code})` : ''}${r.ms !== undefined ? ` · ${r.ms < 1000 ? `${r.ms} ms` : `${Math.round(r.ms / 1000)} s`}` : ''}`;

// a message to Claude that starts the next window, and reports when that one resets
const START = 'claude -p "hi" --output-format stream-json --verbose';

// "7", "730", "7:5", "19.30" → "07:00", "07:30", "07:05", "19:30"; null if it isn't a time
function parseTime(t) {
  const m = /^(\d{1,2})(?:[:.](\d{1,2}))?$/.exec(t.trim().replace(/^(\d{1,2})(\d\d)$/, '$1:$2'));
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2] ?? 0)];
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
}
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

// A time (HH:MM): type one, or pick from the half hours.
function TimeField({ value, onChange, disabled }) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const list = useRef(null);
  useEffect(() => setText(value), [value]);
  // the list opens at the time it has, or the half hour before it
  useEffect(() => {
    const sel = list.current?.querySelector('.sel') ?? list.current?.children[TIMES.findLastIndex((t) => t <= value)];
    sel?.scrollIntoView({ block: 'center' });
  }, [open]);
  const commit = () => {
    const t = parseTime(text);
    if (t && t !== value) onChange(t);
    setText(t ?? value);
    setOpen(false);
  };
  const pick = (t) => { onChange(t); setText(t); setOpen(false); };
  return html`
    <span class="time-field">
      <input class="mono" value=${text} disabled=${disabled} inputmode="numeric" placeholder="HH:MM" aria-label="Time"
        onFocus=${() => setOpen(true)} onClick=${() => setOpen(true)} onInput=${(e) => setText(e.target.value)} onBlur=${commit}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setText(value); setOpen(false); } }} />
      <${Icon} name="clock" cls="xs subtle" />
      ${open && !disabled && html`
        <div class="time-list" ref=${list} onMouseDown=${(e) => e.preventDefault()}>
          ${TIMES.map((t) => html`<button class=${t === value ? 'sel' : ''} onClick=${() => pick(t)}>${t}</button>`)}
        </div>`}
    </span>`;
}

const NIGHT = { from: '23:00', to: '07:00' };
const BLANK = { name: '', cmd: '', cwd: '~', when: { kind: 'time', time: '09:00', days: [1, 2, 3, 4, 5] } };

// Add or change one.
function Editor({ initial, accounts, onClose, onSaved }) {
  const [s, setS] = useState(initial);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [next, setNext] = useState(null);
  const w = s.when;
  const setWhen = (x) => setS({ ...s, when: { ...w, ...x } });
  const kind = (k) => setS({ ...s, when: k === 'time' ? { kind: 'time', time: w.time || '09:00', days: w.days || [1, 2, 3, 4, 5] } : k === 'cron' ? { kind: 'cron', expr: w.expr || '0 9 * * 1-5' } : { kind: 'reset', account: w.account || accounts[0]?.account || '', window: w.window || 'fiveHour' } });
  // the next few times it would run, as you type
  useEffect(() => {
    if (w.kind === 'reset') return setNext(null);
    const t = setTimeout(() => call('POST', '/schedule-check', { when: w }).then((r) => setNext(r.next), (e) => setNext(e.message)), 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(w)]);
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await (s.id ? call('PUT', `/schedules/${s.id}`, s) : call('POST', '/schedules', s));
      onSaved();
    } catch (e) {
      setErr(e);
    }
    setSaving(false);
  };
  const account = accounts.find((a) => a.account === w.account);
  return html`
    <div class="card">
      <div class="card-h"><h3><${Icon} name="calendar-clock" />${s.id ? 'Edit schedule' : 'New schedule'}</h3></div>
      <div class="card-b" style="display:grid;gap:14px">
        <${ErrorBox} error=${err} />
        <div class="field"><label>Command</label>
          <textarea class="mono" rows="3" placeholder='claude -p "hi"' value=${s.cmd} onInput=${(e) => setS({ ...s, cmd: e.target.value })} autocapitalize="off" spellcheck=${false}></textarea>
          <div class="hint">Runs in the background in your login shell, so it finds what your terminal does. No terminal opens; its output goes in the run's log.</div></div>
        <div class="cols">
          <div class="field"><label>Name</label><input value=${s.name} placeholder="Optional" onInput=${(e) => setS({ ...s, name: e.target.value })} /></div>
          <div class="field"><label>Folder</label><input class="mono" value=${s.cwd} placeholder="~" autocapitalize="off" onInput=${(e) => setS({ ...s, cwd: e.target.value })} /></div>
        </div>
        <div class="field"><label>When</label>
          <div class="seg" role="radiogroup" aria-label="When">
            ${[['time', 'At a time'], ['cron', 'Cron'], ['reset', 'Claude limit resets']].map(([k, label]) => html`
              <button class=${w.kind === k ? 'sel' : ''} role="radio" aria-checked=${w.kind === k} onClick=${() => kind(k)}>${label}</button>`)}
          </div>
        </div>
        ${w.kind === 'time' && html`
          <div class="row wrap sched-time">
            <${TimeField} value=${w.time} onChange=${(time) => setWhen({ time })} />
            <div class="seg day-seg" aria-label="Days">
              ${DAYS.map((d, i) => html`<button class=${w.days.includes(i) ? 'sel' : ''} title=${DAY_NAMES[i]} aria-pressed=${w.days.includes(i)}
                onClick=${() => setWhen({ days: w.days.includes(i) ? w.days.filter((x) => x !== i) : [...w.days, i].sort() })}>${d}</button>`)}
            </div>
          </div>`}
        ${w.kind === 'cron' && html`
          <div class="field"><input class="mono" value=${w.expr} placeholder="0 9 * * 1-5" autocapitalize="off" spellcheck=${false} onInput=${(e) => setWhen({ expr: e.target.value })} />
            <div class="hint">minute hour day month weekday: <span class="mono">*/30 * * * *</span> every 30 minutes, <span class="mono">0 */5 * * *</span> every 5 hours, <span class="mono">0 9 * * 1-5</span> 9:00 on weekdays</div></div>`}
        ${w.kind === 'reset' && (accounts.length ? html`
          <div class="row wrap">
            <select value=${w.account} onChange=${(e) => setWhen({ account: e.target.value })} style="width:auto;min-width:220px">
              ${accounts.map((a) => html`<option value=${a.account}>${a.account}</option>`)}
            </select>
            <div class="seg" role="radiogroup" aria-label="Limit">
              ${Object.entries(WINDOWS).map(([k, label]) => html`<button class=${w.window === k ? 'sel' : ''} role="radio" aria-checked=${w.window === k} onClick=${() => setWhen({ window: k })}>${label[0].toUpperCase() + label.slice(1)}</button>`)}
            </div>
          </div>
          <div class="row wrap sched-time">
            <${Switch} checked=${!!w.quiet} onChange=${(on) => setWhen({ quiet: on ? NIGHT : undefined })} />
            <span class=${w.quiet ? '' : 'muted'}>Not at night: between</span>
            <${TimeField} value=${(w.quiet ?? NIGHT).from} disabled=${!w.quiet} onChange=${(from) => setWhen({ quiet: { ...w.quiet, from } })} />
            <span class=${w.quiet ? '' : 'muted'}>and</span>
            <${TimeField} value=${(w.quiet ?? NIGHT).to} disabled=${!w.quiet} onChange=${(to) => setWhen({ quiet: { ...w.quiet, to } })} />
          </div>
          ${w.quiet && html`<div class="small muted">A reset in these hours waits until ${w.quiet.to}, so the next window starts when you're back.</div>`}
          <div class="row wrap sched-time">
            <${Switch} checked=${w.idle !== false} onChange=${(on) => setWhen({ idle: on ? undefined : false })} />
            <span>Start a new window when none is running</span>
          </div>
          <div class="small muted">${w.idle !== false ? 'When a window ends unused, or devdeck was off at a reset, it starts the next one' + (w.quiet ? ' (not at night)' : '') + '. If a run doesn\'t start one, it tries again after a window\'s length.' : 'Only at a reset: when no window is running, the next one starts when you next use Claude.'}</div>
          <div class="small muted">Runs a minute after the limit resets, signed in as this account. Sending Claude a message starts the next window then, instead of when you're next back.
            With Claude's detailed output, devdeck also learns when that window resets, so it runs again then without you:${" "}
            <span class="mono">${START}</span>${s.cmd.trim() !== START && html` <button class="linkish" style="display:inline" onClick=${() => setS({ ...s, cmd: START })}>Use this command</button>`}
            ${account && !account.connected && html` <b class="warn-text">Connect this account's Claude usage on the Overview first: that's how devdeck learns when it resets.</b>`}</div>`
          : html`<div class="small muted">No Claude subscription is signed in on this Mac.</div>`)}
        ${w.kind !== 'reset' && accounts.length > 0 && html`
          <div class="field"><label>Claude account</label>
            <select value=${s.account || ''} onChange=${(e) => setS({ ...s, account: e.target.value })} style="width:auto;min-width:220px">
              <option value="">As in your terminal</option>
              ${accounts.map((a) => html`<option value=${a.account}>${a.account}</option>`)}
            </select>
            <div class="hint">The account <span class="mono">claude</span> runs signed in as, if the command runs it.</div></div>`}
        ${w.kind !== 'reset' && next && html`<div class="small muted">${Array.isArray(next) ? (next.length ? `Next: ${next.map(when).join(' · ')}` : 'This never comes round.') : html`<span class="bad-text">${next}</span>`}</div>`}
        <div class="row"><span class="grow"></span>
          <button class="btn sm" onClick=${onClose}>Cancel</button>
          <button class="btn primary sm" disabled=${saving || !s.cmd.trim()} onClick=${save}>${s.id ? 'Save' : 'Add schedule'}</button>
        </div>
      </div>
    </div>`;
}

// Runs, newest first; one opens to its log. `named` shows each one's schedule (the history of them all).
function RunList({ runs, named }) {
  const [open, setOpen] = useState(null);
  const [log, setLog] = useState(null);
  const key = (r) => `${r.id}/${r.at}`;
  useEffect(() => {
    const r = open && runs?.find((x) => key(x) === open);
    setLog(null);
    if (r) call('GET', `/schedules/${r.id}/runs/${r.at}`).then((x) => setLog(x.text), (e) => setLog(e.message));
  }, [open, runs]);
  if (!runs) return html`<div class="small muted">Loading…</div>`;
  if (!runs.length) return html`<div class="small muted">No runs yet.</div>`;
  return html`
    <ul class="list sched-runs">${runs.map((r) => html`
      <li class=${open === key(r) ? 'sel' : ''} onClick=${() => setOpen(open === key(r) ? null : key(r))}>
        <span class=${`dot ${RUN[r.status][0]}`}></span>
        ${named && html`<span class="grow ellipsis">${r.name}</span>`}
        <span class=${named ? 'small muted' : 'grow'}>${when(r.at)}</span>
        <span class="small muted">${runText(r)}</span>
        <${Icon} name=${open === key(r) ? 'chevron-down' : 'chevron-right'} cls="xs subtle" />
      </li>
      ${open === key(r) && html`<pre class="logbox">${log ?? 'Loading…'}</pre>`}`)}
    </ul>`;
}

// A schedule's runs
function Runs({ id, last }) {
  const [runs, setRuns] = useState(null);
  useEffect(() => { call('GET', `/schedules/${id}/runs`).then((r) => setRuns(r.map((x) => ({ ...x, id }))), () => setRuns([])); }, [id, last?.at, last?.status]);
  return html`<${RunList} runs=${runs} />`;
}

// Every schedule's runs, and how long their logs are kept. Fetched again only when some schedule's last run changes.
const KEEP = [1, 3, 7];
const SHOWN = 10;
function History({ changed }) {
  const [h, setH] = useState(null);
  const [all, setAll] = useState(false);
  const load = () => call('GET', '/schedule-runs').then(setH, () => {});
  useEffect(() => { load(); }, [changed]);
  const keep = async (days) => {
    try { await call('PUT', '/settings', { keepRuns: days }); } catch (e) { toast(e.message); }
    load();
  };
  if (!h) return null;
  const more = h.runs.length - SHOWN;
  return html`
    <div class="card">
      <div class="card-h">
        <h3 class="grow"><${Icon} name="history" />Run history</h3>
        <label class="small muted row" style="gap:6px">Keep for
          <select value=${h.keepRuns} onChange=${(e) => keep(Number(e.target.value))} style="width:auto">
            ${KEEP.map((d) => html`<option value=${d}>${d === 1 ? '1 day' : `${d} days`}</option>`)}
          </select></label>
      </div>
      <div class="card-b">
        <${RunList} runs=${all ? h.runs : h.runs.slice(0, SHOWN)} named />
        ${more > 0 && html`<button class="linkish" style="margin-top:8px" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show ${more} more`}</button>`}
      </div>
    </div>`;
}

function Item({ s, onEdit, refresh }) {
  const [history, setHistory] = useState(false);
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message); } refresh(); };
  const toggle = (on) => act(() => call('PUT', `/schedules/${s.id}`, { on }));
  const runNow = () => act(async () => { await call('POST', `/schedules/${s.id}/run`); setHistory(true); toast('Started'); });
  // just the next run, not the schedule: it carries on after that one
  const skip = (on) => act(() => call('PUT', `/schedules/${s.id}`, { skip: on }));
  const remove = async () => (await ask({ title: `Delete "${s.name}"?`, body: 'Its run logs go too.', ok: 'Delete', danger: true })) && act(() => call('DELETE', `/schedules/${s.id}`));
  const more = (e) => ui.openMenu(e.currentTarget, [
    { icon: 'play', label: 'Run now', run: runNow },
    { icon: 'pencil', label: 'Edit', run: onEdit },
    '-',
    { icon: 'trash-2', label: 'Delete', danger: true, run: remove },
  ]);
  return html`
    <div class=${`card sched ${s.on ? '' : 'off'}`}>
      <div class="card-h">
        <${Switch} checked=${s.on} onChange=${toggle} />
        <h3 class="ellipsis" title=${s.name}>${s.name}</h3>
        ${s.last && html`<span class=${`pill ${RUN[s.last.status][0] === 'bad' ? 'bad' : ''}`} title=${runText(s.last)}><span class=${`dot ${RUN[s.last.status][0]}`}></span>${RUN[s.last.status][1]}</span>`}
        <button class="icon-btn sm" title="Run now" onClick=${runNow}><${Icon} name="play" cls="sm" /></button>
        <button class="icon-btn sm" title="More" onClick=${more}><${Icon} name="ellipsis" cls="sm" /></button>
      </div>
      <div class="card-b">
        <dl class="kv">
          <dt>When</dt><dd>${whenText(s.when, s.account)}</dd>
          <dt>Next</dt><dd class="sched-next">${!s.on ? html`<span class="muted">Off</span>` : html`
            ${s.next ? html`<span>${s.next <= Date.now() ? 'Now' : when(s.next)}</span>${!s.skipped && html`<button class="linkish" title="Skip just this run" onClick=${() => skip(true)}>Skip</button>`}` : html`<span class="muted">${s.why || '—'}</span>`}
            ${s.skipped && html`<span class="muted small">· ${when(s.skipped)} skipped</span><button class="linkish" onClick=${() => skip(null)}>Undo</button>`}`}</dd>
          <dt>Command</dt><dd><span class="mono ellipsis" title=${s.cmd}>${s.cmd}</span></dd>
          <dt>Folder</dt><dd class="mono">${shortPath(s.cwd)}</dd>
          <dt>Last run</dt><dd>${s.last ? html`<button class="linkish" onClick=${() => setHistory(!history)}>${when(s.last.at)} · ${runText(s.last)}<${Icon} name=${history ? 'chevron-down' : 'chevron-right'} cls="xs" /></button>` : html`<span class="muted">Not yet</span>`}</dd>
        </dl>
        ${history && html`<div style="margin-top:10px"><${Runs} id=${s.id} last=${s.last} /></div>`}
      </div>
    </div>`;
}

export function SchedulesView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // a schedule, or BLANK for a new one
  const refresh = () => call('GET', '/schedules').then((d) => { setData(d); setErr(null); }, setErr);
  usePoll(refresh, 5000, []);
  if (!data) return html`<div class="scroll"><${ErrorBox} error=${err} />${!err && html`<div class="muted">Loading…</div>`}</div>`;
  const saved = () => { setEditing(null); refresh(); };
  return html`
    <div class="scroll"><div class="stack" style="max-width:720px">
      <${ErrorBox} error=${err} />
      ${!editing && html`
        <div class="row">
          <span class="small muted grow">Commands devdeck runs for you while it's running. Missed while the Mac slept? It runs once when it wakes.</span>
          <button class="btn primary sm" onClick=${() => setEditing(BLANK)}><${Icon} name="plus" cls="sm" />New schedule</button>
        </div>`}
      ${editing && html`<${Editor} key=${editing.id || 'new'} initial=${editing} accounts=${data.accounts} onClose=${() => setEditing(null)} onSaved=${saved} />`}
      ${!data.schedules.length && !editing && html`
        <div class="empty"><div class="empty-box">
          <div class="empty-ic"><${Icon} name="calendar-clock" /></div>
          <h2>No schedules yet</h2>
          <p>Run a command at a time, on a cron expression, or when your Claude limit resets: a nightly script, a report, or a message to Claude that starts the next 5-hour window right away.</p>
          <button class="btn primary" onClick=${() => setEditing(BLANK)}><${Icon} name="plus" cls="sm" />New schedule</button>
        </div></div>`}
      ${data.schedules.map((s) => editing?.id === s.id ? null : html`<${Item} key=${s.id} s=${s} refresh=${refresh} onEdit=${() => setEditing(s)} />`)}
      ${data.schedules.length > 0 && html`<${History} changed=${data.schedules.map((s) => `${s.id}${s.last?.at}${s.last?.status}`).join()} />`}
    </div></div>`;
}
