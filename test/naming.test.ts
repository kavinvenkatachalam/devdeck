// Names that must match tj's (so worktrees tj set up are recognised) and must not collide.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { setKeys } from '../src/envfile.ts';
import { summarize } from '../src/prs.ts';
import { dbKey, dbNames, slugHash } from '../src/repo.ts';

test('slugHash hashes like `git hash-object`, as tj does', () => {
  for (const branch of ['main', 'feat/custom-component', 'fix/ünïcode-ß']) {
    const git = execFileSync('git', ['hash-object', '--stdin'], { input: branch }).toString().trim().slice(0, 6);
    assert.equal(slugHash(branch).slice(-6), git, branch);
  }
  assert.equal(slugHash('Feat/Big-Thing'), `feat_big_thing_${slugHash('Feat/Big-Thing').slice(-6)}`);
});

test('a branch names its databases', () => {
  const n = dbNames(dbKey({ branch: 'feat/x', root: '/w/.worktrees/a' }));
  assert.match(n.dev, /^tooljet_feat_x_[0-9a-f]{6}$/);
  assert.match(n.tjdbDev, /^tooljet_db_feat_x_[0-9a-f]{6}$/);
});

test('two detached worktrees get different databases', () => {
  const a = dbNames(dbKey({ branch: '', root: '/w/.worktrees/one' }));
  const b = dbNames(dbKey({ branch: '', root: '/w/.worktrees/two' }));
  assert.notEqual(a.dev, b.dev);
  assert.notEqual(a.tjdbDev, b.tjdbDev);
});

test('.env keys are replaced in place, comments and order kept, new ones appended', () => {
  const before = '# db\nPG_DB=tooljet_development\nexport PORT=3000\n\nREDIS_HOST=localhost\n';
  assert.equal(setKeys(before, { PORT: '3010', PG_DB: 'tooljet_x', TOOLJET_HOST: 'http://localhost:8092' }),
    '# db\nPG_DB=tooljet_x\nPORT=3010\n\nREDIS_HOST=localhost\nTOOLJET_HOST=http://localhost:8092\n');
});

test('PR checks: the latest run of each check counts', () => {
  const run = (name: string, startedAt: string, conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', workflowName: 'CI', name, startedAt, status, conclusion, detailsUrl: `https://ci/${name}` });
  const out = summarize([
    run('lint', '2026-10-01T10:00:00Z', 'FAILURE'),
    run('lint', '2026-10-01T11:00:00Z', 'SUCCESS'), // re-run passed
    run('unit', '2026-10-01T11:00:00Z', 'FAILURE'),
    run('e2e', '2026-10-01T11:00:00Z', '', 'IN_PROGRESS'),
    run('docs', '2026-10-01T11:00:00Z', 'SKIPPED'),
    { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS', targetUrl: 'https://v' },
  ]);
  assert.deepEqual(out, { passed: 2, failed: 1, pending: 1, failing: [{ name: 'unit', url: 'https://ci/unit' }] });
});
