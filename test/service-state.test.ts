// "Running" must mean the port answers: a server devdeck started that's alive with its port closed (still building, or
// a Nest watch server stuck on a compile error) is "starting", not running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'devdeck-state-')); // before state.ts reads it
const { serviceState } = await import('../src/devenv.ts');
const { procStart } = await import('../src/sh.ts');
const { clearRun, saveRun } = await import('../src/state.ts');

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

const root = mkdtempSync(join(tmpdir(), 'devdeck-checkout-'));
const port = await freePort();
writeFileSync(join(root, '.env'), `PORT=${port}\n`);
const repo = { root, main: root, isWorktree: false, branch: 'main', tooljet: true };

const server = spawn('sleep', ['60'], { stdio: 'ignore' }); // stands in for `npm run start:dev`
after(() => server.kill());

test('nothing started: stopped', async () => {
  clearRun(root, 'server');
  assert.equal((await serviceState(repo, 'server')).state, 'stopped');
});

test('started by devdeck, port not open: starting', async () => {
  saveRun(root, 'server', { pid: server.pid!, procStart: await procStart(server.pid!), port, startedAt: new Date().toISOString(), log: '' });
  assert.equal((await serviceState(repo, 'server')).state, 'starting');
});

test('started by devdeck, port open: running', async () => {
  const listener = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  try {
    assert.equal((await serviceState(repo, 'server')).state, 'running');
  } finally {
    await new Promise((r) => listener.close(r));
  }
});
