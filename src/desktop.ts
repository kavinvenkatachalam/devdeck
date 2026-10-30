// `devdeck desktop install | update | status | uninstall`: the devdeck app (desktop/), from the latest GitHub release.
// The app is installed by this command, never downloaded in a browser: macOS flags browser downloads, and an app
// without a paid Apple signature then can't be opened without a trip to System Settings. A download made here isn't
// flagged, so this does the checks macOS would have: the DMG's SHA-256 against the release's, and the app's own
// signature, before it goes into /Applications. The app rarely changes when devdeck does, so each release says which
// app it carries (a fingerprint of desktop/, in devdeck-desktop.json): the 124 MB come down only when that changed.
//   --dmg <file>   install that DMG instead of downloading one (for testing a local build)
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'kavinvenkatachalam/devdeck';
const DIR = process.env.DEVDECK_APP_DIR || '/Applications';
const APP = join(DIR, 'devdeck.app');
const NAME = /^devdeck-desktop-[\d.]+-arm64\.dmg$/;

const fail = (msg: string): never => {
  throw new Error(msg);
};
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Release = { version: string; url: string; name: string; sha256?: string; app?: string };
async function latest(): Promise<Release> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) fail(`couldn't reach GitHub for the latest release (${r.status})`);
  const rel = (await r.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] };
  const dmg = rel.assets.find((a) => NAME.test(a.name)) ?? fail(`release ${rel.tag_name} has no app for Apple Silicon`);
  const info = rel.assets.find((a) => a.name === 'devdeck-desktop.json');
  const app = info ? ((await (await fetch(info.browser_download_url)).json()) as { hash?: string }).hash : undefined;
  return { version: rel.tag_name.replace(/^v/, ''), url: dmg.browser_download_url, name: dmg.name, sha256: dmg.digest?.replace(/^sha256:/, ''), app };
}

function installed() {
  if (!existsSync(APP)) return undefined;
  try {
    return run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(APP, 'Contents', 'Info.plist')]);
  } catch {
    return 'unknown';
  }
}
// the fingerprint of desktop/ the installed app was built from (none in apps from before it was recorded)
function installedHash() {
  try {
    return run('plutil', ['-extract', 'DevdeckDesktopHash', 'raw', join(APP, 'Contents', 'Info.plist')]);
  } catch {
    return undefined;
  }
}
const unchanged = (rel: Release) => !!rel.app && installedHash() === rel.app;
const running = () => spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/`]).status === 0;

// downloaded with its SHA-256 worked out on the way, then compared with the release's
async function download(rel: Release, to: string) {
  if (!rel.sha256) fail(`GitHub gave no checksum for ${rel.name}, so it can't be checked: not installing it`);
  const r = await fetch(rel.url);
  if (!r.ok || !r.body) fail(`download failed (${r.status})`);
  const hash = createHash('sha256');
  const out = createWriteStream(to);
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
  }
  await new Promise((res) => out.end(res));
  const got = hash.digest('hex');
  if (got !== rel.sha256) fail(`${rel.name} doesn't match the release's checksum (got ${got}): not installing it`);
}

// Quit it the way the Dock would, so it closes cleanly; then wait for it to go.
async function quit() {
  spawnSync('osascript', ['-e', 'quit app "devdeck"']);
  for (let i = 0; i < 50 && running(); i++) await new Promise((res) => setTimeout(res, 200));
  if (running()) fail('devdeck (the app) is still open: quit it and try again');
}

// Everything slow happens beside the old app; it's only swapped at the end, so a failure leaves it as it was.
async function install(force: boolean, dmgArg?: string) {
  const have = installed();
  const rel = dmgArg ? undefined : await latest();
  if (rel && !force && (have === rel.version || unchanged(rel))) {
    console.log(have === rel.version ? `devdeck app ${have} is the latest` : `devdeck app ${have} is the same as ${rel.version}'s: nothing to download`);
    if (process.argv.includes('--open')) spawnSync('open', [APP]);
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'devdeck-desktop-'));
  const mnt = join(tmp, 'mnt');
  let attached = false;
  try {
    let dmg = dmgArg;
    if (rel) {
      console.log(`downloading the devdeck app ${rel.version}…`);
      dmg = join(tmp, rel.name);
      await download(rel, dmg);
    }
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg!]);
    attached = true;
    const app = join(mnt, 'devdeck.app');
    if (!existsSync(app)) fail('the DMG has no devdeck.app in it: not installing it');
    try {
      run('codesign', ['--verify', '--deep', '--strict', app]);
    } catch (e) {
      fail(`the app's signature doesn't check out: not installing it\n${(e as { stderr?: string }).stderr ?? ''}`);
    }
    const staged = join(DIR, '.devdeck.app.new');
    rmSync(staged, { recursive: true, force: true });
    run('ditto', [app, staged]);
    const wasOpen = running();
    if (wasOpen) await quit();
    rmSync(APP, { recursive: true, force: true });
    renameSync(staged, APP);
    console.log(`devdeck app ${installed()} installed in ${DIR}${have && have !== installed() ? ` (was ${have})` : ''}`);
    if (wasOpen || process.argv.includes('--open')) spawnSync('open', [APP]);
  } finally {
    if (attached) spawnSync('hdiutil', ['detach', '-quiet', mnt]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dmg = rest.includes('--dmg') ? rest[rest.indexOf('--dmg') + 1] : undefined;
  switch (cmd) {
    case 'install':
      return install(rest.includes('--force') || !!dmg, dmg);
    case 'update':
      if (!installed()) return fail('the devdeck app isn\'t installed: devdeck desktop install');
      return install(false, dmg);
    case 'status': {
      const have = installed();
      const rel = await latest().catch(() => undefined);
      console.log(`installed: ${have ?? 'no'}${have && running() ? ' (open)' : ''}`);
      console.log(`latest:    ${rel?.version ?? 'unknown (no release yet, or offline)'}`);
      if (have && rel && have !== rel.version) console.log(unchanged(rel) ? `update:    not needed (${rel.version} has the same app)` : 'update:    devdeck desktop update');
      return;
    }
    case 'uninstall':
      if (!installed()) return console.log('the devdeck app isn\'t installed');
      if (running()) await quit();
      rmSync(APP, { recursive: true, force: true });
      return console.log(`removed ${APP}`);
    default:
      fail('usage: devdeck desktop install [--open] | update | status | uninstall');
  }
}

await main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
