// The status dots read Claude's / Codex's screen (and Claude's hooks when set up). These screens are written the way
// the TUIs draw them; when a new Claude version changes its screen, add the new one here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, readAgent, readScreen, turnsEnded } from '../src/tmux.ts';

const RULE = '─'.repeat(60);
const box = (above: string[]) => [...above, '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');

const IDLE = box(['⏺ Done. The tests pass.', '', '✻ Cooked for 3m 2s']);
const WORKING = box(['⏺ Reading the file', '', '✢ Doodling… (2m 11s · ↓ 3.2k tokens · esc to interrupt)', '  ⎿  Tip: press ⇧Tab to switch modes']);
// the conversation quotes the phrases the screen check looks for; only the line over the input box counts
const QUOTING = box(['⏺ The UI shows "esc to interrupt" and asks "Do you want to proceed?" while it waits.', '', '✻ Baked for 12s']);
const INTERRUPTED = box(['⏺ Bash(npm test)', '  ⎿  Interrupted · What should Claude do instead?']);
const PERMISSION = [
  '╭' + '─'.repeat(50) + '╮',
  '│ Bash command                                     │',
  '│   npm test                                       │',
  '│ Do you want to proceed?                          │',
  '│ ❯ 1. Yes                                         │',
  "│   2. Yes, and don't ask again for npm commands   │",
  '│   3. No, and tell Claude what to do differently  │',
  '╰' + '─'.repeat(50) + '╯',
].join('\n');
const CODEX_WORKING = ['› fix the flaky test', '', '• Working (12s • esc to interrupt)'].join('\n');
const CODEX_ASKING = ['Would you like to run the following command?', '  $ npm test', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)'].join('\n');

test('Claude idle, working, and a conversation that quotes the trigger phrases', () => {
  assert.deepEqual(readAgent(IDLE), { agent: 'idle' });
  assert.deepEqual(readAgent(WORKING), { agent: 'working' });
  assert.deepEqual(readAgent(QUOTING), { agent: 'idle' });
});

test('a permission prompt is waiting, with its numbered options', () => {
  assert.deepEqual(readAgent(PERMISSION), { agent: 'waiting', choices: ['Yes', "Yes, and don't ask again for npm commands", 'No, and tell Claude what to do differently'] });
});

test('Codex working and asking', () => {
  assert.deepEqual(readAgent(CODEX_WORKING), { agent: 'working' });
  assert.deepEqual(readAgent(CODEX_ASKING), { agent: 'waiting', choices: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'] });
});

test('readScreen tells whether the input box is up and whether the last turn was interrupted', () => {
  assert.deepEqual(readScreen(IDLE), { agent: 'idle', box: true, interrupted: false });
  assert.deepEqual(readScreen(INTERRUPTED), { agent: 'idle', box: true, interrupted: true });
  assert.equal(readScreen(PERMISSION).box, false);
});

test('without hooks the screen decides', () => {
  assert.deepEqual(combine(undefined, readScreen(WORKING)), { agent: 'working' });
  assert.deepEqual(combine(undefined, readScreen(IDLE)), { agent: 'idle' });
});

test('hooks decide working / idle, even when the screen reads otherwise', () => {
  // e.g. a Claude version whose spinner line the screen check doesn't know yet
  assert.deepEqual(combine('working', readScreen(IDLE)), { agent: 'working' });
  assert.deepEqual(combine('idle', readScreen(IDLE)), { agent: 'idle' });
});

test('a prompt on screen wins over the hooks, and keeps its options', () => {
  assert.deepEqual(combine('working', readScreen(PERMISSION)).agent, 'waiting');
  assert.equal(combine('working', readScreen(PERMISSION)).choices?.length, 3);
});

test('hooks say waiting but no prompt could be read: still waiting', () => {
  assert.deepEqual(combine('waiting', readScreen('some prompt the screen check does not know')), { agent: 'waiting', choices: [] });
});

test('the screen corrects what hooks miss: Esc on a prompt, Esc during a turn', () => {
  // permission prompt cancelled: no hook runs, the input box is back
  assert.deepEqual(combine('waiting', readScreen(IDLE)), { agent: 'idle' });
  // turn interrupted: Stop doesn't run, "Interrupted" sits over the input box
  assert.deepEqual(combine('working', readScreen(INTERRUPTED)), { agent: 'idle' });
});

test('a turn ends when an agent goes from working to idle or waiting, once', () => {
  const at = (agent?: 'working' | 'idle' | 'waiting') => [{ name: 'zz-turn', path: '/x', created: 0, activity: 0, folder: '', order: 0, tabs: [{ id: '@1', pane: '%1', panes: 1, index: 0, program: 'claude', busy: true, active: true, agent }] }];
  assert.equal(turnsEnded(at('idle')).size, 0);
  assert.equal(turnsEnded(at('working')).size, 0);
  assert.equal(turnsEnded(at('working')).size, 0, 'still working');
  assert.deepEqual([...turnsEnded(at('idle'))], ['zz-turn']);
  assert.equal(turnsEnded(at('idle')).size, 0, 'only the moment it ends');
  turnsEnded(at('working'));
  assert.deepEqual([...turnsEnded(at('waiting'))], ['zz-turn'], 'stopping to ask you counts too');
});
