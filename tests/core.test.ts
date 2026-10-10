import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';

import { autopsy, adopt, counterfactual, covered } from '../src/core/blackbox';
import { sign } from '../src/core/bitget';
import { isUsOpen, lastUsClose, nextUsOpen, opensBetween } from '../src/core/calendar';
import { crewPrompt, parseCrewReply, ruleBriefs } from '../src/core/crew';
import { afterClose, earningsCalendar } from '../src/core/earnings';
import { cut, land, logbookCsv, shadowOf, stepFlight, takeoff, unrealised } from '../src/core/flight';
import { assess, debrief, decide, guard, parseWatchReply, watchTick } from '../src/core/nightwatch';
import { importCsv, sampleLogbook } from '../src/core/logbook';
import { INSTRUMENTS, SIM_START, SNAPSHOT_END, lastPrice, snapshot, viewAsOf } from '../src/core/market';
import { parseThesis } from '../src/core/parse';
import { liquidationPrice, planHash, preflight } from '../src/core/preflight';
import { scan } from '../src/core/radar';
import { CHARTER, appendEntry, requestClearance, rulesHash, squawk, verifyLedger } from '../src/core/tower';
import { FlightPlan, LedgerEntry } from '../src/core/types';
import { canonical, HOUR, prng, sha256 } from '../src/core/util';

const utc = (s: string) => Date.parse(s + 'Z');
const market = () => viewAsOf(snapshot(), SIM_START);
const nvda = (over: Partial<FlightPlan> = {}): FlightPlan => ({
  symbol: 'NVDAUSDT', side: 'long', leverage: 3, margin: 300, entry: lastPrice(market(), 'NVDAUSDT'),
  stop: 233, target: 252, horizonH: 48, origin: 'pilot', ...over,
});

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'FLIGHTDECK', 'é漢字🙂', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)]) {
    assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'));
  }
});

test('canonical JSON ignores key order and undefined', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), canonical({ a: [2, { d: 1 }], b: 1 }));
});

test('US session clock, including the DST change and a holiday', () => {
  assert.equal(isUsOpen(utc('2026-10-07T14:00:00')), true);
  assert.equal(isUsOpen(utc('2026-10-07T12:00:00')), false);
  assert.equal(isUsOpen(utc('2026-10-10T15:00:00')), false, 'Saturday');
  assert.equal(lastUsClose(utc('2026-10-07T12:00:00')), utc('2026-10-06T20:00:00'));
  assert.equal(nextUsOpen(utc('2026-10-07T12:00:00')), utc('2026-10-07T13:30:00'));
  assert.equal(nextUsOpen(utc('2026-10-07T13:00:00')), utc('2026-10-07T13:30:00'), 'half an hour before the bell');
  assert.equal(nextUsOpen(utc('2026-10-07T15:00:00')), utc('2026-10-08T13:30:00'), 'mid-session looks to tomorrow');
  assert.equal(nextUsOpen(utc('2026-10-09T20:00:00')), utc('2026-10-12T13:30:00'), 'Friday close to Monday open');
  assert.equal(lastUsClose(utc('2026-10-05T03:00:00')), utc('2026-10-02T20:00:00'), 'Monday pre-open looks back over the weekend');
  assert.equal(isUsOpen(utc('2026-11-02T14:00:00')), false, 'after DST ends the bell is 14:30 UTC');
  assert.equal(isUsOpen(utc('2026-11-02T14:30:00')), true);
  assert.equal(isUsOpen(utc('2026-11-26T16:00:00')), false, 'Thanksgiving');
  assert.equal(opensBetween(utc('2026-10-09T21:00:00'), utc('2026-10-12T21:00:00')), 1, 'a weekend hold crosses one bell');
});

test('recorded snapshot is well-formed', () => {
  const m = snapshot();
  assert.equal(Object.keys(m.hourly).length, 8);
  for (const sym of Object.keys(m.hourly)) {
    assert.equal(m.hourly[sym].length, 168, sym);
    assert.equal(m.daily[sym].length, ({ QQQUSDT: 89, MSTRUSDT: 91, BTCUSDT: 107 } as Record<string, number>)[sym] ?? 90, sym);
    for (const series of [m.hourly[sym], m.daily[sym]]) {
      series.forEach((c, i) => {
        assert.ok(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c), `${sym} bar ${i} range`);
        assert.ok(c.l > 0 && Number.isFinite(c.h));
        if (i) assert.ok(Math.abs(c.o / series[i - 1].c - 1) < 0.05, `${sym} bar ${i} is continuous`);
      });
    }
  }
  assert.equal(m.hourly.NVDAUSDT[167].c, 230.5);
  assert.equal(m.hourly.NVDAUSDT[167].t + HOUR, SNAPSHOT_END);
});

test('viewAsOf never shows a bar that had not closed', () => {
  const m = market();
  for (const sym of Object.keys(m.hourly)) {
    assert.ok(m.hourly[sym].every((c) => c.t + HOUR <= SIM_START));
    assert.ok(m.daily[sym].every((c) => c.t + 24 * HOUR <= SIM_START));
  }
  assert.equal(m.hourly.NVDAUSDT.length, 138);
});

test('radar scans every instrument and separates sessions', () => {
  const contacts = scan(market(), SIM_START);
  assert.equal(contacts.length, 8);
  for (const c of contacts) {
    assert.ok(Number.isFinite(c.z) && Number.isFinite(c.drift), c.symbol);
    assert.equal(c.session, INSTRUMENTS[c.symbol].cls === 'rwa' ? 'closed' : 'always');
    assert.ok(c.note.length > 20);
  }
  const mstr = contacts.find((c) => c.symbol === 'MSTRUSDT');
  assert.ok(mstr?.beta !== undefined && mstr.beta > 0.5, 'MSTR tracks BTC');
  const nvdaC = contacts.find((c) => c.symbol === 'NVDAUSDT');
  assert.ok(nvdaC?.beta !== undefined && nvdaC.beta > 0.5 && nvdaC.zResid !== undefined, 'NVDA is measured against the Nasdaq 100');
  assert.ok(Math.abs(nvdaC.zResid as number) < Math.abs(nvdaC.z), 'most of that NVDA move was the index');
  assert.equal(contacts.find((c) => c.symbol === 'QQQUSDT')?.beta, undefined, 'the benchmark has no benchmark');
  assert.deepEqual(contacts.map((c) => c.score), [...contacts.map((c) => c.score)].sort((a, b) => b - a));
});

test('liquidation price formula', () => {
  const inst = INSTRUMENTS.NVDAUSDT;
  assert.ok(Math.abs(liquidationPrice(nvda({ entry: 200, leverage: 10 }), inst) - 200 * (1 - 0.1 + 0.005)) < 1e-9);
  assert.ok(Math.abs(liquidationPrice(nvda({ entry: 200, leverage: 10, side: 'short' }), inst) - 200 * (1 + 0.1 - 0.005)) < 1e-9);
});

test('preflight is deterministic and refuses the reckless plan', () => {
  const m = market();
  const wild = nvda({ leverage: 100, stop: undefined, target: undefined });
  const a = preflight(wild, m, SIM_START, 10_000);
  const b = preflight(wild, m, SIM_START, 10_000);
  assert.deepEqual(a, b);
  assert.equal(a.verdict, 'NO-GO');
  assert.equal(a.guidance.fixable, false, 'no size fixes a missing stop');
  assert.ok(a.guidance.blockers.includes('Stop integrity'));
  assert.equal(a.checks.length, 8);
});

test('preflight finds the size that survives, and that size really passes', () => {
  const m = market();
  const entry = lastPrice(m, 'NVDAUSDT');
  const hot = nvda({ leverage: 40, stop: entry * 0.985, target: entry * 1.05 });
  const r = preflight(hot, m, SIM_START, 10_000);
  assert.equal(r.verdict, 'NO-GO');
  assert.equal(r.guidance.fixable, true);
  assert.ok(r.guidance.leverage < 40 && r.guidance.leverage >= 1);
  const again = preflight({ ...hot, leverage: r.guidance.leverage, margin: r.guidance.margin }, m, SIM_START, 10_000);
  assert.notEqual(again.verdict, 'NO-GO');
  assert.equal(r.guidance.leverage, Math.floor(r.guidance.leverage), 'a whole number, which is what the exchange accepts');
  // and one notch more would fail, so the guidance is the largest survivable whole-number size
  const more = preflight({ ...hot, leverage: Math.min(40, r.guidance.leverage + 1) }, m, SIM_START, 10_000);
  assert.equal(more.verdict, 'NO-GO');
});

test('less leverage never fails more checks', () => {
  const m = market();
  for (const sym of ['NVDAUSDT', 'TSLAUSDT', 'MSTRUSDT', 'BTCUSDT']) {
    const entry = lastPrice(m, sym);
    let prev = Infinity;
    for (const lev of [50, 25, 12, 6, 3, 1.5, 1]) {
      const r = preflight({ symbol: sym, side: 'long', leverage: lev, margin: 200, entry, stop: entry * 0.98, target: entry * 1.05, horizonH: 72, origin: 'pilot' }, m, SIM_START, 10_000);
      const fails = r.checks.filter((c) => c.status === 'fail').length;
      assert.ok(fails <= prev, `${sym} at ${lev}x`);
      prev = fails;
    }
  }
});

test('replay accounts for every window and loss never exceeds margin', () => {
  const r = preflight(nvda({ leverage: 20, stop: undefined }), market(), SIM_START, 10_000);
  const rp = r.replay;
  assert.equal(rp.target + rp.stopped + rp.liquidated + rp.timeout, rp.windows);
  assert.ok(rp.worstPnl >= -300 - 1e-9);
  const mc = r.monteCarlo;
  assert.equal(mc.target + mc.stopped + mc.liquidated + mc.timeout, mc.paths);
});

test('tower: no preflight, no clearance; a sound plan clears; a changed plan does not', () => {
  const m = market();
  const plan = nvda();
  const ctx = { now: SIM_START, equity: 10_000, instrument: INSTRUMENTS.NVDAUSDT, logbook: [] };
  assert.equal(requestClearance(plan, CHARTER, ctx).decision, 'REFUSED');
  const report = preflight(plan, m, SIM_START, 10_000);
  assert.notEqual(report.verdict, 'NO-GO');
  assert.equal(requestClearance(plan, CHARTER, { ...ctx, preflight: report }).decision, 'CLEARED');
  const changed = requestClearance({ ...plan, leverage: 4 }, CHARTER, { ...ctx, preflight: report });
  assert.equal(changed.decision, 'REFUSED');
  assert.ok(changed.findings.some((f) => !f.ok && /changed after preflight/.test(f.detail)));
});

test('tower: a rogue agent order is refused and the cap is quoted back', () => {
  const m = market();
  const plan: FlightPlan = { ...nvda({ symbol: 'MSTRUSDT', entry: lastPrice(m, 'MSTRUSDT'), leverage: 25, stop: undefined, target: undefined }), origin: 'agent', agentId: 'rogue-01' };
  const c = requestClearance(plan, CHARTER, { now: SIM_START, equity: 10_000, instrument: INSTRUMENTS.MSTRUSDT, logbook: [] });
  assert.equal(c.decision, 'REFUSED');
  const failed = c.findings.filter((f) => !f.ok).map((f) => f.ruleId);
  for (const id of ['preflight', 'stop', 'lev-rwa', 'offhours', 'agent']) assert.ok(failed.includes(id), id);
  assert.equal(c.amendment, undefined, 'not only a size problem');
});

test('tower: when only leverage is wrong it proposes the size that clears', () => {
  const m = market();
  const entry = lastPrice(m, 'BTCUSDT');
  const plan: FlightPlan = { symbol: 'BTCUSDT', side: 'long', leverage: 3, margin: 300, entry, stop: entry * 0.97, target: entry * 1.08, horizonH: 48, origin: 'pilot' };
  const rules = CHARTER.map((r) => (r.id === 'lev-crypto' ? { ...r, params: { cls: 'crypto', max: 2 } } : r));
  const c = requestClearance(plan, rules, { now: SIM_START, equity: 10_000, instrument: INSTRUMENTS.BTCUSDT, preflight: preflight(plan, m, SIM_START, 10_000), logbook: [] });
  assert.equal(c.decision, 'REFUSED');
  assert.deepEqual(c.amendment, { leverage: 2 });
  assert.notEqual(rulesHash(rules), rulesHash(CHARTER));
});

test('ledger chain verifies and detects tampering', () => {
  let ledger: LedgerEntry[] = [];
  ledger = appendEntry(ledger, 'clearance', 'NVDA 3x long cleared', { planHash: 'abc' }, 1);
  ledger = appendEntry(ledger, 'takeoff', 'FD1 airborne', { id: 'FD1' }, 2);
  ledger = appendEntry(ledger, 'landing', 'FD1 landed', { pnl: 12.5 }, 3);
  assert.equal(verifyLedger(ledger), 0);
  const forged = ledger.map((e) => (e.seq === 2 ? { ...e, body: { id: 'FD9' } } : e));
  assert.equal(verifyLedger(forged), 2);
  const reordered = [ledger[0], ledger[2]];
  assert.equal(verifyLedger(reordered), 3);
  assert.match(squawk(ledger[0].hash), /^[0-7]{4}$/);
});

test('flights land at the stop, the target or liquidation, never below -margin', () => {
  const inst = INSTRUMENTS.NVDAUSDT;
  const f = takeoff(nvda({ entry: 240, stop: 236, target: 250, leverage: 5 }), inst, 0);
  assert.equal(stepFlight(f, { t: 0, o: 240, h: 241, l: 239, c: 240.5 }, inst, 10_000), null);
  const stopped = stepFlight(f, { t: HOUR, o: 240, h: 240.2, l: 235, c: 235.5 }, inst, 10_000);
  assert.equal(stopped?.outcome, 'stopped');
  assert.ok((stopped?.pnl as number) < 0 && (stopped?.pnl as number) > -300);
  assert.equal(stepFlight(f, { t: HOUR, o: 240, h: 251, l: 239.5, c: 250.5 }, inst, 10_000)?.outcome, 'target');
  const gap = stepFlight(f, { t: HOUR, o: 180, h: 181, l: 170, c: 175 }, inst, 10_000);
  assert.equal(gap?.outcome, 'liquidated');
  assert.equal(gap?.pnl, -300);
  const naked = takeoff(nvda({ entry: 240, stop: undefined, target: undefined, leverage: 20 }), inst, 0);
  assert.equal(stepFlight(naked, { t: HOUR, o: 240, h: 240, l: 228, c: 230 }, inst, 10_000)?.outcome, 'liquidated');
  assert.equal(land(naked, 100, 1, 'landed', inst, 10_000).pnl, -300);
});

test('the first-filed shadow shows what an amendment was worth', () => {
  const m = snapshot();
  const inst = INSTRUMENTS.NVDAUSDT;
  const entry = lastPrice(market(), 'NVDAUSDT');
  let f = takeoff(nvda({ leverage: 5, margin: 400, entry, stop: 231.39, target: 251.56, horizonH: 72 }), inst, SIM_START);
  f = { ...f, filed: { leverage: 20, margin: 400, stop: 231.39, target: 251.56 } };
  let done = null;
  for (const bar of m.hourly.NVDAUSDT.filter((c) => c.t >= SIM_START)) { done = stepFlight(f, bar, inst, 10_000); if (done) break; }
  assert.equal(done?.outcome, 'stopped');
  const sh = shadowOf(done!, m.hourly.NVDAUSDT, inst);
  assert.equal(sh?.outcome, 'stopped');
  assert.ok(Math.abs((sh?.pnl as number) / (done?.pnl as number) - 4) < 0.05, 'four times the size, four times the loss');
  assert.equal(shadowOf(f, m.hourly.NVDAUSDT, inst), undefined, 'no shadow for a flight still airborne');
});

test('black box finds the planted leaks and turns them into rules', () => {
  const book = sampleLogbook();
  const a = autopsy(book, SIM_START);
  assert.equal(a.flights, book.length);
  const leak = (id: string) => a.leaks.find((l) => l.id === id);
  for (const id of ['revenge', 'sizeup', 'offhours', 'overtrading', 'stopless', 'leverage']) {
    assert.ok((leak(id)?.cost as number) < 0, `${id} cost`);
    assert.ok(leak(id)?.proposal, `${id} proposal`);
  }
  assert.ok(Number(leak('leverage')?.proposal?.params.max) <= 5);
  const proposals = a.leaks.flatMap((l) => (l.proposal ? [l.proposal] : []));
  const rules = adopt(CHARTER, proposals);
  const fresh = proposals.filter((p) => !covered(CHARTER, p));
  assert.equal(fresh.length, proposals.length - 1, 'the charter already demands a stop');
  assert.equal(rules.length, CHARTER.length + fresh.length);
  assert.ok(!covered(CHARTER, proposals.find((p) => p.kind === 'offhours_leverage')!), 'a stricter learned cap is not covered by a looser charter cap');
  assert.equal(adopt(rules, proposals).length, rules.length, 'adopting twice adds nothing');
  const before = counterfactual(book, CHARTER, INSTRUMENTS, 10_000);
  const after = counterfactual(book, rules, INSTRUMENTS, 10_000);
  assert.ok(after.keptNet > after.actualNet);
  assert.ok(after.refused.length > before.refused.length);
  assert.ok(Math.abs(after.actualNet - a.net) < 1e-9);
});

test('black box does not accuse imported flights of flying without a stop', () => {
  const book = sampleLogbook().map((f) => ({ ...f, stop: undefined, stopUnknown: true }));
  const leak = autopsy(book, SIM_START).leaks.find((l) => l.id === 'stopless')!;
  assert.equal(leak.count, 1, 'only the liquidation is certain');
  assert.equal(leak.proposal, undefined);
});

test('black box stays quiet about a clean logbook', () => {
  const clean = sampleLogbook().filter((f) => (f.pnl as number) > 0 && f.leverage <= 3);
  const a = autopsy(clean, SIM_START);
  assert.equal(a.leaks.filter((l) => l.proposal).length, 0);
});

test('logbook CSV round-trips through the importer', () => {
  const book = sampleLogbook();
  const csv = logbookCsv(book, 10_000);
  assert.equal(csv.split('\n').length, 1 + book.length * 2);
  const back = importCsv(csv);
  assert.equal(back.error, undefined);
  assert.equal(back.flights.length, book.length);
  const sumPnl = (fs: { pnl?: number }[]) => fs.reduce((a, f) => a + (f.pnl ?? 0), 0);
  assert.ok(Math.abs(sumPnl(back.flights) - sumPnl(book)) < 0.5);
  const trades = importCsv('time,pair,direction,price,quantity,leverage,pnl\n2026-10-01T14:00:00Z,NVDAUSDT,buy,230,4,5,-22.5\n2026-10-01T15:00:00Z,BTCUSDT,sell,84000,0.01,2,13\nbad,row');
  assert.equal(trades.flights.length, 2);
  assert.equal(trades.skipped, 1);
  assert.equal(trades.flights[0].margin, 184);
  assert.equal(trades.flights[1].side, 'short');
  assert.match(importCsv('a,b\n1,2').error as string, /Missing/);
});

test('thesis parser fills the plan from one line', () => {
  const m = market();
  const { plan, understood } = parseThesis('5x short Tesla, $400 margin, stop 385 target 350 over the weekend', m, nvda());
  assert.equal(plan.symbol, 'TSLAUSDT');
  assert.equal(plan.side, 'short');
  assert.equal(plan.leverage, 5);
  assert.equal(plan.margin, 400);
  assert.equal(plan.stop, 385);
  assert.equal(plan.target, 350);
  assert.equal(plan.horizonH, 72);
  assert.equal(plan.entry, lastPrice(m, 'TSLAUSDT'));
  assert.ok(understood.length >= 6);
  assert.notEqual(planHash(plan), planHash(nvda()));
});

test('crew: template briefs cover three seats; model replies are validated', () => {
  const r = preflight(nvda({ leverage: 20 }), market(), SIM_START, 10_000);
  const briefs = ruleBriefs(r, 'NVDA');
  assert.deepEqual(briefs.map((b) => b.seat), ['Weather', 'Engineering', 'Dispatch']);
  assert.ok(briefs.every((b) => b.text.length > 40 && !/undefined|NaN/.test(b.text)));
  assert.ok(crewPrompt(r, 'NVDA').user.includes(r.plan.symbol));
  const ok = parseCrewReply('```json\n{"briefs":[{"seat":"Weather","text":"a"},{"seat":"Engineering","text":"b"},{"seat":"Dispatch","text":"c"}]}\n```');
  assert.equal(ok?.length, 3);
  assert.equal(parseCrewReply('{"briefs":[{"seat":"Weather","text":"a"}]}'), null);
  assert.equal(parseCrewReply('sorry'), null);
});

test('bitget request signature is base64 HMAC-SHA256 of ts + METHOD + path + body', () => {
  const expected = createHmac('sha256', 's3cret').update('1700000000000POST/api/v2/mix/order/place-order{"a":1}').digest('base64');
  assert.equal(sign('s3cret', '1700000000000', 'post', '/api/v2/mix/order/place-order', '{"a":1}'), expected);
});

test('earnings: release times follow New York, and the calendar only looks forward', () => {
  assert.equal(afterClose('2026-10-21'), utc('2026-10-21T20:05:00'), 'summer time');
  assert.equal(afterClose('2026-11-02'), utc('2026-11-02T21:05:00'), 'winter time');
  const cal = earningsCalendar(SIM_START);
  assert.equal(cal.TSLAUSDT.announced, true);
  assert.equal(cal.MSFTUSDT.announced, false);
  assert.equal(cal.BTCUSDT, undefined);
  assert.equal(earningsCalendar(utc('2026-10-22T00:00:00')).TSLAUSDT, undefined, 'a past date is not "next"');
  assert.equal(earningsCalendar(SIM_START, '{"COINUSDT":{"date":"2026-10-29","announced":true}}').COINUSDT.at, utc('2026-10-29T20:05:00'));
  assert.equal(earningsCalendar(SIM_START, 'not json').TSLAUSDT.announced, true);
});

test('preflight: a hold through earnings is judged on the gap, not the stop', () => {
  const m = market();
  const entry = lastPrice(m, 'TSLAUSDT');
  const base = { symbol: 'TSLAUSDT', side: 'long' as const, margin: 400, entry, stop: entry * 0.97, target: entry * 1.1, origin: 'pilot' as const };
  const check = (lev: number, hours: number) => preflight({ ...base, leverage: lev, horizonH: hours }, m, SIM_START, 10_000).checks.find((c) => c.id === 'earnings')!;
  assert.equal(check(3, 72).status, 'pass', 'lands two weeks before results');
  assert.equal(check(1, 504).status, 'caution', 'crossing is always at least a caution');
  assert.equal(check(8, 504).status, 'fail', 'a 15.7% reaction liquidates 8x');
  assert.match(check(8, 504).headline, /21 OCT/);
  assert.equal(preflight({ ...base, symbol: 'BTCUSDT', entry: lastPrice(m, 'BTCUSDT'), stop: undefined, target: undefined, leverage: 2, horizonH: 504 }, m, SIM_START, 10_000).checks.find((c) => c.id === 'earnings')!.status, 'pass');
  assert.equal(preflight({ ...base, leverage: 8, horizonH: 504 }, m, SIM_START, 10_000).numbers.earningsAt, utc('2026-10-21T20:05:00'));
});

test('partial closes bank their result and the total never exceeds the margin', () => {
  const inst = INSTRUMENTS.NVDAUSDT;
  const f = takeoff(nvda({ entry: 240, stop: 234, target: 252, leverage: 5, margin: 400 }), inst, 0);
  const half = cut(f, 0.5, 237, inst);
  assert.equal(half.open, 0.5);
  assert.ok(Math.abs((half.realised as number) - (f.qty * 0.5 * -3 - 2000 * 0.5 * 0.0012)) < 1e-9);
  assert.ok(Math.abs(unrealised(half, 237) - unrealised(f, 237) / 2) < 1e-9);
  const done = land(half, 234, 1, 'stopped', inst, 10_000);
  const whole = land(f, 234, 1, 'stopped', inst, 10_000);
  assert.ok((done.pnl as number) > (whole.pnl as number), 'half out at -3 beats all out at -6');
  assert.ok(Math.abs((done.pnl as number) - (f.qty * 0.5 * -3 + f.qty * 0.5 * -6 - 2000 * 0.0012)) < 1e-9, 'fees total the same');
  assert.equal(land(half, 100, 1, 'liquidated', inst, 10_000).pnl, (half.realised as number) - 200);
});

test('night watch guard: only risk-reducing actions pass', () => {
  const inst = INSTRUMENTS.NVDAUSDT;
  const f = takeoff(nvda({ entry: 240, stop: 234, target: 258, leverage: 5 }), inst, 0);
  const bars = [{ t: 0, o: 240, h: 247, l: 239, c: 246 }];
  const x = assess(f, bars, inst, HOUR);
  assert.ok(Math.abs(x.r - 1) < 1e-9 && x.bestR > 1);
  assert.equal(decide(f, x).action, 'stop-to-entry');
  assert.equal(guard(f, { action: 'trail-stop', rule: 't', why: '', stop: 230 }, x).ok, false, 'widening');
  assert.equal(guard(f, { action: 'trail-stop', rule: 't', why: '', stop: 250 }, x).ok, false, 'through the market');
  assert.equal(guard(f, { action: 'trail-stop', rule: 't', why: '', stop: 238 }, x).ok, true);
  assert.equal(guard(f, { action: 'cut-half', rule: 't', why: '' }, x).ok, true);
  assert.equal(guard(f, { action: 'land', rule: 't', why: '' }, x).ok, true);
  // a model that asks for a stop above a falling market is overruled by the rules
  const down = [{ t: 0, o: 240, h: 240.5, l: 237, c: 238 }];
  const t = watchTick(f, down, inst, HOUR, 10_000, undefined, { action: 'stop-to-entry', rule: 'model', why: 'feels right' });
  assert.match(t.refused as string, /through the market/);
  assert.equal(t.flight.stop, 234);
  assert.equal(parseWatchReply('{"action":"add-size","why":"x"}'), null);
  assert.equal(parseWatchReply('ok: {"action":"cut-half","why":"bleeding"}')?.action, 'cut-half');
});

test('night watch invariant: over random flights and random proposals, risk never goes up', () => {
  const m = snapshot();
  const rnd = prng(20261008);
  const actions = ['hold', 'stop-to-entry', 'trail-stop', 'cut-half', 'land'] as const;
  let acted = 0;
  for (let i = 0; i < 300; i++) {
    const sym = ['NVDAUSDT', 'TSLAUSDT', 'MSTRUSDT', 'BTCUSDT'][Math.floor(rnd() * 4)];
    const inst = INSTRUMENTS[sym];
    const bars = m.hourly[sym];
    const start = 24 + Math.floor(rnd() * 100);
    const entry = bars[start - 1].c;
    const side = rnd() < 0.5 ? 'long' : 'short';
    const d = side === 'long' ? 1 : -1;
    let f = takeoff({ symbol: sym, side, leverage: 2 + Math.floor(rnd() * 8), margin: 300, entry, stop: entry * (1 - d * (0.01 + rnd() * 0.02)), horizonH: 72, origin: 'pilot' }, inst, bars[start].t);
    for (let k = start; k < Math.min(bars.length, start + 30); k++) {
      const now = bars[k].t + HOUR;
      const a = actions[Math.floor(rnd() * actions.length)];
      const model = rnd() < 0.5 ? undefined : a === 'trail-stop' ? { action: a, rule: 'model', why: '', stop: bars[k].c * (0.9 + rnd() * 0.2) } : { action: a, rule: 'model', why: '' };
      const before = f;
      const t = watchTick(f, bars, inst, now, 10_000, undefined, model);
      assert.ok((t.flight.open ?? 1) <= (before.open ?? 1) + 1e-12, 'exposure never grows');
      if (before.stop !== undefined && !t.landed) assert.ok(((t.flight.stop as number) - before.stop) * d >= -1e-9, 'the stop never moves away');
      assert.ok(t.flight.stop !== undefined || t.landed, 'the stop is never removed');
      if (t.event) acted++;
      if (t.landed) { assert.ok((t.flight.pnl as number) >= -300 - 1e-9); break; }
      f = t.flight;
    }
  }
  assert.ok(acted > 30, `expected the watch to act, acted ${acted} times`);
});

test('night watch lands a stock perp before unattended earnings, and writes the debrief', () => {
  const m = snapshot();
  const inst = INSTRUMENTS.TSLAUSDT;
  const bars = m.hourly.TSLAUSDT;
  const now = bars[100].t + HOUR;
  const f = { ...takeoff({ symbol: 'TSLAUSDT', side: 'long', leverage: 3, margin: 300, entry: bars[90].c, stop: bars[90].c * 0.97, horizonH: 96, origin: 'pilot' }, inst, bars[91].t), watch: true };
  const quiet = watchTick(f, bars, inst, now, 10_000, now + 30 * HOUR);
  assert.equal(quiet.landed, false);
  const t = watchTick(quiet.flight, bars, inst, now + HOUR, 10_000, now + 2.5 * HOUR);
  assert.equal(t.landed, true);
  assert.equal(t.event?.rule, 'earnings');
  assert.equal(t.flight.watchChecks, 2);
  assert.match(debrief(t.flight, 'TSLA'), /checked TSLA .* 2 times, held 1 and acted 1: landed it/);
});
