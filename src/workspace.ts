// Which dev tools this Mac has: CLIs and shell aliases/functions.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capture } from './sh.ts';
import { cleanEnv } from './tmux.ts';

// ---------- tools ----------

const CLIS: [string, string[]][] = [
  ['node', ['--version']], ['npm', ['--version']], ['git', ['--version']], ['gh', ['--version']], ['tmux', ['-V']],
  ['psql', ['--version']], ['redis-cli', ['--version']], ['docker', ['--version']], ['brew', ['--version']],
  ['claude', ['--version']], ['codex', ['--version']], ['code', ['--version']], ['code-server', ['--version']], ['tailscale', ['version']],
];

async function cli(name: string, args: string[]) {
  const where = (await capture('which', [name], { cwd: '/', env: cleanEnv() })).out;
  if (!where) return { name, installed: false };
  const v = await Promise.race([
    capture(where, args, { cwd: '/', env: cleanEnv() }),
    new Promise<{ out: string }>((r) => setTimeout(() => r({ out: '' }), 3000)),
  ]);
  return { name, installed: true, path: where, version: v.out.split('\n')[0].slice(0, 80) };
}

type ShellDef = { kind: 'alias' | 'function'; name: string; body: string };

// Aliases and functions defined in a shell file (not executed, just read).
function defsIn(file: string): ShellDef[] {
  const defs: ShellDef[] = [];
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/^\s*alias\s+([\w.-]+)=(['"]?)(.*)\2\s*$/gm)) defs.push({ kind: 'alias', name: m[1], body: m[3].slice(0, 200) });
  for (const m of text.matchAll(/^\s*(?:function\s+([\w-]+)|([\w-]+)\s*\(\))\s*\{?/gm)) {
    const name = m[1] || m[2];
    if (!name.startsWith('_')) defs.push({ kind: 'function', name, body: '' });
  }
  return defs;
}

// ~/.zshrc and friends, plus the files they source (one level), skipping frameworks like oh-my-zsh.
function shellTools() {
  const home = homedir();
  const files = ['.zshenv', '.zprofile', '.zshrc', '.bashrc', '.bash_profile'].map((f) => join(home, f)).filter(existsSync);
  const out: { file: string; defs: ShellDef[] }[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    if (seen.has(file) || !existsSync(file) || !statSync(file).isFile()) return;
    seen.add(file);
    const defs = defsIn(file);
    if (defs.length) out.push({ file: file.replace(home, '~'), defs });
  };
  for (const f of files) {
    add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:source|\.)\s+["']?([^"'\s;]+)["']?/gm)) {
      const p = m[1].replace(/^~|^\$HOME|^\$\{HOME\}/, home);
      if (/oh-my-zsh|\$ZSH|nvm\.sh|zinit|antigen|powerlevel/.test(p) || p.includes('$')) continue;
      add(p);
    }
  }
  return out;
}

export async function tools() {
  return {
    clis: await Promise.all(CLIS.map(([n, a]) => cli(n, a))),
    shell: shellTools(),
  };
}
