import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INSTRUMENTS, lastPrice, snapshot } from '../src/core/market';
import { preflight } from '../src/core/preflight';
import { reroute } from '../src/core/reroute';
import { CHARTER } from '../src/core/tower';
import { FlightPlan } from '../src/core/types';
import { DAY, HOUR } from '../src/core/util';
import { DAILY_HISTORY_START } from '../research/history-daily';
import { HISTORY_START } from '../research/history-hourly';
import { LOOKBACK_D, LOOKBACK_H, dailyFromHourly, parseDailyHistory, parseHistory, studyMarket, viewAt } from '../research/lib';
import { SCENARIOS, WARM_UP_H, runSymbol } from '../research/run';

const SYMBOLS = Object.keys(INSTRUMENTS);

test('study data: 800 hourly bars per contract, continuous, joined to the app snapshot', () => {
  const snap = snapshot();
  for (const sym of SYMBOLS) {
    const bars = parseHistory(sym);
    assert.equal(bars.length, 800, sym);
    assert.equal(bars[0].t, HISTORY_START);
    bars.forEach((c, i) => {
      assert.ok([c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0), `${sym} bar ${i} is a number`);
      assert.ok(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c), `${sym} bar ${i}: the range holds the open and the close`);
      if (i) assert.equal(c.t - bars[i - 1].t, HOUR);
    });
    // the last recorded hour ends where the app's own snapshot begins, at the same price
    assert.equal(bars[799].t + HOUR, snap.hourly[sym][0].t, `${sym} joins in time`);
    assert.equal(bars[799].c, snap.hourly[sym][0].o, `${sym} joins in price`);
  }
});

test('study data: daily bars are continuous and hand over to the hourly bars at the same price', () => {
  const full = studyMarket();
  for (const sym of SYMBOLS) {
    const recorded = parseDailyHistory(sym);
    assert.equal(recorded.length, 90, sym);
    assert.equal(recorded[0].t, DAILY_HISTORY_START);
    recorded.forEach((c, i) => assert.ok(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c), `${sym} day ${i} range`));
    const daily = full.daily[sym];
    assert.equal(daily.length, 130, sym);
    daily.forEach((c, i) => { if (i) { assert.equal(c.t - daily[i - 1].t, DAY); assert.equal(c.o, daily[i - 1].c, `${sym} day ${i} opens at the previous close`); } });
    assert.equal(full.hourly[sym].length, 968);
  }
});

test('study data: daily bars built from hourly bars equal the daily bars Bitget printed', () => {
  // Two independent recordings of the same days: the app's daily snapshot (one
  // API call per contract) and the hourly bars (five calls per contract). If a
  // number had been miscopied in either, the two would disagree.
  const full = studyMarket(), snap = snapshot();
  let compared = 0;
  for (const sym of SYMBOLS) {
    const built = new Map(dailyFromHourly(full.hourly[sym], DAILY_HISTORY_START + 90 * DAY).map((c) => [c.t, c]));
    for (const d of snap.daily[sym]) {
      const b = built.get(d.t);
      if (!b) continue;
      assert.deepEqual([b.o, b.h, b.l, b.c], [d.o, d.h, d.l, d.c], `${sym} ${new Date(d.t).toISOString().slice(0, 10)}`);
      compared++;
    }
  }
  assert.ok(compared >= 300, `${compared} days compared`);
});

test('study: the engines are only ever shown bars that had already closed', () => {
  const full = studyMarket();
  for (const i of [WARM_UP_H, 400, 777, 943]) {
    const now = full.hourly.NVDAUSDT[i].t;
    const view = viewAt(full, now);
    for (const sym of SYMBOLS) {
      assert.ok(view.hourly[sym].every((c) => c.t + HOUR <= now), `${sym} hourly at ${i}`);
      assert.ok(view.daily[sym].every((c) => c.t + DAY <= now), `${sym} daily at ${i}`);
      assert.ok(view.hourly[sym].length <= LOOKBACK_H && view.daily[sym].length <= LOOKBACK_D);
      // the newest bar it does show is the one that closed at `now`
      assert.equal(view.hourly[sym][view.hourly[sym].length - 1].t + HOUR, now);
    }
    assert.deepEqual(view.funding, {});
  }
});

test('study: rewriting every bar after the entry changes nothing the engines say', () => {
  // The strongest form of the no-look-ahead check. If any engine read a later
  // bar, however indirectly, wrecking those bars would change its answer.
  const full = studyMarket();
  for (const sym of ['NVDAUSDT', 'MSTRUSDT', 'BTCUSDT']) {
    const inst = full.instruments[sym];
    for (const i of [WARM_UP_H, 500, 668, 900]) {
      const now = full.hourly[sym][i].t;
      const wrecked = {
        ...full,
        hourly: Object.fromEntries(Object.entries(full.hourly).map(([k, v]) => [k, v.map((c) => (c.t + HOUR <= now ? c : { ...c, o: c.o * 1.4, h: c.h * 2, l: c.l * 0.5, c: c.c * 0.7 }))])),
        daily: Object.fromEntries(Object.entries(full.daily).map(([k, v]) => [k, v.map((c) => (c.t + DAY <= now ? c : { ...c, o: c.o * 1.4, h: c.h * 2, l: c.l * 0.5, c: c.c * 0.7 }))])),
      };
      const a = viewAt(full, now), b = viewAt(wrecked, now);
      const entry = lastPrice(a, sym);
      assert.equal(lastPrice(b, sym), entry);
      for (const side of ['long', 'short'] as const) {
        const d = side === 'long' ? 1 : -1;
        const plan: FlightPlan = { symbol: sym, side, leverage: 20, margin: 400, entry, stop: Number((entry * (1 - d * 0.025)).toFixed(inst.pricePlace)), target: Number((entry * (1 + d * 0.06)).toFixed(inst.pricePlace)), horizonH: 24, origin: 'pilot' };
        assert.deepEqual(preflight(plan, b, now, 10_000), preflight(plan, a, now, 10_000), `${sym} ${side} preflight at ${i}`);
        assert.deepEqual(reroute(plan, CHARTER, b, now, 10_000, []), reroute(plan, CHARTER, a, now, 10_000, []), `${sym} ${side} re-route at ${i}`);
      }
    }
  }
});

test('study: a slice runs the same twice, and a re-route never raises anything', () => {
  const full = studyMarket();
  // twelve entry hours on two contracts is enough to exercise every code path
  const slice = { ...full, hourly: Object.fromEntries(Object.entries(full.hourly).map(([k, v]) => [k, v.slice(0, WARM_UP_H + 24 + 11)])) };
  for (const sym of ['TSLAUSDT', 'BTCUSDT']) {
    const a = runSymbol(SCENARIOS.day, sym, slice, false);
    const b = runSymbol(SCENARIOS.day, sym, slice, false);
    assert.deepEqual(a, b, `${sym} is deterministic`);
    assert.equal(a.length, 12 * 2 * 3);
    for (const t of a) {
      assert.ok(t.a[0] >= -400 - 1e-9, 'an isolated position cannot lose more than its margin');
      if (!t.b) continue;
      assert.ok(t.bLev <= t.lev && t.bMargin <= 400, 'leverage and margin only go down');
      assert.ok(t.b[0] >= -400 - 1e-9 && (t.c as [number, string])[0] >= -400 - 1e-9);
    }
  }
  const naked = runSymbol(SCENARIOS.naked, 'TSLAUSDT', slice, false);
  assert.ok(naked.filter((t) => t.b).every((t) => t.bStopAdded), 'a plan filed without a stop only clears with one added');
});
