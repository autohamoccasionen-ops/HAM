import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { QuoteError } from '../quote.mjs';
import { materialCandidate } from '../browser-provider.mjs';

const token = 'unit-test-token-only-not-a-real-secret';
const env = { DSTORE_USERNAME: 'test-user', DSTORE_PASSWORD: 'test-password',
  QUOTE_SERVICE_TOKEN: token, QUOTE_AUTOMATION_ENABLED: 'true' };
const input = { vin: 'W0000000000000000', mileage: 115123, service: 'oel-service', extras: [] };
const source = { vin: input.vin, vehicle: 'Synthetic test vehicle', source: 'D-Store / HaynesPro',
  labourHours: 0.8, labourOperation: 'test-operation', materials: [
    { kind: 'oil', partNumber: 'test-oil', description: 'Test oil', quantity: 9, unitNetCents: 3990, priceBasis: 'retail-ex-vat' },
    { kind: 'filter', partNumber: 'test-filter', description: 'Test filter', quantity: 1, unitNetCents: 4320, priceBasis: 'retail-ex-vat' },
    { kind: 'drain-plug', partNumber: 'test-plug', description: 'Test plug with seal', quantity: 1, unitNetCents: 1346, priceBasis: 'retail-ex-vat' }
  ] };

async function withServer(config, run) {
  const server = http.createServer(createApp(config));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

test('public health is not authentication and does not reveal secrets', async () => {
  await withServer({ env }, async base => {
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    const text = await health.text();
    assert.ok(!text.includes(env.DSTORE_USERNAME));
    assert.ok(!text.includes(env.DSTORE_PASSWORD));
    assert.ok(!text.includes(token));
    assert.equal((await fetch(base + '/api/status')).status, 401);
    assert.equal((await fetch(base + '/api/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  });
});

test('missing credentials and disabled mode cannot produce a quotation', async () => {
  for (const [configuration, code] of [
    [{ QUOTE_SERVICE_TOKEN: token }, 'SERVICE_NOT_CONFIGURED'],
    [{ ...env, QUOTE_AUTOMATION_ENABLED: 'false' }, 'AUTOMATION_NOT_ENABLED']
  ]) {
    let called = false;
    await withServer({ env: configuration, provider: async () => { called = true; return source; } }, async base => {
      const response = await fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(response.status, 503);
      const data = await response.json();
      assert.equal(data.code, code);
      assert.equal(data.status, 'manual-review');
      assert.equal(data.totalCents, undefined);
      assert.equal(called, false);
    });
  }
});

test('complete authenticated contract returns a calculated quote without credentials or purchase prices', async () => {
  const events = [];
  await withServer({ env, provider: async request => { assert.deepEqual(request, input); return source; }, audit: e => events.push(e) }, async base => {
    const response = await fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.totalCents, 57920);
    assert.equal(data.labour.hourlyRateNetCents, 15000);
    assert.ok(!JSON.stringify(data).includes(env.DSTORE_PASSWORD));
    assert.ok(!JSON.stringify(events).includes(input.vin));
    assert.ok(!JSON.stringify(events).includes(env.DSTORE_USERNAME));
  });
});

test('provider errors do not leak account details and do not return fake prices', async () => {
  await withServer({ env, provider: async () => { throw new Error('sensitive upstream details: test-password'); } }, async base => {
    const response = await fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'SOURCE_UNAVAILABLE');
    assert.equal(data.totalCents, undefined);
    assert.ok(!JSON.stringify(data).includes('test-password'));
  });
});

test('failed login is explicit and cannot silently fall back to old prices', async () => {
  await withServer({ env, provider: async () => { throw new QuoteError('AUTHENTICATION_REQUIRED', 'Login required', 503); } }, async base => {
    const response = await fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
    const data = await response.json();
    assert.equal(data.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(data.materials, undefined);
  });
});

test('concurrent requests are rejected instead of starting multiple browsers', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const began = new Promise(resolve => { started = resolve; });
  await withServer({ env, provider: async () => { started(); await gate; return source; } }, async base => {
    const first = fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
    await began;
    try {
      const second = await fetch(base + '/api/quotes', { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).code, 'BUSY');
    } finally { release(); }
    assert.equal((await first).status, 200);
  });
});

test('VIN parts cannot be substituted with universal or multi-pack products', () => {
  const card = 'Artikel Nr.: TEST-1\nELRING\nVerschlussschraube, Ölwanne\nVIN\nmit Dichtring\nbenötigte Stückzahl: 1\nUVPE: 13.46 CHF 9.21 CHF exkl. MwSt.';
  assert.equal(materialCandidate(card, 'drain-plug').unitNetCents, 1346);
  assert.equal(materialCandidate(card.replace('VIN', ''), 'drain-plug'), null);
  assert.equal(materialCandidate(card.replace('Stückzahl: 1', 'Stückzahl: 5'), 'drain-plug'), null);
  assert.equal(materialCandidate(card.replace('mit Dichtring', 'ohne Dichtring'), 'drain-plug'), null);
});
