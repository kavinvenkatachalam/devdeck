// The devdeck app: a window onto devdeck's dashboard, which the `devdeck` command serves (Homebrew installs both).
// It runs nothing of devdeck itself: quitting it leaves devdeck, its terminals and servers running, for the browser
// and the phone. It starts devdeck only when you click Start, and updates only when you click Restart to Update.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.DEVDECK_PORT || '4317';
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = 'kavinvenkatachalam/devdeck';
const HOUR = 60 * 60 * 1000;

if (!app.requestSingleInstanceLock()) app.quit();

// Apps opened from the Dock get a bare PATH (/usr/bin:/bin…), without Homebrew, git, gh or Claude. Ask the login
// shell for the PATH you have in Terminal, once, and add Homebrew's usual folders in case that fails.
function shellPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(app.getPath('home'), '.local/bin')];
  let found = '';
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\\n__DEVDECK_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    found = out.split('__DEVDECK_PATH__').pop().trim();
  } catch {}
  return [...new Set([...found.split(':'), ...process.env.PATH.split(':'), ...extra].filter(Boolean))].join(':');
}
let env;
const shellEnv = () => (env ??= { ...process.env, PATH: shellPath() });

// the `devdeck` command, as Terminal would find it
function cli() {
  for (const dir of shellEnv().PATH.split(':')) {
    const p = path.join(dir, 'devdeck');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const up = () => fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

// ---------- the window ----------

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function savedBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return { width: 1360, height: 880 };
  }
}

let win = null;
async function open() {
  if (win) return win.show();
  win = new BrowserWindow({
    ...savedBounds(),
    minWidth: 420,
    minHeight: 400,
    title: 'devdeck',
    backgroundColor: '#18181b',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  const save = () => win && !win.isMinimized() && fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  win.on('resize', save);
  win.on('move', save);
  win.on('closed', () => (win = null));
  // devdeck's own pages (Code in its own tab, say) open as app windows; any other site in your browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(BASE) || url.startsWith('file:')) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  // "(2) devdeck" while two agents need you: the same count on the Dock icon
  win.on('page-title-updated', (_e, title) => app.dock?.setBadge(/^\((\d+)\)/.exec(title)?.[1] ?? ''));
  await show();
}

// devdeck if it's running, else the welcome page (Start devdeck, or how to install it)
async function show() {
  if (await up()) return win.loadURL(BASE);
  win.loadFile(path.join(__dirname, 'welcome.html'), { query: { cli: cli() ? '1' : '' } });
}

ipcMain.handle('start', async () => {
  const bin = cli();
  if (!bin) throw new Error('The devdeck command isn\'t installed.');
  await new Promise((res, rej) =>
    execFile(bin, ['start'], { env: shellEnv(), timeout: 30_000 }, (err, _out, stderr) => (err ? rej(new Error(stderr.trim() || err.message)) : res())),
  );
  for (let i = 0; i < 25 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
  if (win) await show();
});
ipcMain.handle('retry', () => win && show());

// ---------- updates ----------

// devdeck on this Mac knows whether a newer release is out (it asks GitHub once a day, and now on Check for Updates),
// so the menu says what its sidebar says. Restart to Update runs the same update: devdeck updates through Homebrew and
// restarts, and this app is replaced (and reopened) only when the release brings a different app.
let latest = null;
let updating = false;
async function local(route, method = 'GET') {
  const r = await fetch(`${BASE}/api${route}`, { method, signal: AbortSignal.timeout(15_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `devdeck answered ${r.status}`);
  return body;
}
async function checkUpdate(tell = false) {
  try {
    const u = tell ? await local('/update/check', 'POST') : (await local('/host')).update;
    latest = u?.available ?? null;
    menu();
    if (tell && !latest) dialog.showMessageBox({ message: 'devdeck is up to date.' });
  } catch (e) {
    if (tell) dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t check for updates.', detail: (await up()) ? e.message : 'devdeck isn\'t running: start it first.' });
  }
}
async function update() {
  updating = true;
  menu();
  const before = (await local('/host').catch(() => ({}))).version;
  try {
    await local('/update', 'POST');
  } catch (e) {
    updating = false;
    menu();
    return dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t update.', detail: e.message });
  }
  // devdeck restarts onto the new version (this app may be replaced and reopened meanwhile); still here, wait for it
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const h = await local('/host').catch(() => null);
    if (h && h.version !== before) {
      updating = false;
      latest = null;
      menu();
      return win && show();
    }
    if (h && !h.update?.updating && i > 2) break; // done, and still the old version: it failed
  }
  updating = false;
  menu();
  dialog.showMessageBox({ type: 'warning', message: 'The update didn\'t finish.', detail: 'Run `devdeck update` in Terminal to see why.' });
}

// ---------- menu ----------

function menu() {
  const item = updating
    ? { label: 'Updating…', enabled: false }
    : latest
      ? { label: `Restart to Update (${latest})…`, click: update }
      : { label: 'Check for Updates…', click: () => checkUpdate(true) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [{ role: 'about' }, item, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && show() },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { label: 'Open in Browser', click: () => shell.openExternal(BASE) },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'devdeck on GitHub', click: () => shell.openExternal(`https://github.com/${REPO}`) }] },
  ]));
}

// ---------- app ----------

app.setAboutPanelOptions({ applicationName: 'devdeck', applicationVersion: app.getVersion(), copyright: 'MIT License' });
app.on('second-instance', () => open());
app.on('activate', () => open());
// closing the window leaves the app in the Dock, like other Mac apps; devdeck itself runs on regardless
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
  menu();
  open();
  // asks devdeck here (no network): it does the daily asking of GitHub
  setTimeout(checkUpdate, 10_000);
  setInterval(checkUpdate, HOUR);
});
