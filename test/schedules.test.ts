import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterQuiet, nextCron, parseCron, preview } from '../src/schedules.ts';

const at = (s: string) => new Date(s).getTime(); // local time
const after = (expr: string, from: string) => new Date(nextCron(parseCron(expr), at(from))).toString();

test('cron: the next matching minute, in local time', () => {
  assert.equal(after('0 9 * * *', '2026-11-02T08:15'), new Date('2026-11-02T09:00').toString());
  assert.equal(after('0 9 * * *', '2026-11-02T09:00'), new Date('2026-11-03T09:00').toString()); // strictly after
  assert.equal(after('*/15 * * * *', '2026-11-02T10:16:30'), new Date('2026-11-02T10:30').toString());
  assert.equal(after('0 */5 * * *', '2026-11-02T06:00'), new Date('2026-11-02T10:00').toString());
  assert.equal(after('30 18 * * 1-5', '2026-11-06T19:00'), new Date('2026-11-09T18:30').toString()); // Fri evening → Mon
  assert.equal(after('0 0 1 * *', '2026-11-15T00:00'), new Date('2026-12-01T00:00').toString());
  assert.equal(after('0 12 * * 7', '2026-11-02T00:00'), new Date('2026-11-08T12:00').toString()); // 7 is Sunday
  // both days given: either one
  assert.equal(after('0 8 13 * 5', '2026-11-02T00:00'), new Date('2026-11-06T08:00').toString());
  assert.equal(nextCron(parseCron('0 0 30 2 *'), at('2026-11-02T00:00')), 0); // never
});

test('cron: mistakes are explained', () => {
  assert.throws(() => parseCron('0 9 * *'), /five fields/);
  assert.throws(() => parseCron('60 * * * *'), /minute "60" is out of 0–59/);
  assert.throws(() => parseCron('a * * * *'), /isn't a minute/);
});

test('a time on weekdays comes round on those days', () => {
  const [first, second] = preview({ kind: 'time', time: '07:05', days: [1, 3] }).map((t) => new Date(t));
  assert.deepEqual([first.getDay(), first.getHours(), first.getMinutes()], [first.getDay() === 1 ? 1 : 3, 7, 5]);
  assert.notEqual(first.getDay(), second.getDay());
  assert.throws(() => preview({ kind: 'time', time: '07:05', days: [] }), /at least one day/);
});

test('a reset in the quiet hours waits for their end', () => {
  const night = { from: '23:00', to: '07:00' };
  const q = (t: string, quiet = night) => new Date(afterQuiet(at(t), quiet)).toString();
  assert.equal(q('2026-11-02T02:31'), new Date('2026-11-02T07:00').toString());
  assert.equal(q('2026-11-02T23:15'), new Date('2026-11-03T07:00').toString()); // before midnight → the next morning
  assert.equal(q('2026-11-02T07:00'), new Date('2026-11-02T07:00').toString()); // the end itself is fine
  assert.equal(q('2026-11-02T14:20'), new Date('2026-11-02T14:20').toString());
  assert.equal(q('2026-11-02T13:30', { from: '13:00', to: '14:00' }), new Date('2026-11-02T14:00').toString()); // same day
  assert.equal(afterQuiet(at('2026-11-02T02:31')), at('2026-11-02T02:31')); // none set
});
