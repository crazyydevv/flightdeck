import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { INSTRUMENTS, snapshot } from '../src/core/market';
import { Candle } from '../src/core/types';
import { HOUR, prng } from '../src/core/util';
import { forwardTrades, render } from '../research/forward';
import { update } from '../research/forward-fetch';
import { readForward } from '../research/lib';

// A stand-in for Bitget's history-candles: 80 invented hours that continue from
// the last recorded close of each contract. It answers like the real endpoint
// (bars that opened before endTime, at most `limit` of them) but never more
// than 25 at a time, so the fetcher has to page.
const START = snapshot().asOf;
function future(symbol: string, broken = false): Candle[] {
  const rnd = prng(symbol.charCodeAt(0) * 7919 + symbol.length);
  const bars = snapshot().hourly[symbol];
  let px = bars[bars.length - 1].c;
  return Array.from({ length: 80 }, (_, i) => {
    const o = px, c = Number((o * (1 + (rnd() - 0.5) * 0.02)).toFixed(INSTRUMENTS[symbol].pricePlace));
    px = c;
    return { t: START + (broken && i >= 40 ? i + 1 : i) * HOUR, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c };
  });
}
function serve(broken = false): Promise<{ url: string; close: () => void; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    calls++;
    const end = Number(u.searchParams.get('endTime')), limit = Math.min(25, Number(u.searchParams.get('limit')));
    const rows = future(u.searchParams.get('symbol') as string, broken).filter((c) => c.t < end).slice(-limit);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: '00000', msg: 'success', data: rows.map((c) => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), '1', '1']) }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${(server.address() as { port: number }).port}`, close: () => server.close(), calls: () => calls })));
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-forward-')), 'forward-hourly.json');

test('forward test: new hours are fetched in pages, appended, and only closed bars are kept', async () => {
  const mock = await serve(), file = tmp();
  try {
    // 30 and a half hours after the freeze: 30 bars have closed
    const first = await update(START + 30.5 * HOUR, mock.url, file);
    assert.deepEqual(first, { added: 30, hours: 30 });
    assert.ok(mock.calls() >= 16, 'more than one page per contract');
    // a later run appends only what is new
    const second = await update(START + 50 * HOUR, mock.url, file);
    assert.deepEqual(second, { added: 20, hours: 50 });
    const store = readForward(file);
    for (const sym of Object.keys(INSTRUMENTS)) {
      const want = future(sym).slice(0, 50);
      assert.equal(store.bars[sym].length, 50, sym);
      assert.deepEqual(store.bars[sym][0], [want[0].o, want[0].h, want[0].l, want[0].c]);
      assert.equal(store.bars[sym][49][3], want[49].c);
    }
    // running again with nothing new changes nothing
    assert.deepEqual(await update(START + 50 * HOUR, mock.url, file), { added: 0, hours: 50 });
  } finally { mock.close(); }
});

test('forward test: a response with a missing hour is refused and nothing is written', async () => {
  const mock = await serve(true), file = tmp();
  try {
    await assert.rejects(update(START + 60 * HOUR, mock.url, file), /expected 2026-10-/);
    assert.equal(fs.existsSync(file), false);
  } finally { mock.close(); }
});

test('forward test: plans are flown only on hours after the freeze, and the score is written', async () => {
  const mock = await serve(), file = tmp();
  try {
    await update(START + 27 * HOUR, mock.url, file);
    const { trades, hours, through } = forwardTrades(file, ['BTCUSDT']);
    assert.equal(hours, 27);
    assert.equal(through, START + 27 * HOUR);
    // entries from 23 hours before the freeze (the first whose 24-hour flight crosses it) to 3 hours after: 27 hours, 6 plans each
    assert.equal(trades.length, 27 * 6);
    assert.equal(Math.min(...trades.map((t) => t.t)), START - 23 * HOUR);
    assert.equal(Math.max(...trades.map((t) => t.t)), START + 3 * HOUR);
    const { md, rows } = render(trades, hours, through);
    assert.equal(rows[0].plans, 162);
    assert.match(md, /All forward hours \| 27 \| 162/);
    assert.match(render([], 0, START).md, /No forward results yet/);
  } finally { mock.close(); }
});
