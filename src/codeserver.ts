// Optional full editor: one code-server for all checkouts, served same-origin under /code/
// so it works through the same Tailscale URL as devdeck. Not bundled (it's large): install via brew.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { listening, waitHttp } from './net.ts';
import { alive, capture, CmdError, killGroup, owned, procStart, startDetached } from './sh.ts';
import { STATE_ROOT } from './state.ts';
import { cleanEnv } from './tmux.ts';

const PORT = Number(process.env.DEVDECK_CODE_PORT || 4318);
const DIR = join(STATE_ROOT, 'code-server');
const RUN = join(DIR, 'run.json');

const CANDIDATES = ['/opt/homebrew/bin/code-server', '/usr/local/bin/code-server'];
// bump when the launch flags change, so a running code-server gets restarted with the new ones
const LAUNCH_VERSION = 2;

export async function findCodeServer() {
  const which = (await capture('which', ['code-server'], { cwd: '/', env: cleanEnv() })).out;
  return which || CANDIDATES.find(existsSync) || '';
}

const readRun = () => {
  try {
    return JSON.parse(readFileSync(RUN, 'utf8')) as { pid: number; procStart?: string; v?: number };
  } catch {
    return undefined;
  }
};

// ---------- profile: your VS Code settings, scoped to the opened folder ----------

// Whichever VS Code-family editor this Mac's user has (the first one found): its settings folder and extensions.
const EDITORS = [['Code', '.vscode'], ['Code - Insiders', '.vscode-insiders'], ['Cursor', '.cursor'], ['VSCodium', '.vscode-oss']];
const appDir = (name: string) => (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', name, 'User') : join(homedir(), '.config', name, 'User'));
const EDITOR = EDITORS.map(([name, ext]) => ({ name, user: appDir(name), extensions: join(homedir(), ext, 'extensions') })).find((e) => existsSync(e.user));
const VSCODE_USER = EDITOR?.user ?? appDir('Code');
const DATA = join(DIR, 'data');
const EXT_DIR = join(DIR, 'extensions');

// settings.json is JSONC: drop comments and trailing commas (outside strings) before parsing.
function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++;
    else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return {};
  }
}

const isLinkTo = (p: string, target: string) => {
  try {
    return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
  } catch {
    return false;
  }
};

// Light or dark, as devdeck's own theme is (the page sends it: a browser doesn't pass it into the editor's frame).
let dark = true;
export function setCodeTheme(d: boolean) {
  if (d === dark) return;
  dark = d;
  prepareProfile(); // code-server applies the changed settings file live
}

// Your theme for each: your editor's preferred light/dark themes, else your color theme on the side it suits, else VS Code's.
function themes(mine: Record<string, any>) {
  const own: string | undefined = mine['workbench.colorTheme'];
  const ownLight = !!own && /light/i.test(own);
  return {
    dark: mine['workbench.preferredDarkColorTheme'] ?? (own && !ownLight ? own : 'Default Dark Modern'),
    light: mine['workbench.preferredLightColorTheme'] ?? (ownLight ? own : 'Default Light Modern'),
  };
}

// code-server shares your desktop VS Code settings, keybindings and snippets (linked, so edits show up in both),
// and adds machine-level overrides so it shows only the opened folder: VS Code's git extension otherwise lists
// every worktree of the repo (git.detectWorktrees), and a main checkout's .worktrees/ folder.
export function prepareProfile() {
  const user = join(DATA, 'User');
  mkdirSync(user, { recursive: true });
  const linked: string[] = [];
  if (existsSync(VSCODE_USER))
    for (const name of ['settings.json', 'keybindings.json', 'snippets', 'tasks.json']) {
      const src = join(VSCODE_USER, name);
      const dst = join(user, name);
      if (!existsSync(src)) continue;
      if (!isLinkTo(dst, src)) {
        if (existsSync(dst) || lstatSync(dst, { throwIfNoEntry: false })) renameSync(dst, `${dst}.devdeck-backup-${Date.now()}`);
        symlinkSync(src, dst);
      }
      linked.push(name);
    }
  const mine = existsSync(join(VSCODE_USER, 'settings.json')) ? parseJsonc(readFileSync(join(VSCODE_USER, 'settings.json'), 'utf8')) : {};
  const machine = {
    'git.detectWorktrees': false,
    'workbench.startupEditor': 'none',
    // no built-in AI chat panel: the agents run in the terminals (your own settings can turn it back on)
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    // your own extensions are synced; the repo's recommendations would only nag
    'extensions.ignoreRecommendations': true,
    'git.repositoryScanIgnoredFolders': [...new Set([...(mine['git.repositoryScanIgnoredFolders'] ?? ['node_modules']), '.worktrees'])],
    // object settings replace rather than merge across levels, so carry yours over
    'files.exclude': { ...(mine['files.exclude'] ?? {}), '**/.worktrees': true },
    'search.exclude': { ...(mine['search.exclude'] ?? {}), '**/.worktrees': true },
    // follows devdeck's light/dark switch, not the OS
    'window.autoDetectColorScheme': false,
    'workbench.colorTheme': themes(mine)[dark ? 'dark' : 'light'],
  };
  mkdirSync(join(DATA, 'Machine'), { recursive: true });
  writeFileSync(join(DATA, 'Machine', 'settings.json'), `${JSON.stringify(machine, null, 2)}\n`);
  return { vscode: existsSync(VSCODE_USER), editor: EDITOR?.name, linked };
}

// Installed extensions, read from an extensions folder's index (entries whose folder still exists), lower-cased ids.
function installed(dir: string) {
  try {
    const list = JSON.parse(readFileSync(join(dir, 'extensions.json'), 'utf8')) as { identifier: { id: string }; relativeLocation?: string }[];
    return new Set(list.filter((x) => !x.relativeLocation || existsSync(join(dir, x.relativeLocation))).map((x) => x.identifier.id.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

// Ones Open VSX doesn't have (code-server can't use Microsoft's marketplace), so they aren't retried on every open.
const UNAVAILABLE = join(DIR, 'unavailable-extensions.json');
const unavailable = (): string[] => {
  try {
    return JSON.parse(readFileSync(UNAVAILABLE, 'utf8'));
  } catch {
    return [];
  }
};

const missingExtensions = () => {
  const here = installed(EXT_DIR);
  const skip = new Set(unavailable());
  return EDITOR ? [...installed(EDITOR.extensions)].filter((x) => !here.has(x) && !skip.has(x)) : [];
};

// Your desktop extensions follow you into code-server: whatever is missing gets installed, one sync at a time.
let syncing: Promise<void> | undefined;
function syncExtensions(bin: string) {
  const missing = missingExtensions();
  if (!missing.length || syncing) return syncing;
  syncing = (async () => {
    const failed = unavailable();
    for (const id of missing) {
      const r = await capture(bin, ['--extensions-dir', EXT_DIR, '--user-data-dir', DATA, '--install-extension', id], { cwd: '/', env: cleanEnv() });
      if (r.code !== 0 || /not found|failed/i.test(r.out + r.err)) failed.push(id);
    }
    mkdirSync(DIR, { recursive: true });
    writeFileSync(UNAVAILABLE, JSON.stringify([...new Set(failed)]));
  })().finally(() => (syncing = undefined));
  return syncing;
}

export async function codeStatus() {
  const bin = await findCodeServer();
  const run = readRun();
  const running = (await owned(run)) && (await listening(PORT));
  const profile = bin ? prepareProfile() : { vscode: false, linked: [] };
  if (running) syncExtensions(bin)?.catch(() => {}); // picks up extensions added to your editor since
  return {
    installed: !!bin,
    bin,
    running,
    stale: running && run?.v !== LAUNCH_VERSION,
    port: PORT,
    brew: existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew'),
    profile,
  };
}

export async function startCodeServer() {
  const s = await codeStatus();
  if (s.running && !s.stale) return s;
  if (s.running) await killGroup(readRun()!.pid); // started with older flags
  if (!s.installed) throw new CmdError('code-server is not installed', 'install it from the Code tab, or: brew install code-server');
  if (await listening(PORT)) throw new CmdError(`port ${PORT} is already in use`, 'set DEVDECK_CODE_PORT to another port');
  mkdirSync(DIR, { recursive: true });
  prepareProfile();
  await syncExtensions(s.bin); // before launch, so they're active in the first window
  // workspace trust off: these are your own checkouts, and Restricted Mode turns git off in every new worktree
  const args = ['--auth', 'none', '--bind-addr', `127.0.0.1:${PORT}`, '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', '--user-data-dir', DATA, '--extensions-dir', EXT_DIR];
  const pid = startDetached(s.bin, args, { cwd: DIR, env: cleanEnv(), log: join(DIR, 'code-server.log') });
  writeFileSync(RUN, JSON.stringify({ pid, procStart: await procStart(pid), v: LAUNCH_VERSION }));
  if ((await waitHttp(`http://127.0.0.1:${PORT}/healthz`, 60_000, () => alive(pid))) !== 'ready') throw new CmdError('code-server did not start', `see ${join(DIR, 'code-server.log')}`);
  return codeStatus();
}

// /code/... → code-server, keeping the browser's Host/Origin so code-server's origin check passes.
export function proxyHttp(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url || '/').replace(/^\/code/, '') || '/';
  const up = request({ host: '127.0.0.1', port: PORT, method: req.method, path, headers: { ...req.headers, 'x-forwarded-prefix': '/code' } }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('code-server is not running — start it from the Code tab');
  });
  req.pipe(up);
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const path = (req.url || '/').replace(/^\/code/, '') || '/';
  const up = connect(PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${path} HTTP/1.1`, ...Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))];
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', end);
  socket.on('error', end);
}
