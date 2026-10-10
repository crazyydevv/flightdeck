// The live path end to end against a mock Bitget: market loading, the order
// route's server-side re-check, the dry run, and a signed demo order.
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { MOCK_SECRET, startMock } from './mock-bitget';

let mock: Awaited<ReturnType<typeof startMock>>;
let bitget: typeof import('../src/core/bitget');
let order: typeof import('../api/order');

before(async () => {
  mock = await startMock();
  process.env.BITGET_BASE_URL = mock.url; // must be set before the client module loads
  bitget = await import('../src/core/bitget');
  order = await import('../api/order');
});
after(() => mock.server.close());

function post(body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const req = { method: 'POST', body } as unknown as IncomingMessage;
    const out = { statusCode: 200, setHeader() {}, end(text: string) { resolve({ status: out.statusCode, json: JSON.parse(text) }); } };
    const res = out as unknown as ServerResponse;
    void order.default(req, res);
  });
}

test('loadLiveMarket turns Bitget responses into a market state', async () => {
  const m = await bitget.loadLiveMarket();
  assert.equal(m.source, 'live');
  assert.equal(Object.keys(m.instruments).length, 8, 'symbols the exchange does not list are skipped');
  assert.equal(m.instruments.QQQUSDT.etf, true);
  assert.equal(m.instruments.NVDAUSDT.cls, 'rwa');
  assert.equal(m.instruments.BTCUSDT.cls, 'crypto');
  assert.equal(m.instruments.MSTRUSDT.maxLever, 25);
  assert.equal(m.hourly.NVDAUSDT.length, 168);
  assert.equal(m.daily.NVDAUSDT.length, 90);
  assert.equal(m.hourly.NVDAUSDT[167].c, 230.5);
  assert.equal(m.funding.MSTRUSDT, -0.000271);
  assert.ok(Math.abs(m.basis.NVDAUSDT - 0.001) < 1e-4);
});

const plan = (over = {}) => ({ symbol: 'AAPLUSDT', side: 'long', leverage: 3, margin: 200, entry: 341.47, stop: 331, target: 362, horizonH: 24, origin: 'pilot', ...over });

test('order route: stale price is rejected before anything else', async () => {
  const r = await post({ plan: plan({ entry: 300 }) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_price');
});

test('order route: the server refuses what the charter refuses, whatever the client says', async () => {
  const r = await post({ plan: plan({ leverage: 60 }), learnedRules: [] });
  assert.equal(r.status, 200);
  assert.equal(r.json.clearance.decision, 'REFUSED');
  assert.equal(r.json.execution, null);
  assert.equal(mock.orders.length, 0);
});

test('order route: without keys a cleared plan is a dry run that shows the exact order', async () => {
  const r = await post({ plan: plan() });
  assert.equal(r.json.clearance.decision, 'CLEARED', JSON.stringify(r.json.clearance?.findings?.filter((f: any) => !f.ok)));
  assert.equal(r.json.execution.venue, 'paper');
  assert.equal(r.json.execution.dryRun.order.side, 'buy');
  assert.equal(r.json.execution.dryRun.order.presetStopLossPrice, '331.00');
  assert.equal(mock.orders.length, 0);
});

test('order route: with a demo key the order is signed, flagged as demo and placed', async () => {
  Object.assign(process.env, { BITGET_API_KEY: 'k', BITGET_SECRET_KEY: MOCK_SECRET, BITGET_PASSPHRASE: 'p' });
  const r = await post({ plan: plan() });
  assert.equal(r.json.execution.venue, 'bitget-demo');
  assert.equal(r.json.execution.orderId, '1300000000000000001');
  assert.deepEqual(mock.orders.map((o) => String(o.path).split('/').pop()), ['set-leverage', 'place-order']);
  // size rounds down, so the order is never larger than what was cleared
  assert.equal(mock.orders[1].size, (Math.floor((600 / 341.47) * 100) / 100).toFixed(2));
  assert.ok(Number(mock.orders[1].size) * 341.47 <= 600);
  process.env.BITGET_SECRET_KEY = 'wrong';
  const bad = await post({ plan: plan() });
  assert.equal(bad.status, 502);
  assert.match(bad.json.message, /sign/);
  for (const k of ['BITGET_API_KEY', 'BITGET_SECRET_KEY', 'BITGET_PASSPHRASE']) delete process.env[k];
});

test('bring-your-own-key: history is fetched with signed reads and becomes logbook flights', async () => {
  const history = (await import('../api/history')).default;
  const call = (body: unknown) => new Promise<{ status: number; json: any }>((resolve) => {
    const out = { statusCode: 200, setHeader() {}, end(text: string) { resolve({ status: out.statusCode, json: JSON.parse(text) }); } };
    void history({ method: 'POST', body } as unknown as IncomingMessage, out as unknown as ServerResponse);
  });
  assert.equal((await call({ key: 'k' })).status, 400);
  const bad = await call({ key: 'k', secret: 'nope', passphrase: 'p' });
  assert.equal(bad.status, 502);
  assert.match(bad.json.message, /sign/);
  const r = await call({ key: 'k', secret: MOCK_SECRET, passphrase: 'p', demo: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.flights.length, 2);
  assert.equal(r.json.skipped, 1);
  const [nvda, btc] = r.json.flights;
  assert.equal(nvda.leverage, 12, 'leverage comes from the order that opened the position, not an older one');
  assert.equal(nvda.margin, (10 * 230) / 12);
  assert.equal(nvda.pnl, -42.76);
  assert.equal(nvda.stopUnknown, true);
  assert.equal(nvda.cls, 'rwa');
  assert.equal(btc.side, 'short');
  assert.equal(btc.leverage, 4);
});

test('bring-your-own-key: a visitor key places demo orders only', async () => {
  const before = mock.orders.length;
  const r = await post({ plan: plan(), byok: { key: 'k', secret: MOCK_SECRET, passphrase: 'p' } });
  assert.equal(r.json.execution.venue, 'bitget-demo');
  assert.equal(r.json.execution.mode, 'demo');
  assert.equal(mock.orders.length, before + 2);
  process.env.BITGET_TRADING_MODE = 'live';
  const still = await post({ plan: plan(), byok: { key: 'k', secret: MOCK_SECRET, passphrase: 'p' } });
  assert.equal(still.json.execution.mode, 'demo', 'the operator setting does not unlock real money for visitors');
  delete process.env.BITGET_TRADING_MODE;
});
