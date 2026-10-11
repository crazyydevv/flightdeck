// The whole loop, headless, on the recorded Bitget snapshot:
//   departures -> preflight -> tower -> flight with Night Watch -> black box -> stricter tower
// Writes the evidence files in samples/. Deterministic: run it twice and the
// files are byte-identical.
//
//   npm run demo

import { mkdirSync, writeFileSync } from 'node:fs';
import { adopt, autopsy, counterfactual } from '../src/core/blackbox';
import { logbookCsv, shadowOf, takeoff, unwatchedOf } from '../src/core/flight';
import { debrief } from '../src/core/nightwatch';
import { tickFlight } from '../src/core/watchman';
import { sampleLogbook } from '../src/core/logbook';
import { SIM_START, SNAPSHOT_END, lastPrice, snapshot, viewAsOf } from '../src/core/market';
import { preflight } from '../src/core/preflight';
import { offerLine, reroute } from '../src/core/reroute';
import { scan } from '../src/core/radar';
import { CHARTER, appendEntry, requestClearance, verifyLedger } from '../src/core/tower';
import { Flight, FlightPlan, LedgerEntry } from '../src/core/types';
import { sum, zulu } from '../src/core/util';

const START = 10_000;
const say = (s = '') => console.log(s);
let ledger: LedgerEntry[] = [];
let logbook: Flight[] = sampleLogbook(START);
let rules = CHARTER;
const equity = () => START + sum(logbook.map((f) => f.pnl ?? 0));

const now = SIM_START;
const market = viewAsOf(snapshot(), now);
say(`FLIGHTDECK demo flight. Simulator clock ${zulu(now)}, recorded Bitget candles.`);

say('\n1. DEPARTURES');
for (const c of scan(market, now).slice(0, 4)) say(`   ${c.symbol.padEnd(9)} ${(c.drift * 100).toFixed(2).padStart(6)}%  ${(c.zResid ?? c.z).toFixed(1).padStart(5)} sigma  ${c.session}`);

const inst = market.instruments.NVDAUSDT;
const entry = lastPrice(market, 'NVDAUSDT');
const filed: FlightPlan = { symbol: 'NVDAUSDT', side: 'long', leverage: 20, margin: 400, entry, stop: 231.39, target: 251.56, horizonH: 72, origin: 'pilot', thesis: 'Dip into the open, hold over two sessions.' };

say('\n2. PREFLIGHT, as filed (20x)');
const first = preflight(filed, market, now, equity());
for (const c of first.checks) say(`   ${c.status.toUpperCase().padEnd(8)} ${c.label.padEnd(20)} ${c.headline}`);
say(`   Verdict ${first.verdict}. Survives at ${first.guidance.leverage}x.`);

say('\n   Earnings check, on a different plan: TSLA 8x long held 3 weeks');
const tsla = lastPrice(market, 'TSLAUSDT');
const through = preflight({ symbol: 'TSLAUSDT', side: 'long', leverage: 8, margin: 400, entry: tsla, stop: +(tsla * 0.97).toFixed(2), target: +(tsla * 1.1).toFixed(2), horizonH: 504, origin: 'pilot' }, market, now, equity());
const ec = through.checks.find((c) => c.id === 'earnings')!;
say(`   ${ec.status.toUpperCase().padEnd(8)} ${ec.headline}`);

say('\n3. TOWER');
let clearance = requestClearance(filed, rules, { now, equity: equity(), instrument: inst, preflight: first, logbook });
ledger = appendEntry(ledger, 'refusal', `Refused: NVDA ${filed.leverage}x long`, { planHash: clearance.planHash, failed: clearance.findings.filter((f) => !f.ok).map((f) => f.ruleId) }, now);
say(`   ${filed.leverage}x: ${clearance.decision}. ${clearance.findings.filter((f) => !f.ok).map((f) => f.detail).join(' ')}`);
const route = reroute(filed, rules, market, now, equity(), logbook);
if (!route.ok) throw new Error('demo plan should have a route');
say(`   Re-route: ${offerLine(route, 'NVDA')}`);
const plan = route.plan;
clearance = route.clearance;
ledger = appendEntry(ledger, 'clearance', `Cleared after re-route: NVDA ${plan.leverage}x long`, { planHash: clearance.planHash, rulesHash: clearance.rulesHash, changes: route.changes }, now);
say(`   ${plan.leverage}x: ${clearance.decision}.`);

say('\n4. FLIGHT, through recorded hours the engines never saw, Night Watch on');
let flight: Flight = { ...takeoff(plan, inst, now), watch: true, cursor: now, filed: { leverage: filed.leverage, margin: filed.margin, stop: filed.stop, target: filed.target } };
ledger = appendEntry(ledger, 'takeoff', `${flight.id} airborne at ${entry}`, { id: flight.id, entry, qty: flight.qty, liq: flight.liqPrice, watch: true }, now);
const out = tickFlight(flight, { ...snapshot(), earnings: market.earnings }, SNAPSHOT_END, equity());
for (const e of out.events) ledger = appendEntry(ledger, 'watch', `Night Watch on ${flight.id}: ${e.action} (${e.rule})`, { id: flight.id, action: e.action, rule: e.rule, detail: e.detail }, e.at);
flight = out.landed ? { ...out.flight, shadow: shadowOf(out.flight, snapshot().hourly.NVDAUSDT, inst) } : out.flight;
if (flight.closedAt === undefined) throw new Error('demo flight should land inside the recording');
logbook = [...logbook, flight];
ledger = appendEntry(ledger, 'landing', `${flight.id} ${flight.outcome}, ${(flight.pnl as number).toFixed(2)} USDT`, { id: flight.id, outcome: flight.outcome, exit: flight.exit, pnl: flight.pnl }, flight.closedAt);
say(`   ${flight.id} ${flight.outcome} at ${(flight.exit as number).toFixed(2)} on ${zulu(flight.closedAt)}: ${(flight.pnl as number).toFixed(2)} USDT.`);
say(`   As first filed at ${flight.shadow?.leverage}x: ${flight.shadow?.outcome}, ${flight.shadow?.pnl.toFixed(2)} USDT.`);
say(`   ${debrief(flight, 'NVDA')}`);

say('\n5. BLACK BOX');
const post = autopsy(logbook, flight.closedAt);
for (const l of post.leaks) say(`   ${l.title.padEnd(34)} ${String(l.count).padStart(2)} flights ${l.cost.toFixed(2).padStart(9)} USDT ${l.proposal ? '-> rule' : ''}`);
const proposals = post.leaks.flatMap((l) => (l.proposal ? [l.proposal] : []));
const before = rules.length;
rules = adopt(rules, proposals);
for (const r of rules.slice(before)) ledger = appendEntry(ledger, 'rule', `Rule written from the logbook: ${r.title}`, { id: r.id, kind: r.kind, params: r.params, evidence: r.evidence }, flight.closedAt);
const cf = counterfactual(logbook, rules, market.instruments, START);
say(`   ${rules.length - before} rules written into the Tower. Re-flown under them: ${cf.refused.length} of ${post.flights} flights refused, net ${cf.actualNet.toFixed(2)} -> ${cf.keptNet.toFixed(2)} USDT.`);

say('\n6. AGENT DOOR');
const later = flight.closedAt;
const m2 = viewAsOf(snapshot(), later);
const rogue: FlightPlan = { symbol: 'MSTRUSDT', side: 'long', leverage: 25, margin: 2000, entry: lastPrice(m2, 'MSTRUSDT'), horizonH: 72, origin: 'agent', agentId: 'momentum-bot-7' };
const no = requestClearance(rogue, rules, { now: later, equity: equity(), instrument: m2.instruments.MSTRUSDT, logbook });
ledger = appendEntry(ledger, 'refusal', 'Refused agent momentum-bot-7: MSTR 25x long', { planHash: no.planHash, failed: no.findings.filter((f) => !f.ok).map((f) => f.ruleId) }, later);
say(`   momentum-bot-7 asks for MSTR 25x, no stop: ${no.decision}, ${no.findings.filter((f) => !f.ok).length} rules broken.`);

const counter = reroute(rogue, rules, m2, later, equity(), logbook);
say(`   Counter-offer: ${offerLine(counter, 'MSTR')}`);

say('\n7. NIGHT WATCH, a second flight: BTC 50x long filed at the same moment');
const btc = market.instruments.BTCUSDT;
const bEntry = lastPrice(market, 'BTCUSDT');
const bFiled: FlightPlan = { symbol: 'BTCUSDT', side: 'long', leverage: 50, margin: 400, entry: bEntry, stop: +(bEntry * 0.975).toFixed(1), target: +(bEntry * 1.06).toFixed(1), horizonH: 72, origin: 'pilot' };
const bRoute = reroute(bFiled, CHARTER, market, now, START, []);
if (!bRoute.ok) throw new Error('BTC plan should have a route');
let b: Flight = { ...takeoff(bRoute.plan, btc, now), watch: true, cursor: now, filed: { leverage: 50, margin: 400, stop: bFiled.stop, target: bFiled.target } };
const bOut = tickFlight(b, { ...snapshot(), earnings: market.earnings }, SNAPSHOT_END, START);
b = bOut.flight;
if (!bOut.landed) throw new Error('BTC flight should land inside the recording');
const bars = snapshot().hourly.BTCUSDT;
say(`   ${offerLine(bRoute, 'BTC')}`);
for (const e of bOut.events) say(`   ${zulu(e.at)} Night Watch: ${e.action} (${e.rule}). ${e.detail}`);
say(`   Landed ${b.outcome}: ${(b.pnl as number).toFixed(2)} USDT. Watch off: ${unwatchedOf(b, bars, btc)?.pnl.toFixed(2)} USDT. As filed at 50x: ${shadowOf(b, bars, btc)?.outcome}, ${shadowOf(b, bars, btc)?.pnl.toFixed(2)} USDT.`);
say(`\nLedger: ${ledger.length} entries, chain ${verifyLedger(ledger) === 0 ? 'intact' : 'BROKEN'}.`);

mkdirSync('samples', { recursive: true });
writeFileSync('samples/paper-trading-log.csv', logbookCsv(logbook.filter((f) => f.venue !== 'sample'), equity() - (flight.pnl as number)) + '\n');
writeFileSync('samples/ledger.json', JSON.stringify(ledger, null, 2) + '\n');
writeFileSync('samples/preflight-as-filed.json', JSON.stringify(first, null, 2) + '\n');
writeFileSync('samples/licence.json', JSON.stringify({ rules }, null, 2) + '\n');
say('Wrote samples/paper-trading-log.csv, ledger.json, preflight-as-filed.json, licence.json');
