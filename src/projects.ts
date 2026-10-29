// Projects = git repos found in the configured folders, each with its checkouts (main + worktrees),
// the terminal sessions open in them and whether their ToolJet servers are up.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ports } from './devenv.ts';
import { activeJob } from './jobs.ts';
import { listening } from './net.ts';
import { prFor } from './prs.ts';
import { worktrees } from './repo.ts';
import { expandHome } from './settings.ts';
import { capture } from './sh.ts';
import type { Session } from './tmux.ts';

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
// macOS paths are case-insensitive; use the on-disk spelling so "~/Work/Tooljet" matches git's "ToolJet".
const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
const isToolJet = (p: string) => existsSync(join(p, 'server', 'package.json')) && existsSync(join(p, 'frontend', 'package.json'));
const SKIP = new Set(['node_modules', 'dist', 'build']);

async function mainOf(worktree: string) {
  const r = await capture('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
  return r.code === 0 ? dirname(r.out) : undefined;
}

// A folder in settings can be a repo, a worktree (→ its repo), or a parent of repos.
export async function discover(roots: string[]) {
  const repos = new Set<string>();
  const folders = new Set<string>(); // plain folders under parent roots, for "Open folder"
  const report: { root: string; path: string; found: boolean; kind: 'repo' | 'parent' | 'missing'; repos: number }[] = [];
  for (const raw of roots) {
    const root = real(expandHome(raw));
    if (!isDir(root)) {
      report.push({ root: raw, path: root, found: false, kind: 'missing', repos: 0 });
      continue;
    }
    if (existsSync(join(root, '.git'))) {
      const main = isDir(join(root, '.git')) ? root : await mainOf(root);
      if (main) repos.add(real(main));
      report.push({ root: raw, path: root, found: true, kind: 'repo', repos: 1 });
      continue;
    }
    let n = 0;
    for (const name of readdirSync(root).sort()) {
      const p = join(root, name);
      if (name.startsWith('.') || SKIP.has(name) || !isDir(p)) continue;
      if (isDir(join(p, '.git'))) {
        repos.add(p);
        n++;
      } else if (!existsSync(join(p, '.git'))) folders.add(p);
      // a worktree (.git file) shows up under its main repo
    }
    report.push({ root: raw, path: root, found: true, kind: 'parent', repos: n });
  }
  return { repos: [...repos], folders: [...folders], report };
}

const gitCache = new Map<string, boolean>();
async function isGit(path: string) {
  if (!gitCache.has(path)) gitCache.set(path, (await capture('git', ['rev-parse', '--git-dir'], { cwd: path })).code === 0);
  return gitCache.get(path)!;
}

// git status / ahead-behind are slow on big repos (~0.2 s of CPU each in ToolJet): serve the last value and
// refresh in the background, every 30 s where you're working (a session or servers), every 10 min elsewhere.
// Opening a worktree's changes refreshes it at once (refreshStats).
type Stats = { changes: number; ahead?: number; behind?: number };
const statsCache = new Map<string, { at: number; value?: Stats; pending?: Promise<void> }>();

function stats(path: string, active: boolean): Stats | undefined {
  if (activeJob(path)) return undefined; // mid-setup the tree is still being filled in; counts would be noise
  const c = statsCache.get(path) ?? { at: 0 };
  if (!c.pending && Date.now() - c.at > (active ? 30_000 : 600_000)) {
    c.pending = (async () => {
      const [dirty, counts] = await Promise.all([
        capture('git', ['status', '--porcelain', '--ignore-submodules=all'], { cwd: path }),
        capture('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd: path }),
      ]);
      const [behind, ahead] = counts.code === 0 ? counts.out.split(/\s+/).map(Number) : [undefined, undefined];
      c.value = { changes: dirty.out ? dirty.out.split('\n').length : 0, ahead, behind };
      c.at = Date.now();
      c.pending = undefined;
    })().catch(() => {
      c.pending = undefined;
    });
    statsCache.set(path, c);
  }
  return c.value;
}
// a worktree that was being checked out had a meaningless count: drop it
export const forgetStats = (path: string) => statsCache.delete(path);

// mark stale (keep showing the old value until the new one is in)
export const refreshStats = (path: string) => {
  const c = statsCache.get(path);
  if (c) c.at = 0;
};

// Is this checkout's ToolJet up? Only for checkouts with their own .env (defaults belong to main).
export async function serversUp(root: string, isWorktree: boolean) {
  const envFile = join(root, '.env');
  if (!isToolJet(root) || !existsSync(envFile)) return undefined;
  if (isWorktree && !/^\s*PORT\s*=/m.test(readFileSync(envFile, 'utf8'))) return undefined;
  const p = ports(root);
  const [server, frontend] = await Promise.all([listening(p.server), listening(p.frontend)]);
  return { server, frontend, ports: p };
}

export type SessionRef = { name: string; tabs: Session['tabs'] };

export async function projects(roots: string[], sessions: Session[]) {
  const { repos } = await discover(roots);
  const list = await Promise.all(
    repos.map(async (repo) => {
      const wts = await worktrees(repo).catch(() => []);
      return {
        name: basename(repo),
        path: repo,
        tooljet: isToolJet(repo),
        checkouts: wts.map((w) => ({ path: w.path, branch: w.branch, head: w.head, main: w.main, name: w.main ? basename(repo) : w.branch || basename(w.path) })),
      };
    }),
  );

  // Each session belongs to the checkout whose path is the longest prefix of the session's folder
  // (worktrees live inside the main checkout's .worktrees/).
  const all = list.flatMap((p) => p.checkouts.map((c) => c.path));
  const owner = (path: string) => all.filter((c) => path === c || path.startsWith(c + '/')).sort((a, b) => b.length - a.length)[0];
  const byCheckout = new Map<string, SessionRef[]>();
  for (const s of sessions) {
    const o = owner(s.path);
    if (o) byCheckout.set(o, [...(byCheckout.get(o) ?? []), { name: s.name, tabs: s.tabs }]);
  }

  const out = await Promise.all(
    list.map(async (p) => {
      const checkouts = await Promise.all(
        p.checkouts.map(async (c) => {
          const sessions = byCheckout.get(c.path) ?? [];
          const servers = p.tooljet ? await serversUp(c.path, !c.main) : undefined;
          const active = sessions.length > 0 || !!(servers?.server || servers?.frontend);
          return { ...c, sessions, servers, stats: stats(c.path, active), pr: prFor(p.path, c.branch, c.head) };
        }),
      );
      const active = (c: (typeof checkouts)[number]) => Number(c.sessions.length > 0) + Number(!!(c.servers?.server || c.servers?.frontend));
      checkouts.sort((a, b) => Number(b.main) - Number(a.main) || active(b) - active(a) || a.name.localeCompare(b.name));
      return { ...p, checkouts };
    }),
  );
  // Sessions are the main list: each one with the checkout it runs in (if any) and whether it's a git folder.
  const flat = await Promise.all(
    [...sessions]
      .sort((a, b) => b.created - a.created)
      .map(async (s) => ({ ...s, checkout: owner(s.path) ?? null, git: await isGit(s.path) })),
  );
  return { sessions: flat, projects: out };
}

// Everything "Open folder" can offer: every checkout plus plain folders under parent roots.
export async function openable(roots: string[]) {
  const { repos, folders } = await discover(roots);
  const checkouts = (
    await Promise.all(
      repos.map(async (repo) =>
        (await worktrees(repo).catch(() => [])).map((w) => ({ path: w.path, name: w.main ? basename(repo) : w.branch || basename(w.path), branch: w.branch, project: basename(repo), main: w.main, tooljet: isToolJet(w.path) })),
      ),
    )
  ).flat();
  return { checkouts, folders: folders.map((path) => ({ path, name: basename(path) })) };
}

export { real };
