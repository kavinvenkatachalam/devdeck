import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize } from 'node:path';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { refuse, tailnetIdentity } from './access.ts';
import { claudeAccounts, onUsageChange, setUsage } from './claude.ts';
import { codeStatus, proxyHttp, proxyUpgrade, setCodeTheme, startCodeServer, stopCodeServer } from './codeserver.ts';
import { applyLicense, envDetails, envStatus, isConfigured, ports, REMOVE_STEPS, removeWorktree, SETUP_START_STEPS, SETUP_STEPS, setup, start, START_STEPS, stop, STOP_STEPS } from './devenv.ts';
import { branchBase, diff } from './diff.ts';
import { getJob, startJob } from './jobs.ts';
import { listening } from './net.ts';
import { discover, forgetStats, openable, projects, real, refreshAllStats, refreshStats } from './projects.ts';
import { addFolder, cleanFolder, folders, isLocked, lockedFolders, lockFolder, orderFolders, removeFolder, renameFolder } from './folders.ts';
import { refreshPr, refreshPrs } from './prs.ts';
import { hostStats } from './host.ts';
import { checkNow, runUpdate, startUpdateChecks, updateInfo } from './update.ts';
import { addWorktree, recentBranches, repoAt, worktrees } from './repo.ts';
import { expandHome, loadSettings, saveSettings } from './settings.ts';
import { capture, CmdError, run, stripAnsi, tail } from './sh.ts';
import { logFile, pastRuns, STATE_ROOT, updateState } from './state.ts';
import { shareOnTailnet, tailscaleStatus } from './tailscale.ts';
import { cleanEnv, createSession, killSession, listSessions, moveSession, paneProgram, oneTerminalEach, orderSessions, renameSession, passLinks, reply, safeName, scrubServerEnv, setFolder, tmux, tmuxArgs, VIEWER_SEP, withAgents } from './tmux.ts';
import { tools } from './workspace.ts';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

// Browser libraries are served from node_modules so the app works offline and loads nothing from a CDN.
const VENDOR: Record<string, string> = {
  'preact.js': 'node_modules/htm/preact/standalone.module.js',
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-unicode-graphemes.js': 'node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js',
  'addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-clipboard.js': 'node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js',
  'geist-mono.woff2': 'node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2',
  'geist-mono-ext.woff2': 'node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  status: number;
  hint?: string;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

// See access.ts. DEVDECK_HOSTS adds names to answer to (comma-separated host:port), e.g. when HOST is a LAN address.
const EXTRA_HOSTS = (process.env.DEVDECK_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const refused = (req: IncomingMessage) =>
  refuse({ host: req.headers.host, origin: req.headers.origin, login: String(req.headers['tailscale-user-login'] || '') }, { port: PORT, tailnet: tailnetIdentity(), extraHosts: EXTRA_HOSTS });

async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const UPLOADS = join(STATE_ROOT, 'uploads');
const MAX_UPLOAD = 200 * 2 ** 20;

// Each upload gets its own folder so the file keeps its name; folders older than a week are cleared out.
async function saveUpload(req: IncomingMessage, raw: string) {
  const name = basename(raw).replace(/[\0/]/g, '').slice(0, 120) || 'file';
  for (const d of existsSync(UPLOADS) ? readdirSync(UPLOADS) : [])
    if (Date.now() - statSync(join(UPLOADS, d)).mtimeMs > 7 * 86400_000) rmSync(join(UPLOADS, d), { recursive: true, force: true });
  const dir = join(UPLOADS, String(Date.now()));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  let size = 0;
  const out = createWriteStream(path);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, 'file is over 200 MB');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } catch (e) {
    out.destroy();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  await new Promise((r) => out.end(r));
  return path;
}

const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
};

// Always checked with the Mac (no-cache), but a file that hasn't changed comes back as a 304 with no body: over a slow
// link (the phone through a relay) opening devdeck doesn't download its scripts and fonts again.
function serveFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const st = existsSync(file) ? statSync(file) : undefined;
  if (!st?.isFile()) return send(res, 404, { error: 'not found' });
  const etag = `"${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}"`;
  const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

function folderArg(raw: unknown) {
  const path = expandHome(String(raw || ''));
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `not a folder: ${path}`);
  return path;
}

// The env status is polled; which repo a folder is (two git calls) is remembered for 30 s there.
const repoSeen = new Map<string, { at: number; value: Awaited<ReturnType<typeof repoAt>> }>();
async function repoAtCached(path: string) {
  const c = repoSeen.get(path);
  if (c && Date.now() - c.at < 30_000) return c.value;
  const value = await repoAt(path);
  repoSeen.set(path, { at: Date.now(), value });
  return value;
}

async function tooljetAt(raw: unknown) {
  const repo = await repoAt(folderArg(raw));
  if (!repo?.tooljet) throw new HttpError(400, 'not a ToolJet checkout');
  return repo;
}

// Set up and/or start a ToolJet checkout as one job; start sets up first when needed.
async function envJob(path: string, want: { setup?: boolean; start?: boolean }) {
  const repo = await tooljetAt(path);
  if (want.start) {
    const ready = (await envStatus(repo)).ready;
    if (ready) return startJob(repo.root, 'Start servers', START_STEPS, (ctx) => start(ctx, repo));
    return startJob(repo.root, 'Set up & start', SETUP_START_STEPS, async (ctx) => {
      await setup(ctx, repo);
      await start(ctx, repo);
    });
  }
  return startJob(repo.root, 'Set up dev environment', SETUP_STEPS, (ctx) => setup(ctx, repo));
}

// Sessions, each one terminal (any with several are split up first, one split at a time: every open
// browser polls this, and two splitting the same session at once would fight over its windows).
let splitting: Promise<boolean> | undefined;
async function sessionList() {
  const list = await listSessions();
  if (!list.some((s) => s.tabs.length > 1)) return list;
  splitting ??= oneTerminalEach(list).finally(() => (splitting = undefined));
  await splitting;
  return listSessions();
}

// Every open page asks for this every 5 s (the Mac and the phone: twice). One answer serves them all for 2 s, and
// one that's being worked out is waited on rather than started again. Any change made through devdeck drops it.
let shared: { roots: string; done: number; value: Promise<unknown> } | undefined;
function projectsShared(roots: string[]) {
  const key = JSON.stringify(roots);
  if (shared && shared.roots === key && (!shared.done || Date.now() - shared.done < 2000)) return shared.value;
  const mine: NonNullable<typeof shared> = {
    roots: key,
    done: 0,
    value: (async () => {
      const sessions = await withAgents(await sessionList());
      return { ...(await projects(roots, sessions)), folders: folders(sessions), locked: lockedFolders() };
    })(),
  };
  shared = mine;
  mine.value.then(() => (mine.done = Date.now()), () => shared === mine && (shared = undefined));
  return mine.value;
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api/
  // ids only follow these collection names: /sessions/<name>/tabs, /tabs/<id>, /jobs/<id>
  const route = `${req.method} /${parts.map((p, i) => (i % 2 && ['sessions', 'tabs', 'jobs', 'groups'].includes(parts[i - 1]) ? ':' : p)).join('/')}`;
  const q = (k: string) => url.searchParams.get(k) || '';
  const settings = loadSettings();

  switch (route) {
    // ----- sessions & tabs -----
    case 'GET /sessions':
      return send(res, 200, await withAgents(await sessionList()));

    case 'GET /projects':
      return send(res, 200, await projectsShared(settings.roots));

    case 'POST /sessions': {
      const b = await body(req);
      let path: string;
      let branch = '';
      if (b.worktree) {
        const repo = await repoAt(folderArg(b.worktree.repo));
        if (!repo) throw new HttpError(400, 'not a git repository');
        branch = String(b.worktree.branch || '').trim();
        if (!branch || (await capture('git', ['check-ref-format', '--branch', branch], { cwd: repo.main })).code !== 0) throw new HttpError(400, `not a valid branch name: "${branch}"`);
        // its databases: a copy of another checkout's, or that checkout's shared (none: fresh ones)
        const from = b.worktree.db?.from ? real(folderArg(b.worktree.db.from)) : '';
        if (from && !(await worktrees(repo.main)).some((w) => w.path === from)) throw new HttpError(400, `not a checkout of ${repo.main}: ${from}`);
        const wt = await addWorktree(repo.main, branch, String(b.worktree.base || '') || undefined, () => {});
        path = wt.path;
        forgetStats(path); // a list refresh during checkout saw a half-written tree
        updateState(path, { branch, ...(wt.base ? { base: wt.base } : {}), ...(from && !wt.existed ? { db: { from, share: !!b.worktree.db.share } } : {}) });
      } else path = real(folderArg(b.path || homedir()));

      // sessions are independent: any number can share a folder
      const existing = new Set((await listSessions()).map((s) => s.name));
      const base = safeName(String(b.name || '')) || safeName(branch.split('/').pop() || '') || (path === homedir() ? 'terminal' : safeName(path.split('/').pop() || '')) || 'session';
      let name = base;
      for (let i = 2; existing.has(name); i++) name = `${base}-${i}`;
      const folder = cleanFolder(b.folder);
      if (folder) addFolder(folder);
      await createSession(name, path, folder);

      let jobId: string | undefined;
      if ((b.setup || b.start) && (await repoAt(path))?.tooljet) jobId = (await envJob(path, { setup: !!b.setup, start: !!b.start })).id;
      return send(res, 201, { name, path, jobId });
    }

    case 'PATCH /sessions/:': {
      const to = safeName(String((await body(req)).name || ''));
      if (!to) throw new HttpError(400, 'name needed (letters, digits, - and _)');
      if ((await listSessions()).some((s) => s.name === to)) throw new HttpError(409, `a session called "${to}" already exists`);
      await renameSession(parts[1], to);
      return send(res, 200, { name: to });
    }

    // run a session in another folder or worktree (see moveSession)
    case 'PUT /sessions/:/path': {
      const path = real(folderArg((await body(req)).path));
      const s = (await listSessions()).find((x) => x.name === parts[1]);
      if (!s) throw new HttpError(404, 'no such session');
      const moved = s.path === path || (await moveSession(s, path));
      return send(res, 200, { path, moved });
    }

    // move a session into a folder ('' = top level); `order` is that folder's sessions in their new order
    case 'PUT /sessions/:/place': {
      const b = await body(req);
      const folder = cleanFolder(b.folder);
      const names = new Set((await listSessions()).map((s) => s.name));
      if (!names.has(parts[1])) throw new HttpError(404, 'no such session');
      if (folder) addFolder(folder);
      await setFolder(parts[1], folder);
      if (Array.isArray(b.order)) await orderSessions(b.order.map(String).filter((n: string) => names.has(n)));
      return send(res, 200, { ok: true });
    }

    // ----- sidebar folders -----
    case 'POST /groups': {
      const name = cleanFolder((await body(req)).name);
      if (!name) throw new HttpError(400, 'folder name needed');
      addFolder(name);
      return send(res, 201, { name });
    }

    case 'PUT /groups':
      orderFolders((await body(req)).names || []);
      return send(res, 200, { ok: true });

    case 'PATCH /groups/:': {
      const to = cleanFolder((await body(req)).name);
      if (!to) throw new HttpError(400, 'folder name needed');
      await renameFolder(parts[1], to).catch((e) => { throw new HttpError(409, e.message); });
      return send(res, 200, { name: to });
    }

    case 'PUT /groups/:/lock':
      try {
        lockFolder(parts[1], !!(await body(req)).locked);
      } catch (e) {
        throw new HttpError(404, (e as Error).message);
      }
      shared = undefined;
      return send(res, 200, { ok: true });

    // deleting a folder ends the sessions in it (their terminals close; servers keep running)
    case 'DELETE /groups/:':
      if (isLocked(parts[1])) throw new HttpError(423, `the folder "${parts[1]}" is locked: unlock it to delete it`);
      for (const s of await listSessions()) if (s.folder === parts[1]) await killSession(s.name, `folder "${parts[1]}" deleted`);
      await removeFolder(parts[1]);
      return send(res, 200, { ok: true });

    case 'DELETE /sessions/:': {
      const s = (await listSessions()).find((x) => x.name === parts[1]);
      if (s && isLocked(s.folder)) throw new HttpError(423, `"${s.name}" is in the locked folder "${s.folder}": unlock it to end the session`);
      await killSession(parts[1], `ended from ${req.headers['user-agent']?.includes('Mobile') ? 'the phone' : 'the browser'}`);
      return send(res, 200, { ok: true });
    }

    // A session's text (its history and screen), to select and copy on the phone, where the terminal's canvas can't be
    // selected. Wrapped lines are joined back, so the phone wraps them to its own width.
    case 'GET /sessions/:/text': {
      const s = (await listSessions()).find((x) => x.name === parts[1]);
      if (!s?.tabs[0]) throw new HttpError(404, 'no such session');
      const lines = Math.min(Math.max(Number(q('lines')) || 1000, 50), 5000);
      const text = await tmux('capture-pane', '-p', '-J', '-S', String(-lines), '-t', s.tabs[0].id);
      return send(res, 200, { text: text.replace(/\s+$/, '') });
    }

    case 'POST /tabs/:/reply': {
      if (!/^@\d+$/.test(parts[1])) throw new HttpError(400, 'bad tab id');
      const key = String((await body(req)).key || '');
      if (!/^(\d|Escape)$/.test(key)) throw new HttpError(400, 'reply with an option number or Escape');
      await reply(parts[1], key);
      return send(res, 200, { ok: true });
    }

    // A file dropped or pasted on a terminal: saved on the Mac, and the terminal gets its path.
    case 'POST /upload':
      return send(res, 200, { path: await saveUpload(req, q('name')) });

    // Claude subscriptions' 5-hour and weekly usage, once connected to their status line (see claude.ts)
    case 'GET /claude/usage':
      return send(res, 200, claudeAccounts());

    // the same, pushed (server-sent events): now, then whenever Claude saves new numbers
    case 'GET /claude/usage/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const push = () => res.write(`data: ${JSON.stringify(claudeAccounts())}\n\n`);
      push();
      req.on('close', onUsageChange(push));
      return;
    }

    case 'POST /claude/connect':
    case 'POST /claude/disconnect': {
      const account = String((await body(req)).account || '');
      try {
        setUsage(account, parts[1] === 'connect');
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return send(res, 200, claudeAccounts());
    }

    case 'GET /host':
      return send(res, 200, await hostStats());

    case 'POST /update/check':
      await checkNow();
      return send(res, 200, updateInfo());

    case 'POST /update':
      try {
        runUpdate();
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return send(res, 202, { ok: true });

    case 'GET /folders':
      return send(res, 200, await openable(settings.roots));

    // a folder's subfolders, to pick any folder for a session (hidden ones and node_modules left out)
    case 'GET /dirs': {
      const path = real(folderArg(q('path') || homedir()));
      let entries;
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch (e) {
        throw new HttpError(400, `can't open ${path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
      }
      const isDir = (name: string) => statSync(join(path, name), { throwIfNoEntry: false })?.isDirectory() ?? false;
      const dirs = entries
        .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules' && (d.isDirectory() || (d.isSymbolicLink() && isDir(d.name))))
        .map((d) => ({ name: d.name, path: join(path, d.name), git: existsSync(join(path, d.name, '.git')) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, 1000);
      return send(res, 200, { path, parent: dirname(path) === path ? null : dirname(path), dirs });
    }

    case 'GET /repos': {
      const { repos } = await discover(settings.roots);
      return send(res, 200, await Promise.all(repos.map(async (path) => ({ path, name: path.split('/').pop(), tooljet: !!(await repoAt(path))?.tooljet }))));
    }

    case 'GET /branches':
      return send(res, 200, await recentBranches(folderArg(q('path'))));

    // ----- dev environment -----
    case 'GET /env': {
      const repo = await repoAtCached(folderArg(q('path')));
      if (!repo?.tooljet) return send(res, 200, { tooljet: false });
      return send(res, 200, await envStatus(repo));
    }

    case 'GET /env/details':
      return send(res, 200, await envDetails(await tooljetAt(q('path'))));

    case 'POST /env/setup': {
      const b = await body(req);
      return send(res, 202, await envJob(b.path, { setup: true, start: !!b.start }));
    }

    case 'POST /env/start':
      return send(res, 202, await envJob((await body(req)).path, { start: true }));

    case 'POST /env/stop': {
      const repo = await tooljetAt((await body(req)).path);
      return send(res, 202, startJob(repo.root, 'Stop servers', STOP_STEPS, (ctx) => stop(ctx, repo)));
    }

    case 'POST /env/restart': {
      const repo = await tooljetAt((await body(req)).path);
      return send(res, 202, startJob(repo.root, 'Restart servers', [...STOP_STEPS.map(([id, l]): [string, string] => [`stop-${id}`, l]), ...START_STEPS], async (ctx) => {
        await stop({ ...ctx, step: (id, fn) => ctx.step(`stop-${id}`, fn), detail: (id, d) => ctx.detail(`stop-${id}`, d) }, repo);
        await start(ctx, repo);
      }));
    }

    case 'POST /env/license': {
      const repo = await tooljetAt((await body(req)).path);
      if (!settings.license) throw new HttpError(400, 'no license key in Settings');
      if (!isConfigured(repo) || !(await listening(ports(repo.root).server))) throw new HttpError(400, 'start the server first');
      return send(res, 202, startJob(repo.root, 'Apply license', [['license', 'Apply license']], (ctx) => ctx.step('license', () => applyLicense(ctx, repo, settings.license))));
    }

    case 'GET /env/log': {
      const repo = await tooljetAt(q('path'));
      const name = ['server', 'frontend', 'setup'].includes(q('name')) ? q('name') : 'server';
      // servers started by tj log under the worktree's .tj/logs
      const own = logFile(repo.root, name);
      const tjLog = join(repo.root, '.tj', 'logs', `${name}.log`);
      const runs = pastRuns(repo.root, name);
      const run = runs.find((r) => r.id === q('run'));
      const file = run ? logFile(repo.root, `${name}.${run.id}`) : existsSync(own) || !existsSync(tjLog) ? own : tjLog;
      const updated = existsSync(file) ? statSync(file).mtimeMs : 0;
      return send(res, 200, { name, file, updated, runs, text: stripAnsi(tail(file, Math.min(Number(q('lines')) || 200, 2000))) });
    }

    case 'POST /worktrees/remove': {
      const b = await body(req);
      const repo = await repoAt(folderArg(b.path));
      if (!repo?.isWorktree) throw new HttpError(400, 'not a worktree (the main checkout is never removed)');
      // removing it ends the sessions in it
      const inside = (await listSessions()).filter((s) => s.path === repo.root || s.path.startsWith(repo.root + '/'));
      const held = inside.find((s) => isLocked(s.folder));
      if (held) throw new HttpError(423, `"${held.name}" runs here and is in the locked folder "${held.folder}": unlock it to remove the worktree`);
      const job = startJob(repo.root, 'Remove worktree', REMOVE_STEPS, async (ctx) => {
        await removeWorktree(ctx, repo, !!b.discard);
        for (const s of await listSessions()) if (s.path === repo.root || s.path.startsWith(repo.root + '/')) await killSession(s.name, `worktree ${repo.root} removed`);
      });
      return send(res, 202, job);
    }

    case 'GET /jobs/:': {
      const job = getJob(parts[1]);
      if (!job) throw new HttpError(404, 'no such job');
      return send(res, 200, job);
    }

    // ----- diff, workspace, tools -----
    case 'GET /diff': {
      const repo = await repoAt(folderArg(q('path')));
      if (!repo) throw new HttpError(400, 'not a git checkout');
      refreshStats(repo.root);
      const mode = q('mode') === 'branch' ? 'branch' : 'uncommitted';
      const base = q('base') || (mode === 'branch' ? await branchBase(repo, real(repo.main)) : undefined);
      return send(res, 200, await diff(repo.root, mode, base));
    }

    // ⟳ in the header: PRs from GitHub, change counts from git, then the page asks for the list again.
    // With a path: just that checkout (it was opened), its PR and its change count.
    case 'POST /refresh': {
      const b = await body(req);
      if (!b.path) await Promise.all([refreshPrs(), refreshAllStats(), checkNow()]);
      else {
        const repo = await repoAt(folderArg(b.path));
        if (repo) {
          refreshStats(repo.root);
          await refreshPr(real(repo.main), repo.branch);
        }
      }
      return send(res, 200, { ok: true });
    }

    case 'GET /tools':
      return send(res, 200, await tools());

    // ----- editors -----
    case 'POST /open/vscode': {
      const path = folderArg((await body(req)).path);
      const r = await capture('code', [path], { cwd: path, env: cleanEnv() });
      if (r.code !== 0) throw new HttpError(400, 'VS Code CLI not found', 'in VS Code: Command Palette → "Shell Command: Install code command in PATH"');
      return send(res, 200, { ok: true });
    }

    case 'GET /code':
      return send(res, 200, await codeStatus());

    case 'POST /code/theme':
      setCodeTheme(!!(await body(req)).dark);
      return send(res, 200, { ok: true });

    case 'POST /code/start':
      return send(res, 200, await startCodeServer());

    case 'POST /code/install': {
      const s = await codeStatus();
      if (s.installed) return send(res, 200, s);
      if (!s.brew) throw new HttpError(400, 'Homebrew not found', 'install code-server yourself: https://coder.com/docs/code-server/install');
      return send(res, 202, startJob('code-server', 'Install code-server', [['install', 'brew install code-server']], (ctx) =>
        ctx.step('install', () => run('brew install code-server', 'brew', ['install', 'code-server'], { cwd: homedir(), env: cleanEnv(), log: logFile('code-server', 'install'), onLine: ctx.log })),
      ));
    }

    // code-server crashing at start (its Homebrew node was left behind by a library upgrade): upgrade both, then the
    // running one is stopped so the next open starts it afresh
    case 'POST /code/repair': {
      const s = await codeStatus();
      if (!s.brew) throw new HttpError(400, 'Homebrew not found');
      const formulas = [s.node, 'code-server'].filter(Boolean);
      const opts = { cwd: homedir(), env: cleanEnv(), log: logFile('code-server', 'repair') };
      return send(res, 202, startJob('code-server', 'Repair code-server', [['update', 'brew update'], ['upgrade', `brew upgrade ${formulas.join(' ')}`], ['restart', 'Restart code-server']], async (ctx) => {
        await ctx.step('update', () => run('brew update', 'brew', ['update'], { ...opts, onLine: ctx.log }));
        await ctx.step('upgrade', () => run('brew upgrade', 'brew', ['upgrade', ...formulas], { ...opts, onLine: ctx.log }));
        await ctx.step('restart', async () => {
          await stopCodeServer();
          const after = await codeStatus();
          if (after.broken) throw new CmdError(`code-server still can't start: ${after.broken}`, `try: brew reinstall ${formulas.join(' ')}`);
        });
      }));
    }

    // ----- tailscale & settings -----
    case 'GET /tailscale':
      return send(res, 200, await tailscaleStatus(PORT));

    case 'POST /tailscale/share':
      return send(res, 200, await shareOnTailnet(PORT));

    case 'GET /settings':
      return send(res, 200, { ...settings, license: settings.license ? `••••${settings.license.slice(-4)}` : '', rootsReport: (await discover(settings.roots)).report });

    // First run, the two things devdeck needs from you: a projects folder (in Settings) that holds a repo, and gh
    // installed and signed in to GitHub, for pull requests (optional).
    case 'GET /setup': {
      const { report } = await discover(settings.roots);
      const gh = await capture('gh', ['auth', 'status', '--hostname', 'github.com'], { cwd: '/', env: cleanEnv() });
      return send(res, 200, {
        projects: { roots: settings.roots, repos: report.reduce((n, r) => n + (r.found ? r.repos : 0), 0) },
        github: { installed: gh.code !== 127, signedIn: gh.code === 0 },
      });
    }

    case 'PUT /settings': {
      const next = await body(req);
      saveSettings({
        roots: Array.isArray(next.roots) ? next.roots.map(String).filter(Boolean) : settings.roots,
        // the masked value comes back unchanged when the user didn't touch the field
        license: typeof next.license === 'string' && !next.license.startsWith('••••') ? next.license.trim() : settings.license,
        login: { ...settings.login, ...(next.login ?? {}) },
      });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, `no route ${route}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  try {
    const why = refused(req);
    if (why) throw new HttpError(403, why);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') shared = undefined; // a change: the next list is worked out afresh
      return await api(req, res, url);
    }
    if (url.pathname === '/code' || url.pathname.startsWith('/code/')) {
      if (url.pathname === '/code') return res.writeHead(302, { Location: '/code/' + url.search }).end();
      return proxyHttp(req, res);
    }
    if (url.pathname.startsWith('/vendor/')) {
      const v = VENDOR[url.pathname.slice('/vendor/'.length)];
      return v ? serveFile(req, res, join(ROOT, v)) : send(res, 404, { error: 'not found' });
    }
    const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'forbidden');
    return serveFile(req, res, file);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof CmdError ? 400 : e instanceof SyntaxError ? 400 : 500;
    const hint = e instanceof HttpError || e instanceof CmdError ? e.hint : undefined;
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e), hint });
  }
});

// One WebSocket = one terminal view. It attaches a throwaway viewer session grouped with the real one,
// so the phone and the laptop can look at different tabs of the same session at once.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  if (refused(req)) return socket.destroy();
  if (url.pathname.startsWith('/code/')) return proxyUpgrade(req, socket, head);
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

// Input comes numbered per browser terminal ({ id, seq }) and is confirmed with a binary frame (terminal output is
// text); a piece re-sent after a reconnect is written only once.
const written = new Map<string, number>();

wss.on('connection', async (ws, url: URL) => {
  // listen at once: what's typed while the session is looked up (a reconnecting phone flushes its queue right away)
  // would otherwise be lost; it's handled once the terminal is up
  const early: unknown[] = [];
  let onMessage = (raw: unknown) => void early.push(raw);
  ws.on('message', (raw) => onMessage(raw));
  const session = url.searchParams.get('session') || '';
  const index = url.searchParams.get('window') || '';
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  if (!(await listSessions()).some((s) => s.name === session)) return ws.close(4404, 'no such session');

  const viewer = `${session}${VIEWER_SEP}${Math.random().toString(36).slice(2, 8)}`;
  const args = ['new-session', '-t', session, '-s', viewer, ';', 'set-option', 'destroy-unattached', 'on'];
  if (/^\d+$/.test(index)) args.push(';', 'select-window', '-t', `${viewer}:${index}`);
  const term = pty.spawn('tmux', tmuxArgs(...args), { name: 'xterm-256color', cols, rows, cwd: homedir(), env: cleanEnv() });

  // A slow link (a phone on mobile data) can't take output as fast as a program makes it: past 1 MB waiting to go out,
  // the terminal is paused (the program then waits, as it would on a slow ssh) until the backlog is down to 256 KB.
  let paused = false;
  term.onData((d) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(d);
    if (paused || ws.bufferedAmount < 1 << 20) return;
    paused = true;
    term.pause();
    const drained = setInterval(() => {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount > 1 << 18) return;
      clearInterval(drained);
      paused = false;
      term.resume();
    }, 50);
  });
  term.onExit(() => ws.close());

  // Touch scrolling, by the line (n > 0 = towards now): tmux's history through copy mode, which a scroll back to the
  // bottom leaves. A full-screen app that takes the mouse (Claude's, less) gets wheel reports instead, one per 3 lines,
  // the way tmux passes a mouse wheel on. One at a time; lines that arrive meanwhile are merged.
  let lines = 0;
  let wheelRest = 0;
  let at = '1;1';
  // Scrolls and input go through one queue, in the order they came. Scrolled back into the history (tmux copy mode),
  // anything typed would be taken as copy-mode commands and never reach the program, so the first input after a
  // scroll back (a finger drag, or a mouse wheel on the Mac) first returns to the live screen, as a terminal does.
  let queue: Promise<unknown> = Promise.resolve();
  const later = (fn: () => unknown) => void (queue = queue.then(fn).catch(() => {}));
  let scrolledBack = false;
  const MOUSE = /^\x1b\[(<|M)/; // clicks and drags select in copy mode: those stay in it
  const type = async (d: string) => {
    if (/\x1b\[<6[45];/.test(d)) scrolledBack = true; // wheel
    else if (scrolledBack && !MOUSE.test(d)) {
      scrolledBack = false;
      if ((await tmux('display-message', '-p', '-t', viewer, '#{pane_in_mode}')).trim() === '1') await tmux('send-keys', '-X', '-t', viewer, 'cancel');
    }
    term.write(d);
  };
  const scroll = async () => {
    const n = lines;
    lines = 0;
    if (!n) return;
    const [alt, mouse, inMode] = (await tmux('display-message', '-p', '-t', viewer, '#{alternate_on} #{mouse_any_flag} #{pane_in_mode}')).trim().split(' ');
    if (inMode !== '1' && (alt === '1' || mouse === '1')) {
      wheelRest += n;
      const k = Math.trunc(wheelRest / 3);
      wheelRest -= k * 3;
      if (k) term.write(`\x1b[<${k > 0 ? 65 : 64};${at}M`.repeat(Math.abs(k)));
    } else if (n < 0) {
      scrolledBack = true;
      await tmux('copy-mode', '-e', '-t', viewer, ';', 'send-keys', '-X', '-t', viewer, '-N', String(-n), 'scroll-up');
    }
    else if (inMode === '1') await tmux('send-keys', '-X', '-t', viewer, '-N', String(n), 'scroll-down');
  };
  // Search: tmux's own copy-mode search, so it covers the whole history (the browser terminal only holds the screen)
  // and tmux highlights the matches. A new word searches up from the bottom; up / down step through the matches; end
  // goes back to the live screen. The reply says how many there are.
  let lastDir = 'up';
  const find = async (q: string, dir: string) => {
    const inMode = (await tmux('display-message', '-p', '-t', viewer, '#{pane_in_mode}')).trim() === '1';
    if (dir === 'end') {
      if (inMode) await tmux('send-keys', '-X', '-t', viewer, 'cancel');
      scrolledBack = false;
      return;
    }
    if (!q) return;
    scrolledBack = true;
    if (dir === 'new' || !inMode) {
      await tmux('copy-mode', '-t', viewer, ';', 'send-keys', '-X', '-t', viewer, 'history-bottom', ';', 'send-keys', '-X', '-t', viewer, 'end-of-line', ';', 'send-keys', '-X', '-t', viewer, 'search-backward-text', q);
      lastDir = 'up';
    } else {
      // tmux leaves the cursor on a match's start going up and on its end going down, so the first step the other way
      // finds the same match again: turning around takes two
      const steps = dir === lastDir ? '1' : '2';
      await tmux('send-keys', '-X', '-N', steps, '-t', viewer, dir === 'up' ? 'search-backward-text' : 'search-forward-text', q);
      lastDir = dir;
    }
    const [count, partial] = (await tmux('display-message', '-p', '-t', viewer, '#{search_count} #{search_count_partial}')).trim().split(' ');
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(JSON.stringify({ found: Number(count) || 0, more: partial === '1' })));
  };
  // Split panes are tmux's, so every device sees the same layout and a border drag resizes them. Split, the window
  // gets a header line over each pane (tmux's pane-border-status); the browser draws a pane's title and buttons on it.
  // A pane's own buttons act on that pane; closing one that runs something (Claude, a server) asks first.
  const pane = async (m: { do?: string; pane?: string; force?: boolean }) => {
    const ids = (await tmux('list-panes', '-t', viewer, '-F', '#{pane_id}')).split('\n').filter(Boolean);
    const target = m.pane && ids.includes(m.pane) ? m.pane : viewer; // only this window's panes
    if (m.do === 'right' || m.do === 'down') await tmux('split-window', m.do === 'right' ? '-h' : '-v', '-t', target, '-c', '#{pane_current_path}');
    else if (m.do === 'focus') await tmux('select-pane', '-t', target);
    else if (m.do === 'close' && ids.length > 1) {
      const busy = m.force ? '' : await paneProgram(target);
      if (busy) return ws.readyState === ws.OPEN && ws.send(Buffer.from(JSON.stringify({ busy, pane: target })));
      await tmux('kill-pane', '-t', target);
    }
    await layout();
  };
  // The panes' places on the grid, sent when they change: checked after pane actions and resizes, and at most once a
  // second while output flows (a pane that exits, a border drag, a click to another pane all redraw). Nothing when idle.
  const BORDERS = ['pane-border-lines', 'single', 'pane-border-style', 'fg=colour240', 'pane-active-border-style', 'fg=#6366f1', 'pane-border-format', ''];
  let sentLayout = '';
  const layout = async (): Promise<void> => {
    const out = (await tmux('list-panes', '-t', viewer, '-F', '#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{pane_current_command}\t#{b:pane_current_path}\t#{?#{==:#{pane_title},#{host}},,#{pane_title}}\t#{pane-border-status}')).trim();
    const rows = out.split('\n').map((l) => l.split('\t'));
    const header = rows.length > 1 ? 'top' : 'off';
    if (rows[0]?.[9] !== header) {
      const set = ['set-option', '-w', '-t', viewer, 'pane-border-status', header];
      for (let i = 0; i < BORDERS.length; i += 2) set.push(';', 'set-option', '-w', '-t', viewer, BORDERS[i], BORDERS[i + 1]);
      await tmux(...set);
      return layout(); // the header line moves every pane down a row
    }
    if (out === sentLayout || ws.readyState !== ws.OPEN) return;
    sentLayout = out;
    const panes = rows.length > 1 ? rows.map(([id, x, y, w, h, active, command, dir, title]) => ({ id, x: +x, y: +y, w: +w, h: +h, active: active === '1', command: /^\d+\.\d+\.\d+/.test(command) ? 'claude' : command, dir, title })) : [];
    ws.send(Buffer.from(JSON.stringify({ panes })));
  };
  let layoutTimer: NodeJS.Timeout | undefined;
  let layoutAt = 0;
  const layoutSoon = () => {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = undefined;
      layoutAt = Date.now();
      later(layout);
    }, Math.max(150, 1000 - (Date.now() - layoutAt)));
  };
  term.onData(layoutSoon);
  ws.on('close', () => {
    clearTimeout(layoutTimer);
    term.kill();
  });
  onMessage = (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.t === 'i') {
      const id = typeof m.id === 'string' ? m.id.slice(0, 40) : '';
      const seq = Number(m.seq) || 0;
      if (!id || seq > (written.get(id) ?? 0)) {
        const d = String(m.d || '');
        if (d) later(() => type(d));
        if (id) {
          written.delete(id); // keep the map in recently-used order, and small
          written.set(id, seq);
          if (written.size > 500) written.delete(written.keys().next().value!);
        }
      }
      // confirmed once written (after a scroll back is undone)
      if (id) later(() => ws.readyState === ws.OPEN && ws.send(Buffer.from(JSON.stringify({ ack: seq }))));
    }
    else if (m.t === 'r') {
      term.resize(Math.max(2, Number(m.c) || 80), Math.max(2, Number(m.r) || 24));
      layoutSoon();
    }
    else if (m.t === 'w') tmux('select-window', '-t', `${viewer}:${Number(m.w)}`).catch(() => {});
    else if (m.t === 'f') later(() => find(String(m.q || '').slice(0, 200), String(m.dir)));
    else if (m.t === 'p') later(() => pane({ do: String(m.do), pane: typeof m.pane === 'string' ? m.pane : undefined, force: !!m.force }));
    else if (m.t === 's') {
      lines += Math.max(-500, Math.min(500, Math.trunc(Number(m.n)) || 0));
      at = `${Math.max(1, Math.trunc(Number(m.x)) || 1)};${Math.max(1, Math.trunc(Number(m.y)) || 1)}`;
      later(scroll);
    }
  };
  early.splice(0).forEach(onMessage);
});

await scrubServerEnv();
await passLinks();
tailnetIdentity(); // ask now, so the phone isn't turned away while the first answer is pending
startUpdateChecks();
server.listen(PORT, HOST, () => {
  console.log(`devdeck on http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '127.0.0.1') console.log(`phone: tailscale serve --bg --https=8444 http://localhost:${PORT}`);
});
