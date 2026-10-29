// What changed in a checkout, as files with unified-diff text. Includes changes inside submodules
// (server/ee, frontend/ee) and untracked files, so it matches what a PR would show.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBase } from './repo.ts';
import { capture } from './sh.ts';
import { loadState } from './state.ts';

export type DiffFile = { path: string; oldPath?: string; status: string; add: number; del: number; patch: string; truncated?: boolean };

const MAX_FILE_LINES = 2500;
const MAX_UNTRACKED = 40;

const gitOut = async (cwd: string, args: string[]) => (await capture('git', args, { cwd })).out;

function parse(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  // git's "Submodule x contains modified content" notes sit between files; the inner files are listed anyway
  for (const block of patch.replace(/^Submodule .*\n?/gm, '').split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    if (!head) continue;
    const [, a, b] = head;
    const at = block.indexOf('\n@@');
    const body = at >= 0 ? block.slice(at + 1) : '';
    const lines = body.split('\n');
    let add = 0;
    let del = 0;
    for (const l of lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
    const status = /^new file/m.test(block) ? 'added' : /^deleted file/m.test(block) ? 'deleted' : /^rename from/m.test(block) ? 'renamed' : /^Binary files/m.test(block) ? 'binary' : 'modified';
    const truncated = lines.length > MAX_FILE_LINES;
    files.push({ path: b, oldPath: a !== b ? a : undefined, status, add, del, patch: truncated ? lines.slice(0, MAX_FILE_LINES).join('\n') : body, truncated });
  }
  return files;
}

async function untracked(root: string): Promise<DiffFile[]> {
  const names = (await gitOut(root, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const out: DiffFile[] = [];
  for (const name of names.slice(0, MAX_UNTRACKED)) {
    const file = join(root, name);
    if (!existsSync(file) || statSync(file).size > 200_000) {
      out.push({ path: name, status: 'untracked', add: 0, del: 0, patch: '' });
      continue;
    }
    const r = await capture('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', name], { cwd: root });
    const [f] = parse(r.out.replace(/^diff --git a\/dev\/null b\//m, `diff --git a/${name} b/`));
    out.push({ ...(f ?? { path: name, add: 0, del: 0, patch: '' }), path: name, status: 'untracked' });
  }
  if (names.length > MAX_UNTRACKED) out.push({ path: `… and ${names.length - MAX_UNTRACKED} more untracked files`, status: 'untracked', add: 0, del: 0, patch: '' });
  return out;
}

export async function diff(root: string, mode: 'uncommitted' | 'branch', baseArg?: string) {
  const flags = ['--no-color', '--no-ext-diff', '--submodule=diff', '-M', '-U3'];
  let base: string | undefined;
  let commits: { sha: string; subject: string }[] = [];
  let against = 'HEAD';
  if (mode === 'branch') {
    base = baseArg || loadState(root).base || (await defaultBase(root));
    const mb = await gitOut(root, ['merge-base', 'HEAD', base]);
    if (!mb) return { mode, base, error: `no common history with ${base}`, files: [], commits };
    against = mb;
    commits = (await gitOut(root, ['log', '--format=%h%x09%s', '-n', '50', `${mb}..HEAD`]))
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ sha: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }));
  }
  const patch = await gitOut(root, ['diff', ...flags, against]);
  const files = [...parse(patch), ...(await untracked(root))];
  return { mode, base, files, commits, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0) };
}
