import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactsIn } from '../src/artifacts.ts';

const use = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, at: string, toolUseResult: unknown, content: unknown = '') =>
  JSON.stringify({ type: 'user', timestamp: at, toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const A = 'https://claude.ai/artifact/AbC123';
const B = 'https://claude.ai/code/artifact/0f0e-11aa';
const D = 'https://claude.ai/artifact/DocXyz';

test('artifacts come from what Claude published, updated, opened or made as a doc; not from reads', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'dd-')), 'conv.jsonl');
  writeFileSync(log, [
    use('1', 'Artifact', { action: 'publish', file_path: 'x.html' }),
    result('1', '2026-10-31T10:00:00Z', { url: A, title: 'First page' }),
    use('2', 'Artifact', { action: 'read', url: B }),
    result('2', '2026-10-31T10:01:00Z', { read: true, url: B, title: 'Someone else’s' }),
    use('3', 'mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', create: { name: 'The plan' } } }),
    result('3', '2026-10-31T10:02:00Z', [{ type: 'text', text: '{}' }], [{ type: 'text', text: `{"link":"${D}"}` }]),
    '',
  ].join('\n'));
  assert.deepEqual(artifactsIn(log).map((a) => [a.url, a.title]), [[A, 'First page'], [D, 'The plan']]);

  // appended later: an update of the first (newer time, same entry) and a half-written line that's finished after
  appendFileSync(log, use('4', 'Artifact', { file_path: 'x.html' }) + '\n' + result('4', '2026-10-31T11:00:00Z', { url: A, title: 'First page v2' }).slice(0, 40));
  assert.equal(artifactsIn(log).length, 2);
  appendFileSync(log, result('4', '2026-10-31T11:00:00Z', { url: A, title: 'First page v2' }).slice(40) + '\n');
  const a = artifactsIn(log).find((x) => x.url === A)!;
  assert.deepEqual([a.title, a.at], ['First page v2', Date.parse('2026-10-31T11:00:00Z')]);
});

test('a log longer than one read piece (4 MB), with characters split across pieces, still gives its artifacts', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'dd-')), 'big.jsonl');
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '✳ ⧉ é '.repeat(2000) }] } });
  writeFileSync(log, `${Array(400).fill(filler).join('\n')}\n${use('9', 'Artifact', { action: 'publish' })}\n${result('9', '2026-10-31T12:00:00Z', { url: B, title: 'After ✳ the filler' })}\n`);
  assert.deepEqual(artifactsIn(log).map((a) => [a.url, a.title]), [[B, 'After ✳ the filler']]);
});
