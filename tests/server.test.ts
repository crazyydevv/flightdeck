// Server duties: the public ledger mirror, pass proofs, the D1 client against a
// real SQL engine, and a Night Watch round that closes a position on the (mock) exchange.
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { takeoff } from '../src/core/flight';
import { INSTRUMENTS, SIM_START, lastPrice, snapshot, viewAsOf } from '../src/core/market';
import { D1Store, MemoryStore, Store } from '../src/core/store';
import { appendEntry } from '../src/core/tower';
import { Flight, LedgerEntry } from '../src/core/types';
import { HOUR } from '../src/core/util';
import { mirror, proof, tickFlight } from '../src/core/watchman';
import { MOCK_SECRET, startMock } from './mock-bitget';

function chain(n: number): LedgerEntry[] {
  let l: LedgerEntry[] = [];
  for (let i = 1; i <= n; i++) l = appendEntry(l, i % 2 ? 'refusal' : 'clearance', `decision ${i}`, { planHash: 'h' + i }, i * 1000);
  return l;
}

async function mirrorSuite(store: Store) {
  const l = chain(5);
  assert.deepEqual(await mirror(store, 'deckone', l.slice(0, 3)), { ok: true, added: 3, tail: 3 });
  assert.deepEqual(await mirror(store, 'deckone', l), { ok: true, added: 2, tail: 5 }, 'resending what is already there is harmless');
  const forged = l.map((e) => (e.seq === 2 ? { ...e, summary: 'cleared, honest' } : e));
  const rewrite = await mirror(store, 'deckone', forged);
  assert.equal(rewrite.ok, false, 'a published entry cannot be replaced');
  const gap = await mirror(store, 'decktwo', l.slice(1));
  assert.equal(gap.ok, false, 'a chain must start at entry 1');
  const tampered = chain(2).map((e) => (e.seq === 2 ? { ...e, body: { planHash: 'evil' } } : e));
  assert.equal((await mirror(store, 'deckthree', tampered)).ok, false, 'a body that does not match its hash is refused');
  assert.equal((await store.ledgerList('deckthree', 10)).length, 1, 'the valid first entry stays, the bad one never lands');

  const p = await proof(store, 'deckone', 4);
  assert.equal(p?.intact, true);
  assert.equal(p?.of, 5);
  assert.equal(p?.entry.summary, 'decision 4');
  assert.equal(await proof(store, 'deckone', 99), null);
  assert.equal((await store.ledgerList('deckone', 2)).map((e) => e.seq).join(), '4,5');

  const f: Flight = { ...takeoff({ symbol: 'NVDAUSDT', side: 'long', leverage: 3, margin: 300, entry: 237, stop: 231, horizonH: 48, origin: 'pilot' }, INSTRUMENTS.NVDAUSDT, 1000), watch: true };
  await store.flightPut('deckone', f);
  await store.flightPut('deckone', { ...f, watchChecks: 3 });
  await store.flightPut('decktwo', { ...f, id: 'FDOTHER', watch: false });
  assert.equal((await store.flightsOf('deckone'))[0].watchChecks, 3, 'put replaces');
  assert.deepEqual((await store.watched()).map((w) => w.flight.id), [f.id], 'only watched, airborne flights');
  await store.flightPut('deckone', { ...f, closedAt: 2000, pnl: 1 });
  assert.equal((await store.watched()).length, 0);
}

test('ledger mirror and flight store: in memory', () => mirrorSuite(new MemoryStore()));

test('ledger mirror and flight store: Cloudflare D1 client against a real SQL engine', async (t) => {
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); } catch { return t.skip('node:sqlite needs Node 22.5 or newer'); }
  const db = new sqlite.DatabaseSync(':memory:');
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, errors: [{ message: 'auth' }] })); }
      try {
        const { sql, params } = JSON.parse(body);
        const stmt = db.prepare(sql);
        const results = /^\s*select/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
        res.end(JSON.stringify({ success: true, result: [{ success: true, results }] }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, errors: [{ message: (e as Error).message }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await mirrorSuite(new D1Store({ accountId: 'acc', databaseId: 'db', token: 'tok', base: `http://localhost:${port}` }));
    await assert.rejects(new D1Store({ accountId: 'acc', databaseId: 'db', token: 'bad', base: `http://localhost:${port}` }).ledgerTail('deckone'), /D1 401/);
  } finally {
    server.close();
  }
});

test('tickFlight replays missed hours in order and stops at the landing', () => {
  const m = snapshot();
  const inst = INSTRUMENTS.TSLAUSDT;
  const entry = lastPrice(viewAsOf(m, SIM_START), 'TSLAUSDT');
  const f: Flight = { ...takeoff({ symbol: 'TSLAUSDT', side: 'long', leverage: 5, margin: 400, entry, stop: +(entry * 0.975).toFixed(2), target: +(entry * 1.06).toFixed(2), horizonH: 72, origin: 'pilot' }, inst, SIM_START), watch: true };
  const half = tickFlight(f, m, SIM_START + 10 * HOUR, 10_000);
  assert.equal(half.flight.cursor, SIM_START + 10 * HOUR);
  assert.equal(half.flight.watchChecks, 10);
  const rest = tickFlight(half.flight, m, SIM_START + 30 * HOUR, 10_000);
  assert.equal(rest.flight.watchChecks, 30, 'no hour is checked twice');
  assert.equal(rest.events.length, 1);
  assert.equal(rest.events[0].rule, 'bleed');
  assert.equal(rest.flight.open, 0.5);
  const again = tickFlight(rest.flight, m, SIM_START + 30 * HOUR, 10_000);
  assert.equal(again.events.length, 0, 'a round with no new bars does nothing');
  const unwatched = tickFlight({ ...f, watch: false }, m, SIM_START + 30 * HOUR, 10_000);
  assert.equal(unwatched.flight.open ?? 1, 1);
});

let mock: Awaited<ReturnType<typeof startMock>>;
before(async () => { mock = await startMock(); });
after(() => mock.server.close());

test('a Night Watch round lands a flight on its runway alarm and closes it on the exchange', async () => {
  Object.assign(process.env, { BITGET_BASE_URL: mock.url, FLIGHTDECK_STORE: 'memory', BITGET_API_KEY: 'k', BITGET_SECRET_KEY: MOCK_SECRET, BITGET_PASSPHRASE: 'p', CRON_SECRET: 'cron' });
  const { storeFromEnv } = await import('../src/core/store');
  const watch = (await import('../api/watch')).default;
  const store = storeFromEnv()!;
  const m = snapshot();
  const shift = Math.floor(Date.now() / HOUR) * HOUR + HOUR - m.asOf; // same shift the mock applies
  const bars = m.hourly.TSLAUSDT;
  const inst = INSTRUMENTS.TSLAUSDT;
  const f: Flight = {
    ...takeoff({ symbol: 'TSLAUSDT', side: 'long', leverage: 5, margin: 400, entry: bars[165].c, stop: 365, horizonH: 72, origin: 'pilot' }, inst, bars[166].t + shift, 'bitget-demo:1'),
    watch: true, liqPrice: 368.5, // close enough to trip the runway alarm, below the hour's low
  };
  await store.flightPut('nightdeck', f);

  const call = (auth?: string) => new Promise<{ status: number; json: any }>((resolve) => {
    const out = { statusCode: 200, setHeader() {}, end(text: string) { resolve({ status: out.statusCode, json: JSON.parse(text) }); } };
    void watch({ method: 'GET', url: '/api/watch', headers: auth ? { authorization: auth } : {} } as unknown as IncomingMessage, out as unknown as ServerResponse);
  });
  assert.equal((await call()).status, 401, 'the round needs the cron secret');
  const r = await call('Bearer cron');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.checked, 1);
  assert.equal(r.json.landed, 1);
  assert.match(r.json.report[0].events[0], /^runway/);
  const closing = mock.orders[mock.orders.length - 1];
  assert.equal(closing.tradeSide, 'close');
  assert.equal(closing.side, 'buy', 'a long is closed with buy + close in hedge mode');
  assert.equal(closing.size, f.qty.toFixed(2));
  const stored = (await store.flightsOf('nightdeck'))[0];
  assert.equal(stored.outcome, 'landed');
  assert.equal((await call('Bearer cron')).json.checked, 0, 'a landed flight is no longer watched');
});
