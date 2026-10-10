// The Netlify entry point: one function that receives every /api/* request and
// hands it to the same handlers Vercel runs. Tested with Netlify-shaped events.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { appendEntry } from '../src/core/tower';
import { startMock } from './mock-bitget';

let mock: Awaited<ReturnType<typeof startMock>>;
let api: typeof import('../netlify/api');

before(async () => {
  mock = await startMock();
  process.env.BITGET_BASE_URL = mock.url; // must be set before the client module loads
  process.env.FLIGHTDECK_STORE = 'memory';
  delete process.env.BITGET_API_KEY;
  api = await import('../netlify/api');
});
after(() => mock.server.close());

const get = (path: string, query: Record<string, string> = {}) =>
  api.handler({ httpMethod: 'GET', path, queryStringParameters: query, headers: { Accept: 'application/json' }, body: null });
const post = (path: string, body: unknown, extra: Partial<Parameters<typeof api.handler>[0]> = {}) =>
  api.handler({ httpMethod: 'POST', path, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });

test('netlify: status answers on the public path and on the function path', async () => {
  for (const path of ['/api/status', '/.netlify/functions/api/status', '/api/status/']) {
    const r = await get(path);
    assert.equal(r.statusCode, 200, path);
    assert.match(r.headers['Content-Type'], /application\/json/);
    assert.equal(JSON.parse(r.body).storage, 'memory');
  }
});

test('netlify: unknown routes are a 404, and prototype names are not routes', async () => {
  assert.equal((await get('/api/nope')).statusCode, 404);
  assert.equal((await get('/api/constructor')).statusCode, 404);
  assert.equal((await get('/api/')).statusCode, 404);
});

test('netlify: the market route loads live data through the adapter', async () => {
  const r = await get('/api/market');
  assert.equal(r.statusCode, 200);
  const m = JSON.parse(r.body);
  assert.equal(m.source, 'live');
  assert.equal(m.hourly.NVDAUSDT.length, 168);
});

test('netlify: a posted plan is re-checked by the server; base64 bodies and empty bodies are handled', async () => {
  const plan = { symbol: 'AAPLUSDT', side: 'long', leverage: 3, margin: 200, entry: 341.47, stop: 331, target: 362, horizonH: 24, origin: 'pilot' };
  const ok = await post('/api/order', { plan });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).clearance.decision, 'CLEARED');
  assert.equal(JSON.parse(ok.body).execution.venue, 'paper', 'no key, so a dry run');

  const hot = await post('/api/order', {}, { body: Buffer.from(JSON.stringify({ plan: { ...plan, leverage: 40 } })).toString('base64'), isBase64Encoded: true });
  assert.equal(JSON.parse(hot.body).clearance.decision, 'REFUSED');

  const empty = await api.handler({ httpMethod: 'POST', path: '/api/order', headers: {}, body: '' });
  assert.ok(empty.statusCode >= 400, 'an empty body is an error, not a crash');
  assert.equal((await get('/api/order')).statusCode, 405);
});

test('netlify: ledger mirror and pass link work through query strings', async () => {
  const deck = 'netlifydeck1';
  const entries = appendEntry([], 'clearance', 'Cleared: test', { plan: { symbol: 'NVDAUSDT' }, decision: 'CLEARED' }, 1_790_000_000_000);
  const w = await post('/api/ledger', { deck, entries });
  assert.equal(w.statusCode, 200, w.body);
  const r = await get('/api/ledger', { deck });
  assert.equal(JSON.parse(r.body).entries.length, 1);
  const p = await api.handler({ httpMethod: 'GET', path: '/api/pass', rawQuery: `deck=${deck}&seq=1`, headers: {}, body: null });
  assert.equal(JSON.parse(p.body).intact, true);
});

test('netlify: the Night Watch route honours the cron secret from a lower- or upper-case header', async () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal((await get('/api/watch')).statusCode, 401);
  const r = await api.handler({ httpMethod: 'GET', path: '/api/watch', headers: { Authorization: 'Bearer s3cret' }, body: null });
  assert.equal(r.statusCode, 200, r.body);
  delete process.env.CRON_SECRET;
});
