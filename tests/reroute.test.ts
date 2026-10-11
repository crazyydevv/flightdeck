import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionPhase } from '../src/core/calendar';
import { shadowOf, takeoff, unwatchedOf } from '../src/core/flight';
import { sampleLogbook } from '../src/core/logbook';
import { SIM_START, SNAPSHOT_END, lastPrice, snapshot, viewAsOf } from '../src/core/market';
import { liquidationPrice, stopState } from '../src/core/preflight';
import { offerLine, reroute } from '../src/core/reroute';
import { CHARTER, requestClearance } from '../src/core/tower';
import { Flight, FlightPlan } from '../src/core/types';
import { HOUR, prng } from '../src/core/util';
import { tickFlight } from '../src/core/watchman';

const utc = (s: string) => Date.parse(s + 'Z');
const EQ = 10_000;
const m = viewAsOf(snapshot(), SIM_START);
const log = sampleLogbook(EQ);
const draft = (symbol: string, side: 'long' | 'short', leverage: number, margin: number, horizonH: number, over: Partial<FlightPlan> = {}): FlightPlan => {
  const entry = lastPrice(m, symbol), d = side === 'long' ? 1 : -1, place = m.instruments[symbol].pricePlace;
  return { symbol, side, leverage, margin, entry, horizonH, origin: 'pilot', stop: Number((entry * (1 - d * 0.025)).toFixed(place)), target: Number((entry * (1 + d * 0.06)).toFixed(place)), ...over };
};

test('session phases: pre-market, regular, after hours, overnight, weekend, holiday', () => {
  assert.equal(sessionPhase(utc('2026-10-07T13:00:00')), 'pre-market');
  assert.equal(sessionPhase(utc('2026-10-07T14:00:00')), 'regular');
  assert.equal(sessionPhase(utc('2026-10-07T21:00:00')), 'after-hours');
  assert.equal(sessionPhase(utc('2026-10-08T03:00:00')), 'overnight');
  assert.equal(sessionPhase(utc('2026-10-10T15:00:00')), 'weekend');
  assert.equal(sessionPhase(utc('2026-11-26T16:00:00')), 'holiday');
});

test('re-route: the demo plan is refused at 20x and cleared at 5x in one step', () => {
  const plan = draft('NVDAUSDT', 'long', 20, 400, 72);
  const r = reroute(plan, CHARTER, m, SIM_START, EQ, log);
  assert.ok(r.ok);
  assert.equal(r.plan.leverage, 5);
  assert.equal(r.plan.margin, 400);
  assert.equal(r.clearance.decision, 'CLEARED');
  assert.deepEqual(r.changes, ['leverage 20x to 5x']);
  assert.match(offerLine(r, 'NVDA'), /clear NVDA at 5x on 400 USDT/);
});

test('re-route: a plan that already clears comes back untouched', () => {
  const plan = draft('AAPLUSDT', 'long', 3, 300, 24);
  const r = reroute(plan, CHARTER, m, SIM_START, EQ, log);
  assert.ok(r.ok);
  assert.deepEqual(r.plan, plan);
  assert.deepEqual(r.changes, []);
});

test('re-route: a stopless agent order gets a counter-offer with a stop, inside the agent cap', () => {
  const rogue: FlightPlan = { symbol: 'MSTRUSDT', side: 'long', leverage: 25, margin: 2000, entry: lastPrice(m, 'MSTRUSDT'), horizonH: 72, origin: 'agent', agentId: 'momentum-bot-7' };
  assert.equal(requestClearance(rogue, CHARTER, { now: SIM_START, equity: EQ, instrument: m.instruments.MSTRUSDT, logbook: log }).decision, 'REFUSED');
  const r = reroute(rogue, CHARTER, m, SIM_START, EQ, log);
  assert.ok(r.ok);
  assert.ok(r.plan.leverage <= 5, 'agents are capped at 5x');
  assert.equal(r.plan.leverage, Math.floor(r.plan.leverage), 'the offer is a leverage the exchange accepts');
  assert.ok(r.plan.stop !== undefined && r.plan.stop < rogue.entry);
  assert.equal(stopState(r.plan, liquidationPrice(r.plan, m.instruments.MSTRUSDT)), 'valid');
  assert.ok(r.changes.some((c) => c.startsWith('stop added')));
});

test('re-route: it does not pretend size can fix a grounded account', () => {
  const lost: Flight = { ...takeoff(draft('NVDAUSDT', 'long', 3, 300, 24), m.instruments.NVDAUSDT, SIM_START - 5 * HOUR), closedAt: SIM_START - 2 * HOUR, exit: 200, pnl: -700, outcome: 'stopped' };
  const r = reroute(draft('NVDAUSDT', 'long', 3, 300, 24), CHARTER, m, SIM_START, EQ - 700, [lost]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.blockers.includes('Grounded after a bad day'));
});

test('re-route invariant: over random plans, an offer always clears and never raises anything', () => {
  const rnd = prng(20261008);
  const symbols = Object.keys(m.instruments);
  let offers = 0, misses = 0;
  for (let i = 0; i < 160; i++) {
    const symbol = symbols[Math.floor(rnd() * symbols.length)];
    const inst = m.instruments[symbol];
    const side = rnd() < 0.5 ? 'long' : 'short';
    const plan = draft(symbol, side, Math.max(1, Math.round(rnd() * inst.maxLever)), Math.round(50 + rnd() * 3000), [4, 12, 24, 72, 120, 504][Math.floor(rnd() * 6)], {
      origin: rnd() < 0.25 ? 'agent' : 'pilot',
      ...(rnd() < 0.3 ? { stop: undefined } : {}),
      ...(rnd() < 0.2 ? { target: undefined } : {}),
    });
    const r = reroute(plan, CHARTER, m, SIM_START, EQ, log);
    if (!r.ok) { misses++; assert.ok(r.blockers.length > 0); continue; }
    offers++;
    assert.equal(r.clearance.decision, 'CLEARED', `${symbol} ${plan.leverage}x`);
    assert.notEqual(r.report.verdict, 'NO-GO');
    assert.equal(requestClearance(r.plan, CHARTER, { now: SIM_START, equity: EQ, instrument: inst, preflight: r.report, logbook: log }).decision, 'CLEARED');
    assert.ok(r.plan.leverage <= plan.leverage && r.plan.margin <= plan.margin, 'never larger');
    assert.deepEqual([r.plan.symbol, r.plan.side, r.plan.horizonH, r.plan.target, r.plan.entry, r.plan.origin], [plan.symbol, plan.side, plan.horizonH, plan.target, plan.entry, plan.origin]);
    if (stopState(plan, liquidationPrice(plan, inst)) === 'valid' && stopState(plan, liquidationPrice(r.plan, inst)) === 'valid') assert.equal(r.plan.stop, plan.stop, 'a working stop is left alone');
  }
  assert.ok(offers > 100, `${offers} offers, ${misses} without a route`);
});

test('night watch comparison: the BTC scenario, with the watch on and off, on the recorded hours', () => {
  const filed = draft('BTCUSDT', 'long', 50, 400, 72);
  const r = reroute(filed, CHARTER, m, SIM_START, EQ, log);
  assert.ok(r.ok);
  const inst = m.instruments.BTCUSDT;
  const full = { ...snapshot(), earnings: m.earnings };
  let f: Flight = { ...takeoff(r.plan, inst, SIM_START), watch: true, cursor: SIM_START, filed: { leverage: filed.leverage, margin: filed.margin, stop: filed.stop, target: filed.target } };
  let landed = false;
  for (let t = SIM_START + HOUR; t <= SNAPSHOT_END && !landed; t += HOUR) {
    const out = tickFlight(f, full, t, EQ);
    f = out.flight; landed = out.landed;
  }
  assert.ok(landed, 'the flight came down inside the recording');
  assert.ok(f.watchLog?.some((e) => e.action === 'cut-half'), 'Night Watch cut half');
  const off = unwatchedOf(f, full.hourly.BTCUSDT, inst);
  const first = shadowOf(f, full.hourly.BTCUSDT, inst);
  assert.ok(off && first);
  assert.ok((f.pnl as number) > off.pnl, 'the watch lost less than no watch');
  assert.ok(off.pnl > first.pnl, 'and the cleared size lost less than the size first filed');
  console.log(`# BTC scenario: cleared ${r.plan.leverage}x, with watch ${f.outcome} ${(f.pnl as number).toFixed(2)}, watch off ${off.outcome} ${off.pnl.toFixed(2)}, as filed at 50x ${first.outcome} ${first.pnl.toFixed(2)}`);
});

test('night watch comparison is only kept when the watch acted', () => {
  const f: Flight = { ...takeoff(draft('NVDAUSDT', 'long', 5, 400, 72), m.instruments.NVDAUSDT, SIM_START), closedAt: SIM_START + 3 * HOUR, exit: 230, pnl: -10, outcome: 'landed', watchLog: [] };
  assert.equal(unwatchedOf(f, snapshot().hourly.NVDAUSDT, m.instruments.NVDAUSDT), undefined);
});
