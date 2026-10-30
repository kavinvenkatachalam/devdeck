import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refuse } from '../src/access.ts';

const allowed = { port: 4317, tailnet: { host: 'mac.tail1234.ts.net', owner: 'me@example.com' } };

test('the Mac itself gets in, by any local name', () => {
  for (const host of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317', 'localhost'])
    assert.equal(refuse({ host, origin: `http://${host}` }, allowed), null, host);
  assert.equal(refuse({ host: '127.0.0.1:4317' }, allowed), null, 'no Origin: curl, or a same-origin GET');
});

test('DNS rebinding: a page whose own name points at 127.0.0.1 is turned away', () => {
  assert.match(refuse({ host: 'evil.example:4317', origin: 'http://evil.example:4317' }, allowed)!, /doesn't answer/);
});

test('another site open in the browser is turned away', () => {
  assert.match(refuse({ host: '127.0.0.1:4317', origin: 'http://evil.example' }, allowed)!, /cross-origin/);
  assert.match(refuse({ host: '127.0.0.1:4317', origin: 'null' }, allowed)!, /cross-origin/);
});

test('over Tailscale only the Mac owner gets in', () => {
  const host = 'mac.tail1234.ts.net:8444';
  assert.equal(refuse({ host, origin: `https://${host}`, login: 'me@example.com' }, allowed), null);
  assert.equal(refuse({ host, origin: `https://${host}`, login: 'ME@example.com' }, allowed), null, 'logins are case-insensitive');
  assert.match(refuse({ host, origin: `https://${host}`, login: 'someone@example.com' }, allowed)!, /only me@example.com/);
  assert.match(refuse({ host, origin: `https://${host}` }, allowed)!, /only me@example.com/, 'no login header: a tagged device, or Funnel');
});

test("unknown owner (Tailscale status not read yet): tailnet requests wait, local ones don't", () => {
  const unsure = { port: 4317, tailnet: { host: 'mac.tail1234.ts.net' } };
  assert.match(refuse({ host: 'mac.tail1234.ts.net:8444', login: 'me@example.com' }, unsure)!, /can't tell/);
  assert.equal(refuse({ host: 'localhost:4317' }, unsure), null);
});

test('extra names from DEVDECK_HOSTS', () => {
  assert.equal(refuse({ host: '192.168.1.5:4317' }, { ...allowed, extraHosts: ['192.168.1.5:4317'] }), null);
  assert.notEqual(refuse({ host: '192.168.1.5:4317' }, allowed), null);
});
