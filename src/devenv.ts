// ToolJet dev environment for one checkout: .env, deps, DB, servers, dev login and license.
// Bundled here so it works on any branch, with or without tj/ToolBelt; the steps follow tools/tj.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEnv, writeEnv, type Env } from './envfile.ts';
import type { Ctx } from './jobs.ts';
import { activeJob, lastJob } from './jobs.ts';
import { freePort, listener, listening, reachable, waitHttp } from './net.ts';
import { dbNames, localModule, nvmrc, type Repo, SUBMODULES, unsavedWork, worktrees } from './repo.ts';
import { loadSettings } from './settings.ts';
import { alive, capture, cloneTree, CmdError, deleteInBackground, git, killGroup, killPids, owned, procStart, run, startDetached, tail } from './sh.ts';
import { clearRun, forget, loadRun, loadState, logFile, rotateLog, saveRun, STATE_ROOT, tjPorts, tjRun, updateState } from './state.ts';
import { cleanEnv } from './tmux.ts';

export const SERVICES = ['server', 'frontend'] as const;
export type Svc = (typeof SERVICES)[number];

// ---------- environment for child processes ----------

// npm runs on the Node the checkout's .nvmrc asks for, from nvm when this devdeck runs another one.
function nodeBin(root: string) {
  const want = nvmrc(root);
  if (!want || process.version === want) return dirname(process.execPath);
  const bin = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node', want, 'bin');
  if (existsSync(join(bin, 'node'))) return bin;
  throw new CmdError(`Node ${want} (from .nvmrc) is not installed`, `nvm install ${want}`);
}

function childEnv(root: string, extra: Env = {}): NodeJS.ProcessEnv {
  const env = cleanEnv();
  return { ...env, PATH: `${nodeBin(root)}:${env.PATH}`, ...extra };
}

// ---------- reading a checkout ----------

const mainEnv = (repo: Repo) => readEnv(join(repo.main, '.env'));
const ownEnv = (repo: Repo) => readEnv(join(repo.root, '.env'));

export function ports(root: string) {
  const env = readEnv(join(root, '.env'));
  let frontend = 8082;
  try {
    if (env.TOOLJET_HOST) frontend = Number(new URL(env.TOOLJET_HOST).port) || 8082;
  } catch {
    /* malformed TOOLJET_HOST: default */
  }
  return { server: Number(env.PORT || 3000), frontend };
}

function pgArgs(env: Env, prefix: 'PG' | 'TOOLJET_DB') {
  const get = (k: string, alt?: string) => env[`${prefix}_${k}`] || (alt && env[`${prefix}_${alt}`]) || env[`PG_${k}`] || undefined;
  return {
    args: ['-h', get('HOST') ?? 'localhost', '-p', get('PORT') ?? '5432', '-U', get('USER') ?? 'postgres'],
    password: get('PASS', 'PASSWORD') ?? '',
  };
}

async function psql(env: Env, db: string, sql: string) {
  const { args, password } = pgArgs(env, 'PG');
  const r = await capture('psql', [...args, '-d', db, '-AXqt', '-F', '\t', '-c', sql], { cwd: '/', env: { ...cleanEnv(), PGPASSWORD: password } });
  if (r.code !== 0) throw new CmdError(`psql: ${r.err}`);
  return r.out ? r.out.split('\n').map((l) => l.split('\t')) : [];
}

// Whether a dev DB exists, for the env status (polled): remembered for a minute, and asked afresh while a job
// (setup, remove) may be creating or dropping it.
const dbSeen = new Map<string, { at: number; value: boolean }>();
async function dbExistsCached(env: Env, name: string | undefined, busy: boolean) {
  const key = name ?? '';
  const c = dbSeen.get(key);
  if (busy) dbSeen.delete(key);
  else if (c && Date.now() - c.at < 60_000) return c.value;
  const value = await dbExists(env, name);
  if (!busy) dbSeen.set(key, { at: Date.now(), value });
  return value;
}

async function dbExists(env: Env, name: string | undefined) {
  if (!name) return false;
  try {
    return (await psql(env, 'postgres', `select 1 from pg_database where datname = '${name.replace(/'/g, "''")}'`)).length > 0;
  } catch {
    return false;
  }
}

// `npm run build` in plugins/ writes dist/ plus two generated (gitignored) entry files the frontend and server import.
const PLUGIN_ENTRIES = ['client.js', 'server.ts'];
const pluginsBuilt = (plugins: string) => ['dist', ...PLUGIN_ENTRIES].every((x) => existsSync(join(plugins, x)));

const depsReady = (root: string) =>
  ['server', 'frontend', 'plugins'].every((d) => existsSync(join(root, d, 'node_modules'))) && pluginsBuilt(join(root, 'plugins'));

async function serviceState(repo: Repo, svc: Svc) {
  const port = ports(repo.root)[svc];
  const url = `http://localhost:${port}`;
  const mine = loadRun(repo.root, svc);
  if (await owned(mine)) return { state: 'running' as const, port, url, pid: mine!.pid, by: 'devdeck' };
  if (!(await listening(port))) {
    // still starting: process alive but the port isn't open yet
    if (mine && alive(mine.pid)) return { state: 'starting' as const, port, url, pid: mine.pid, by: 'devdeck' };
    return { state: 'stopped' as const, port, url };
  }
  const tj = tjRun(repo.root, svc);
  if (await owned(tj)) return { state: 'running' as const, port, url, pid: tj!.pid, by: 'tj' };
  const l = await listener(port);
  if (l?.cwd && (l.cwd === repo.root || l.cwd.startsWith(repo.root + '/'))) return { state: 'running' as const, port, url, pid: l.pid, by: 'terminal' };
  return { state: 'busy' as const, port, url, pid: l?.pid, by: l?.cwd || 'another process' };
}

// Has this checkout got its own .env? An unset worktree would otherwise fall back to the default
// ports (3000/8082), which belong to the main checkout.
export function isConfigured(repo: Repo) {
  const env = ownEnv(repo);
  return existsSync(join(repo.root, '.env')) && (!repo.isWorktree || (env.PG_DB !== undefined && env.PG_DB !== mainEnv(repo).PG_DB && !!env.PORT));
}

export type EnvStatus = Awaited<ReturnType<typeof envStatus>>;

export async function envStatus(repo: Repo) {
  const settings = loadSettings();
  const env = ownEnv(repo);
  const configured = isConfigured(repo);
  const db = configured ? await dbExistsCached(env, env.PG_DB, !!activeJob(repo.root)) : false;
  const deps = depsReady(repo.root);
  // an unset worktree has no ports of its own yet (the defaults belong to the main checkout)
  const none = (svc: Svc) => ({ state: 'none' as const, port: 0, url: '' , svc });
  const [server, frontend] = configured ? await Promise.all(SERVICES.map((s) => serviceState(repo, s))) : SERVICES.map(none);
  const state = loadState(repo.root);
  const job = activeJob(repo.root) || lastJob(repo.root);
  return {
    tooljet: true,
    root: repo.root,
    branch: repo.branch,
    isWorktree: repo.isWorktree,
    edition: (env.TOOLJET_EDITION || mainEnv(repo).TOOLJET_EDITION || 'ce').toLowerCase(),
    configured,
    deps,
    db: configured ? env.PG_DB : undefined,
    dbExists: db,
    ready: configured && deps && db,
    services: { server, frontend },
    running: server.state === 'running' && frontend.state === 'running',
    login: { email: settings.login.email, password: settings.login.password },
    org: state.org,
    licenseKeySet: !!settings.license,
    licensed: state.licensed,
    job: job && { id: job.id, title: job.title, status: job.status },
  };
}

// ---------- set up ----------

async function preflight(repo: Repo) {
  nodeBin(repo.root); // throws with an nvm hint
  if (!existsSync(join(repo.main, '.env')))
    throw new CmdError(`no .env in ${repo.main}`, 'copy .env.example to .env in the main checkout and fill in Postgres/Redis');
  const env = { ...mainEnv(repo), ...ownEnv(repo) };
  const checks = [
    { name: 'Postgres', host: env.PG_HOST || 'localhost', port: Number(env.PG_PORT || 5432), hint: 'start Postgres (Postgres.app or brew services start postgresql)' },
    { name: 'Redis', host: env.REDIS_HOST || 'localhost', port: Number(env.REDIS_PORT || 6379), hint: 'start Redis: brew services start redis' },
  ];
  for (const c of checks) if (!(await reachable(c.host, c.port))) throw new CmdError(`${c.name} not reachable at ${c.host}:${c.port}`, c.hint);
}

async function syncSubmodules(ctx: Ctx, repo: Repo) {
  for (const sm of SUBMODULES) {
    const local = localModule(repo.main, sm);
    if (!local) {
      ctx.log(`${sm}: not available (no EE access?), skipping`);
      continue;
    }
    // Worktrees clone from the main checkout's module repo so unpushed EE branches are visible.
    const url = repo.isWorktree ? ['-c', 'protocol.file.allow=always', '-c', `submodule.${sm}.url=${local}`] : [];
    await git(repo.root, ...url, 'submodule', 'update', '--init', sm);
    const remote = await capture('git', ['rev-parse', '-q', '--verify', `origin/${repo.branch}`], { cwd: join(repo.root, sm) });
    if (repo.isWorktree && repo.branch && remote.code === 0) {
      const has = await capture('git', ['rev-parse', '-q', '--verify', `refs/heads/${repo.branch}`], { cwd: join(repo.root, sm) });
      await git(join(repo.root, sm), 'checkout', '-q', ...(has.code === 0 ? [repo.branch] : ['-b', repo.branch, `origin/${repo.branch}`]));
      ctx.log(`${sm} on ${repo.branch}`);
    } else ctx.log(`${sm} at pinned commit`);
  }
}

async function takenPorts(main: string, self: string) {
  const taken = new Set([3000, 8082]);
  for (const w of await worktrees(main)) {
    if (w.path === self) continue;
    for (const p of [loadState(w.path).ports, tjPorts(w.path), existsSync(join(w.path, '.env')) ? ports(w.path) : undefined])
      for (const n of [p?.server, p?.frontend]) if (n) taken.add(n);
  }
  return taken;
}

async function writeWorktreeEnv(ctx: Ctx, repo: Repo) {
  const file = join(repo.root, '.env');
  const own = ownEnv(repo);
  const names = dbNames(repo.branch || 'detached');
  if (existsSync(file) && own.PG_DB && own.PG_DB !== mainEnv(repo).PG_DB && own.PORT) {
    ctx.log(`.env already set: ${own.PG_DB}, server :${own.PORT}`);
    updateState(repo.root, { ports: ports(repo.root), dbs: { dev: own.PG_DB, tjdbDev: own.TOOLJET_DB } });
    return;
  }
  const taken = await takenPorts(repo.main, repo.root);
  const prev = loadState(repo.root).ports ?? tjPorts(repo.root);
  const server = prev?.server ?? (await freePort(3010, taken));
  taken.add(server);
  const frontend = prev?.frontend ?? (await freePort(8092, taken));
  const base = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync(join(repo.main, '.env'), 'utf8');
  writeEnv(file, base, {
    PG_DB: names.dev,
    TOOLJET_DB: names.tjdbDev,
    PORT: String(server),
    TOOLJET_SERVER_PORT: String(server),
    TOOLJET_HOST: `http://localhost:${frontend}`,
  });
  updateState(repo.root, { ports: { server, frontend }, dbs: { dev: names.dev, tjdbDev: names.tjdbDev } });
  ctx.log(`.env → DB ${names.dev}, server :${server}, frontend :${frontend}`);
}

const lockHash = (dir: string) => createHash('sha1').update(readFileSync(join(dir, 'package-lock.json'))).digest('hex');

type Lock = { packages?: Record<string, { version?: string; optional?: boolean; peer?: boolean }> };
const readLock = (file: string): Lock | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

// npm's hidden lockfile (node_modules/.package-lock.json) lists what is on disk. Every installed
// entry must match the lock, and every locked entry must be installed unless optional.
function installedFrom(lock: Lock, hidden: Lock) {
  const want = lock.packages ?? {};
  const have = hidden.packages ?? {};
  for (const [k, v] of Object.entries(have)) if (want[k]?.version !== v.version) return false;
  return Object.entries(want).every(([k, v]) => k in have || !k.includes('node_modules/') || v.optional || v.peer);
}

// Workspace packages keep their own node_modules (e.g. plugins/packages/<x>/node_modules).
const nestedModules = (hidden: Lock) =>
  [...new Set(Object.keys(hidden.packages ?? {}).map((k) => /^(?!node_modules\/)(.+?\/node_modules)\//.exec(k)?.[1]))].filter((x): x is string => !!x);

// Copy-on-write (APFS clonefile): near-instant, and the copies never share writes. The whole folder in one call
// when possible (cloneTree), else file by file with cp.
async function cloneDir(repo: Repo, from: string, to: string, onLine: (l: string) => void) {
  if (await cloneTree(from, to)) return appendFileSync(logFile(repo.root, 'setup'), `\ncloned ${from} -> ${to}\n`);
  return run(`copy ${to}`, 'cp', process.platform === 'darwin' ? ['-cR', from, to] : ['-R', '--reflink=auto', from, to], { cwd: repo.root, log: logFile(repo.root, 'setup'), onLine });
}

const depsOf = (path: string) => ({ ...readTjDeps(path), ...loadState(path).deps });
function readTjDeps(path: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(path, '.tj', 'state.json'), 'utf8')).deps ?? {};
  } catch {
    return {};
  }
}

async function reuseModules(repo: Repo, d: string, dir: string, onLine: (l: string) => void) {
  const lock = readLock(join(dir, 'package-lock.json'));
  if (!lock || existsSync(join(dir, 'node_modules'))) return false;
  for (const w of await worktrees(repo.main)) {
    if (w.path === repo.root) continue;
    const from = d === 'root' ? w.path : join(w.path, d);
    const hidden = readLock(join(from, 'node_modules', '.package-lock.json'));
    if (!hidden || !installedFrom(lock, hidden)) continue;
    try {
      for (const m of ['node_modules', ...nestedModules(hidden)])
        if (existsSync(join(from, m)) && !existsSync(join(dir, m))) await cloneDir(repo, join(from, m), join(dir, m), onLine);
      return from;
    } catch {
      if (existsSync(join(dir, 'node_modules'))) {
        const aside = join(STATE_ROOT, 'trash', `${Date.now()}-modules`);
        mkdirSync(dirname(aside), { recursive: true });
        renameSync(join(dir, 'node_modules'), aside);
        deleteInBackground(aside);
      }
      return false;
    }
  }
  return false;
}

async function installDeps(ctx: Ctx, repo: Repo) {
  const deps: Record<string, string> = { ...loadState(repo.root).deps };
  const dirs = ['root', 'server', 'plugins', 'frontend'];
  await Promise.all(
    dirs.map(async (d) => {
      const dir = d === 'root' ? repo.root : join(repo.root, d);
      if (!existsSync(join(dir, 'package-lock.json'))) return;
      const hash = lockHash(dir);
      const say = (l: string) => ctx.log(`[${d}] ${l}`);
      if (deps[d] === hash && existsSync(join(dir, 'node_modules'))) return say('deps up to date');
      const from = await reuseModules(repo, d, dir, say);
      if (from) say(`deps copied from ${from}`);
      else {
        say('npm ci (first install on this lockfile, takes a few minutes)');
        await run(`${d} npm ci`, 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: dir, env: childEnv(repo.root), log: logFile(repo.root, 'setup'), onLine: say });
      }
      deps[d] = hash;
    }),
  );
  updateState(repo.root, { deps });
}

async function buildPlugins(ctx: Ctx, repo: Repo) {
  const state = loadState(repo.root);
  const hash = (await capture('git', ['rev-parse', 'HEAD:plugins'], { cwd: repo.root })).out;
  const to = join(repo.root, 'plugins');
  if (state.deps?.['plugins:build'] === hash && pluginsBuilt(to)) return ctx.log('plugins: build up to date');
  const say = (l: string) => ctx.log(`[plugins] ${l}`);
  for (const w of await worktrees(repo.main)) {
    const from = join(w.path, 'plugins');
    if (w.path === repo.root || depsOf(w.path)['plugins:build'] !== hash || !pluginsBuilt(from)) continue;
    const dists = ['dist', ...PLUGIN_ENTRIES, ...readdirSync(join(from, 'packages')).map((p) => join('packages', p, 'dist'))].filter((x) => existsSync(join(from, x)) && !existsSync(join(to, x)));
    try {
      await Promise.all(dists.map((x) => cloneDir(repo, join(from, x), join(to, x), say)));
      say(`build copied from ${w.path}`);
      updateState(repo.root, { deps: { ...loadState(repo.root).deps, 'plugins:build': hash } });
      return;
    } catch {
      /* fall through to a real build */
    }
  }
  say('npm run build');
  await run('plugins build', 'npm', ['run', 'build'], { cwd: to, env: childEnv(repo.root), log: logFile(repo.root, 'setup'), onLine: say });
  updateState(repo.root, { deps: { ...loadState(repo.root).deps, 'plugins:build': hash } });
}

async function setupDb(ctx: Ctx, repo: Repo) {
  const say = (l: string) => ctx.log(`[db] ${l}`);
  await run('DB setup', 'npm', ['run', 'db:setup'], { cwd: join(repo.root, 'server'), env: childEnv(repo.root, { NODE_ENV: '' }), log: logFile(repo.root, 'setup'), onLine: say });
}

export const SETUP_STEPS: [string, string][] = [
  ['check', 'Check Node, Postgres, Redis'],
  ['submodules', 'Sync EE submodules'],
  ['env', 'Write .env (ports, database)'],
  ['deps', 'Install dependencies'],
  ['plugins', 'Build plugins'],
  ['db', 'Create & migrate database'],
];

export async function setup(ctx: Ctx, repo: Repo) {
  await ctx.step('check', () => preflight(repo));
  await ctx.step('submodules', () => syncSubmodules(ctx, repo));
  if (repo.isWorktree) await ctx.step('env', () => writeWorktreeEnv(ctx, repo));
  else if (existsSync(join(repo.root, '.env'))) ctx.skip('env', 'main checkout keeps its own .env');
  else throw new CmdError('no .env in the main checkout', 'cp .env.example .env');
  await ctx.step('deps', () => installDeps(ctx, repo));
  await ctx.step('plugins', () => buildPlugins(ctx, repo));
  await ctx.step('db', () => setupDb(ctx, repo));
}

// ---------- start / stop ----------

function spec(svc: Svc, root: string): { cwd: string; args: string[]; port: number; env: Env; health: string } {
  const p = ports(root);
  if (svc === 'server') return { cwd: join(root, 'server'), args: ['run', 'start:dev'], port: p.server, env: { PORT: String(p.server) }, health: `http://localhost:${p.server}/api/health` };
  return { cwd: join(root, 'frontend'), args: ['start', '--', '--port', String(p.frontend)], port: p.frontend, env: { TOOLJET_SERVER_PORT: String(p.server) }, health: `http://localhost:${p.frontend}/` };
}

export const START_STEPS: [string, string][] = [
  ['check', 'Check Node, Postgres, Redis'],
  ['server', 'Start server'],
  ['frontend', 'Start frontend'],
  ['login', 'Create dev login'],
  ['license', 'Apply license'],
];

async function startService(ctx: Ctx, repo: Repo, svc: Svc) {
  if (!isConfigured(repo)) throw new CmdError('this checkout is not set up yet', 'use Set up & start');
  const s = await serviceState(repo, svc);
  if (s.state === 'running') return ctx.detail(svc, `already running :${s.port}`);
  if (s.state === 'busy') throw new CmdError(`port ${s.port} is used by ${s.by}`, `stop it, or free the port: lsof -nP -iTCP:${s.port} -sTCP:LISTEN`);
  const sp = spec(svc, repo.root);
  rotateLog(repo.root, svc);
  const log = logFile(repo.root, svc);
  const pid = startDetached('npm', sp.args, { cwd: sp.cwd, env: childEnv(repo.root, sp.env), log });
  saveRun(repo.root, svc, { pid, procStart: await procStart(pid), port: sp.port, startedAt: new Date().toISOString(), log });
  ctx.log(`${svc} starting on :${sp.port} (pid ${pid}); log: ${log}`);
  const outcome = await waitHttp(sp.health, 8 * 60_000, () => alive(pid));
  if (outcome !== 'ready') {
    if (outcome === 'died') clearRun(repo.root, svc);
    for (const l of tail(log, 15).split('\n')) ctx.log(`[${svc}] ${l}`);
    throw new CmdError(`${svc} ${outcome === 'died' ? 'exited during startup' : 'not healthy after 8 minutes'}`, `see the ${svc} log`);
  }
  ctx.detail(svc, `:${sp.port}`);
}

export async function start(ctx: Ctx, repo: Repo) {
  await ctx.step('check', () => preflight(repo));
  // both in parallel: webpack's first build is the slow part
  await Promise.all(SERVICES.map((svc) => ctx.step(svc, () => startService(ctx, repo, svc))));
  await ctx.step('login', () => onboard(ctx, repo));
  const settings = loadSettings();
  if (!settings.license) ctx.skip('license', 'no license key in Settings');
  else if ((ownEnv(repo).TOOLJET_EDITION || 'ce').toLowerCase() === 'ce') ctx.skip('license', 'CE edition does not use a license');
  else await ctx.step('license', () => applyLicense(ctx, repo, settings.license));
}

export const STOP_STEPS: [string, string][] = [
  ['server', 'Stop server'],
  ['frontend', 'Stop frontend'],
];

// Set up & start in one go: the start's own check reuses the setup's row.
export const SETUP_START_STEPS = [...SETUP_STEPS, ...START_STEPS.filter(([id]) => id !== 'check')];

// Only ever signal a process group whose every member runs inside this checkout, and log each kill.
// Guards against stale pid files, pid reuse or a wrong port ever touching another checkout's servers.
const inside = (root: string, cwd?: string) => !!cwd && (cwd === root || cwd.startsWith(root + '/'));

async function groupMembers(pgid: number) {
  const pids = (await capture('pgrep', ['-g', String(pgid)], { cwd: '/' })).out.split('\n').map(Number).filter(Boolean);
  return Promise.all(
    pids.map(async (pid) => ({
      pid,
      cwd: (await capture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { cwd: '/' })).out.split('\n').find((l) => l.startsWith('n'))?.slice(1),
    })),
  );
}

async function safeKill(ctx: Ctx, root: string, pgid: number, why: string) {
  const members = await groupMembers(pgid);
  const mine = members.filter((m) => inside(root, m.cwd));
  const outside = members.length - mine.length;
  // A whole group only when it's entirely this checkout's; a mixed group (started by hand, shared with a
  // shell or an app) gets just its processes inside the checkout, one by one, like `tj stop` does.
  const mode = !mine.length ? 'skip' : outside ? 'pids' : 'group';
  mkdirSync(STATE_ROOT, { recursive: true });
  appendFileSync(join(STATE_ROOT, 'kills.log'), `${new Date().toISOString()} ${mode} pgid=${pgid} root=${root} why=${why} members=${members.map((m) => `${m.pid}:${m.cwd}`).join(',')}\n`);
  if (mode === 'skip') return false;
  if (mode === 'group') await killGroup(pgid);
  else {
    ctx.log(`process group ${pgid} is shared with ${outside} process(es) outside this checkout; stopping only ${mine.map((m) => m.pid).join(', ')}`);
    await killPids(mine.map((m) => m.pid));
  }
  return true;
}

export async function stop(ctx: Ctx, repo: Repo) {
  if (!isConfigured(repo)) {
    for (const svc of SERVICES) ctx.skip(svc, 'not set up');
    return;
  }
  for (const svc of SERVICES) {
    await ctx.step(svc, async () => {
      let stopped = false;
      for (const [r, who] of [[loadRun(repo.root, svc), 'devdeck run'], [tjRun(repo.root, svc), 'tj run']] as const)
        if (r && (await owned(r)) && (await safeKill(ctx, repo.root, r.pid, `${svc} ${who}`))) stopped = true;
      clearRun(repo.root, svc);
      // started by hand in a terminal of this worktree
      const port = ports(repo.root)[svc];
      const l = (await listening(port)) ? await listener(port) : undefined;
      if (l && inside(repo.root, l.cwd) && l.pgid > 1) {
        if (await safeKill(ctx, repo.root, l.pgid, `${svc} listener :${port}`)) stopped = true;
      } else if (l) ctx.log(`${svc}: port ${port} is used by ${l.cwd || 'another process'}, left alone`);
      ctx.detail(svc, stopped ? 'stopped' : 'was not running');
    });
  }
}

// ---------- dev login + license (the team's onboarding script, over fetch) ----------

type ApiRes = { status: number; json: any; cookie: string };

async function api(port: number, path: string, opts: { method?: string; body?: unknown; cookie?: string; org?: string } = {}): Promise<ApiRes> {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.org ? { 'tj-workspace-id': opts.org } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text body */
  }
  return { status: res.status, json, cookie };
}

const ok = (r: ApiRes) => r.status >= 200 && r.status < 300;
const message = (r: ApiRes) => (typeof r.json === 'object' ? r.json?.message : String(r.json).slice(0, 200)) || `HTTP ${r.status}`;

async function login(repo: Repo) {
  const { email, password } = loadSettings().login;
  const r = await api(ports(repo.root).server, '/authenticate', { body: { email, password } });
  return ok(r) ? { cookie: r.cookie, org: String(r.json.current_organization_id), name: r.json.current_organization_name as string | undefined } : null;
}

export async function onboard(ctx: Ctx, repo: Repo) {
  if (!isConfigured(repo)) throw new CmdError('this checkout is not set up yet');
  const port = ports(repo.root).server;
  const { email, password } = loadSettings().login;
  const existing = await login(repo);
  if (existing) {
    ctx.log(`logged in as ${email}`);
    updateState(repo.root, { org: { id: existing.org, name: existing.name } });
    return ctx.detail('login', email);
  }
  const setup = await api(port, '/onboarding/setup-super-admin', {
    body: { companyName: 'ToolJet', name: 'The Developer', workspaceName: 'My workspace', email, password },
  });
  if (!ok(setup))
    throw new CmdError(`couldn't log in as ${email}, and creating the admin was refused: ${message(setup)}`, 'this DB already has a different admin: set its login in Settings');
  const org = String(setup.json.current_organization_id);
  const finish = await api(port, '/onboarding/finish', { body: { region: 'us' }, cookie: setup.cookie, org });
  if (!ok(finish)) throw new CmdError(`onboarding/finish failed: ${message(finish)}`);
  ctx.log(`created ${email} with workspace "My workspace"`);
  updateState(repo.root, { org: { id: org, name: 'My workspace' } });
  ctx.detail('login', email);
}

export async function applyLicense(ctx: Ctx, repo: Repo, key: string) {
  if (!isConfigured(repo)) throw new CmdError('this checkout is not set up yet');
  const s = await login(repo);
  if (!s) throw new CmdError('could not log in to apply the license');
  const r = await api(ports(repo.root).server, '/license', { method: 'PATCH', body: { key }, cookie: s.cookie, org: s.org });
  if (!ok(r)) throw new CmdError(`license rejected: ${message(r)}`, 'check the key in Settings');
  updateState(repo.root, { licensed: key.slice(-4) });
  ctx.log('license applied');
  ctx.detail('license', `key …${key.slice(-4)}`);
}

// License terms and what's in the dev DB, for the Env card.
export async function envDetails(repo: Repo) {
  const env = ownEnv(repo);
  const out: { license?: unknown; licenseError?: string; org?: { id: string; name?: string } } = {};
  if (!isConfigured(repo)) return { licenseError: 'not set up yet' };
  if (await listening(ports(repo.root).server)) {
    try {
      const s = await login(repo);
      if (!s) throw new Error(`can't log in as ${loadSettings().login.email}`);
      out.org = { id: s.org, name: s.name };
      if (!s.name && /^[0-9a-f-]{36}$/.test(s.org) && env.PG_DB) out.org.name = (await psql(env, env.PG_DB, `select name from organizations where id = '${s.org}'`).catch(() => []))[0]?.[0];
      const terms = await api(ports(repo.root).server, '/license/terms', { cookie: s.cookie, org: s.org });
      if (!ok(terms)) throw new Error(terms.status === 404 ? 'no license API (CE edition)' : message(terms));
      const setting = await api(ports(repo.root).server, '/license', { cookie: s.cookie, org: s.org });
      out.license = summarizeTerms(terms.json.terms ?? terms.json, ok(setting) ? setting.json : undefined);
    } catch (e) {
      out.licenseError = e instanceof Error ? e.message : String(e);
    }
  } else out.licenseError = 'start the server to read the license';
  return out;
}

// Validity, expiry, limits and enabled features — never the key itself.
// Terms come flat: appsCount, usersCount, oidcEnabled…, expiryDate, isExpired, isLicenseValid.
const LIMIT_LABELS: Record<string, string> = {
  appsCount: 'Apps', usersCount: 'Users', editorUsers: 'Builders', viewerUsers: 'End users', superadminUsers: 'Super admins',
  workspacesCount: 'Workspaces', tablesCount: 'Tables', rowsCount: 'Rows', maxDurationForAuditLogs: 'Audit log days',
};
const humanize = (k: string) => k.replace(/Enabled$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function summarizeTerms(t: any, setting: any) {
  if (!t || typeof t !== 'object') return { valid: false };
  const features: { name: string; on: boolean }[] = [];
  const limits: { name: string; value: string }[] = [];
  const walk = (obj: any, prefix: string) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (['expiryDate', 'isExpired', 'isLicenseValid', 'licenseType', 'type', 'plan'].includes(k)) continue;
      if (typeof v === 'boolean') features.push({ name: humanize(k), on: v });
      else if (typeof v === 'number' || v === 'UNLIMITED') limits.push({ name: LIMIT_LABELS[k] ?? humanize(prefix + k), value: String(v) });
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k} `);
    }
  };
  walk(t, '');
  return {
    valid: !!t.isLicenseValid,
    expired: !!t.isExpired,
    expiry: t.expiryDate,
    type: t.licenseType ?? t.type ?? (typeof t.plan === 'string' ? t.plan : t.plan?.name),
    keyUpdatedAt: setting?.updated_at,
    fromEnv: !!setting?.use_env_license,
    features: features.sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name)),
    limits,
  };
}

// ---------- remove a worktree ----------

export const REMOVE_STEPS: [string, string][] = [
  ['check', 'Check for unsaved work'],
  ['server', 'Stop server'],
  ['frontend', 'Stop frontend'],
  ['dbs', 'Drop worktree databases'],
  ['worktree', 'Remove worktree'],
];

export async function removeWorktree(ctx: Ctx, repo: Repo, discard: boolean) {
  if (!repo.isWorktree) throw new CmdError('refusing to remove the main checkout');
  await ctx.step('check', async () => {
    const unsaved = await unsavedWork(repo.root);
    if (unsaved.length && !discard) throw new CmdError(`unsaved work would be lost: ${unsaved.join('; ')}`, 'commit and push it, or remove with "discard changes"');
    if (unsaved.length) ctx.log(`discarding: ${unsaved.join('; ')}`);
  });
  if (repo.tooljet) {
    await stop(ctx, repo);
    await ctx.step('dbs', async () => {
      // Only names derived from this branch (or recorded for it), and never the main checkout's.
      const env = { ...mainEnv(repo), ...ownEnv(repo) };
      const names = dbNames(repo.branch || 'detached');
      const recorded = loadState(repo.root).dbs ?? {};
      const mainDbs = new Set([mainEnv(repo).PG_DB, mainEnv(repo).TOOLJET_DB]);
      const pick = (...xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && !mainDbs.has(x)))];
      const pg = pick(names.dev, recorded.dev, `${names.dev}_test`);
      const tjdb = pick(names.tjdbDev, recorded.tjdbDev, `${names.tjdbDev}_test`);
      for (const [prefix, list] of [['PG', pg], ['TOOLJET_DB', tjdb]] as const)
        for (const db of list) {
          const { args, password } = pgArgs(env, prefix);
          const r = await capture('dropdb', ['--if-exists', ...args, db], { cwd: '/', env: { ...cleanEnv(), PGPASSWORD: password } });
          if (r.code !== 0) throw new CmdError(`dropdb ${db} failed: ${r.err}`);
          ctx.log(`dropped ${db} (if it existed)`);
        }
    });
  } else {
    ctx.skip('server', 'not a ToolJet checkout');
    ctx.skip('frontend', 'not a ToolJet checkout');
    ctx.skip('dbs', 'not a ToolJet checkout');
  }
  await ctx.step('worktree', async () => {
    // Deleting ~300k files is the slow, heavy part: move the whole worktree aside (a rename on the same disk), let git
    // forget it (prune drops worktrees whose folder is gone), and delete the files in the background at low priority.
    const trash = join(STATE_ROOT, 'trash', `${Date.now()}`);
    mkdirSync(trash, { recursive: true });
    try {
      renameSync(repo.root, join(trash, 'worktree'));
      await git(repo.main, 'worktree', 'prune');
    } catch {
      await git(repo.main, 'worktree', 'remove', '--force', repo.root); // other volume: the slow way
    }
    deleteInBackground(trash);
    forget(repo.root);
    ctx.log(`removed ${repo.root}`);
  });
}
