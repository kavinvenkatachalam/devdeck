import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEnv, tmuxArgs } from '../src/tmux.ts';

// devdeck started without a UTF-8 locale (launchd, the app): tmux then printed the tabs between fields as "_"
test('tmux always runs in UTF-8', () => {
  assert.equal(tmuxArgs('ls')[0], '-u');
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    assert.equal(cleanEnv().LC_CTYPE, 'en_US.UTF-8');
    process.env.LC_ALL = 'C';
    assert.equal(cleanEnv().LC_ALL, undefined);
    delete process.env.LC_ALL;
    process.env.LANG = 'de_DE.UTF-8';
    assert.deepEqual([cleanEnv().LANG, cleanEnv().LC_CTYPE], ['de_DE.UTF-8', undefined]); // one they have is kept
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
