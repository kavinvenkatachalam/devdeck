import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { capture, CmdError, git } from './sh.ts';

export const SUBMODULES = ['server/ee', 'frontend/ee'] as const;

export type Repo = {
  root: string; // this checkout (main or worktree)
  main: string; // main checkout
  isWorktree: boolean;
  branch: string; // '' when detached
  tooljet: boolean;
};

export async function repoAt(cwd: string): Promise<Repo | null> {
  const top = await capture('git', ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (top.code !== 0) return null;
  const [root, common] = top.out.split('\n');
  const main = dirname(common);
  const branch = (await capture('git', ['branch', '--show-current'], { cwd: root })).out;
  const tooljet = existsSync(join(root, 'server', 'package.json')) && existsSync(join(root, 'frontend', 'package.json')) && existsSync(join(root, 'plugins'));
  return { root, main, isWorktree: root !== main, branch, tooljet };
}

// git blob sha1, same as `git hash-object --stdin`, so names match tj's.
export function slugHash(branch: string) {
  const hash = createHash('sha1').update(`blob ${Buffer.byteLength(branch)}\0${branch}`).digest('hex').slice(0, 6);
  const slug = branch.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30);
  return `${slug}_${hash}`;
}

// What a checkout's DB names derive from: its branch, or for a detached HEAD its folder (the same name for every
// detached worktree would have them share one database, and removing one would drop the other's).
export const dbKey = (repo: Pick<Repo, 'branch' | 'root'>) => repo.branch || `detached-${basename(repo.root)}`;

export function dbNames(branch: string) {
  const id = slugHash(branch);
  return { dev: `tooljet_${id}`, tjdbDev: `tooljet_db_${id}` };
}

export function nvmrc(root: string) {
  const f = join(root, '.nvmrc');
  return existsSync(f) ? readFileSync(f, 'utf8').replace(/[\s#].*$/s, '') : '';
}

// Local module repo of a submodule in the main checkout (holds unpushed EE branches).
export function localModule(main: string, sm: string) {
  const dir = join(main, '.git', 'modules', sm);
  return existsSync(dir) ? dir : undefined;
}

export type Worktree = { path: string; branch: string; head: string; main: boolean };

export async function worktrees(main: string): Promise<Worktree[]> {
  const out = await git(main, 'worktree', 'list', '--porcelain');
  return out
    .split('\n\n')
    .map((block) => {
      const get = (k: string) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? '';
      const path = get('worktree');
      return { path, branch: get('branch').replace('refs/heads/', ''), head: get('HEAD').slice(0, 10), main: path === main };
    })
    .filter((w) => w.path && existsSync(w.path));
}

const refExists = async (root: string, ref: string) => (await capture('git', ['rev-parse', '-q', '--verify', ref], { cwd: root })).code === 0;

// The remote's default branch (origin/main); falls back to the local idea of it when offline.
export async function defaultBase(root: string) {
  const r = await capture('git', ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: root });
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.out)?.[1];
  if (branch) return `origin/${branch}`;
  const local = (await capture('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })).out;
  return local || 'origin/main';
}

// Branch suggestions for the New session form: recently active remote branches.
export async function recentBranches(root: string) {
  const r = await capture('git', ['for-each-ref', '--sort=-committerdate', '--count=30', '--format=%(refname:short)', 'refs/remotes/origin'], { cwd: root });
  return r.out.split('\n').filter((b) => b && b !== 'origin/HEAD' && b !== 'origin');
}

export const worktreeDir = (main: string, branch: string) => join(main, '.worktrees', slugHash(branch));

// Existing local branch, remote branch, or a new branch from base — same rules as `tj wt add`.
export async function addWorktree(main: string, branch: string, base: string | undefined, log: (l: string) => void) {
  const existing = (await worktrees(main)).find((w) => w.branch === branch);
  if (existing) {
    log(`worktree for ${branch} already exists: ${existing.path}`);
    return { path: existing.path, base: undefined, existed: true };
  }
  const path = worktreeDir(main, branch);
  await capture('git', ['fetch', '-q', 'origin', branch], { cwd: main }); // may not exist remotely
  if (await refExists(main, `refs/heads/${branch}`)) {
    await git(main, 'worktree', 'add', path, branch);
    log(`checked out existing branch ${branch}`);
    return { path, base: undefined };
  }
  if (await refExists(main, `refs/remotes/origin/${branch}`)) {
    await git(main, 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`);
    log(`tracking origin/${branch}`);
    return { path, base: `origin/${branch}` };
  }
  const from = base || (await defaultBase(main));
  if (from.startsWith('origin/')) await capture('git', ['fetch', '-q', 'origin', from.slice('origin/'.length)], { cwd: main });
  if (!(await refExists(main, from))) throw new CmdError(`base ${from} not found`, 'pick an existing branch, e.g. origin/main');
  await git(main, 'worktree', 'add', '-b', branch, path, from);
  log(`new branch ${branch} from ${from}`);
  return { path, base: from };
}

// Root commits survive `worktree remove` (shared repo); submodule git dirs live in the
// worktree's admin dir and are deleted with it, so their unpushed commits count too.
export async function unsavedWork(path: string) {
  const found: string[] = [];
  const repos = [{ dir: path, label: 'worktree', pin: '' }, ...SUBMODULES.map((sm) => ({ dir: join(path, sm), label: sm, pin: sm }))];
  for (const { dir, label, pin } of repos) {
    if (!existsSync(join(dir, '.git'))) continue;
    if ((await capture('git', ['status', '--porcelain', '--ignore-submodules=all'], { cwd: dir })).out) found.push(`${label}: uncommitted changes`);
    if (!pin) continue;
    const pinned = await capture('git', ['rev-parse', '-q', '--verify', `HEAD:${pin}`], { cwd: path });
    const ahead = (await capture('git', ['log', '--oneline', 'HEAD', '--branches', '--not', '--remotes', ...(pinned.code === 0 ? [pinned.out] : [])], { cwd: dir })).out;
    if (ahead) found.push(`${label}: ${ahead.split('\n').length} unpushed commit(s)`);
  }
  return found;
}

export const displayName = (path: string) => basename(path);
