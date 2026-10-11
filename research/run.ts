// THE STUDY, part 1: fly every trade the recorded data allows.
//
// For every contract, every entry hour, both sides and three leverages, this
// files the plan with Preflight and the Tower exactly as the app would have at
// that hour, asks for the re-route, and then flies each version through the
// hours that followed. The engines only ever receive bars that had closed
// before the entry (viewAt), so every decision here is out of sample.
//
//   tsx research/run.ts <scenario> [SYMBOL ...]
//
// Writes research/out/<scenario>-<SYMBOL>.json. research/report.ts reads them.

import fs from 'node:fs';
import path from 'node:path';
import { earningsCalendar } from '../src/core/earnings';
import { takeoff } from '../src/core/flight';
import { lastPrice } from '../src/core/market';
import { preflight } from '../src/core/preflight';
import { reroute } from '../src/core/reroute';
import { CHARTER, requestClearance } from '../src/core/tower';
import { Flight, FlightPlan, Instrument, MarketState, Outcome, Side } from '../src/core/types';
import { HOUR } from '../src/core/util';
import { tickFlight } from '../src/core/watchman';
import { studyMarket, viewAt } from './lib';

export const EQUITY = 10_000;
export const MARGIN = 400;
export const LEVERAGES = [10, 20, 50];
/** flat "never more than Kx" rules, flown for comparison */
export const FLAT_CAPS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20];
/** the engines need a week of hourly bars behind them before the first entry */
export const WARM_UP_H = 168;

export interface Scenario { id: string; label: string; horizonH: number; stopPct?: number; targetPct?: number }

export const SCENARIOS: Record<string, Scenario> = {
  // the stop and target the app fills in by default (src/ui/store.ts), held for a day
  day: { id: 'day', label: 'Default stop and target, 24h hold', horizonH: 24, stopPct: 0.025, targetPct: 0.06 },
  // the same, held for the app's default three days; at 20x this is exactly the plan the app opens with
  swing: { id: 'swing', label: 'Default stop and target, 72h hold', horizonH: 72, stopPct: 0.025, targetPct: 0.06 },
  // no stop and no target: the plan most blown-up accounts actually filed
  naked: { id: 'naked', label: 'No stop, no target, 24h hold', horizonH: 24 },
};

export interface Trade {
  symbol: string;
  /** entry time, ms */
  t: number;
  side: Side;
  /** leverage as filed */
  lev: number;
  // Preflight and Tower on the plan as filed
  verdict: 'GO' | 'CAUTION' | 'NO-GO';
  cleared: boolean;
  /** share of Monte Carlo paths that ended in liquidation */
  mcLiq: number;
  /** share of Monte Carlo paths that hit the stop or liquidation */
  mcLoss: number;
  /** distance to liquidation in normal moves for this hold */
  runway: number;
  /** failed checks, by id */
  fails: string[];
  // as filed
  a: [number, Outcome];
  // re-routed, Night Watch off; null when no size clears
  b: [number, Outcome] | null;
  // re-routed, Night Watch on
  c: [number, Outcome] | null;
  /** did Night Watch act on the re-routed flight */
  acted: boolean;
  bLev: number;
  bMargin: number;
  bStopAdded: boolean;
  /** why nothing clears, when nothing does */
  blockers?: string[];
  /** result at each flat leverage cap */
  flat: number[];
}

function planFor(sc: Scenario, inst: Instrument, side: Side, lev: number, entry: number): FlightPlan {
  const d = side === 'long' ? 1 : -1;
  const px = (pct: number | undefined, dir: number) => (pct === undefined ? undefined : Number((entry * (1 + dir * pct)).toFixed(inst.pricePlace)));
  return {
    symbol: inst.symbol, side, leverage: lev, margin: MARGIN, entry,
    stop: px(sc.stopPct, -d), target: px(sc.targetPct, d), horizonH: sc.horizonH, origin: 'pilot',
  };
}

function fly(plan: FlightPlan, inst: Instrument, m: MarketState, now: number, watch: boolean): Flight {
  const f: Flight = { ...takeoff(plan, inst, now), watch };
  const done = tickFlight(f, m, now + plan.horizonH * HOUR, 0);
  if (!done.landed) throw new Error(`flight did not land: ${plan.symbol} ${now}`);
  return done.flight;
}

export function runSymbol(sc: Scenario, symbol: string, full: MarketState, log = true, from = WARM_UP_H): Trade[] {
  const inst = full.instruments[symbol];
  const bars = full.hourly[symbol];
  const out: Trade[] = [];
  const started = Date.now();
  for (let i = Math.max(from, WARM_UP_H); i + sc.horizonH <= bars.length; i++) {
    const now = bars[i].t;
    const view = viewAt(full, now);
    const entry = lastPrice(view, symbol);
    // the flight sees the bars from here on; Night Watch gets a few days of context behind it
    const air: MarketState = { ...full, hourly: { [symbol]: bars.slice(Math.max(0, i - 200), i + sc.horizonH) }, earnings: earningsCalendar(now) };
    for (const side of ['long', 'short'] as Side[]) {
      for (const lev of LEVERAGES) {
        if (lev > inst.maxLever) continue;
        const plan = planFor(sc, inst, side, lev, entry);
        const report = preflight(plan, view, now, EQUITY);
        const clearance = requestClearance(plan, CHARTER, { now, equity: EQUITY, instrument: inst, preflight: report, logbook: [] });
        const route = reroute(plan, CHARTER, view, now, EQUITY, []);
        const a = fly(plan, inst, air, now, false);
        const mc = report.monteCarlo;
        const t: Trade = {
          symbol, t: now, side, lev, verdict: report.verdict, cleared: clearance.decision === 'CLEARED',
          mcLiq: mc.paths ? mc.liquidated / mc.paths : NaN,
          mcLoss: mc.paths ? (mc.liquidated + mc.stopped) / mc.paths : NaN,
          runway: report.numbers.sigmaHorizon > 0 ? report.numbers.liqDist / report.numbers.sigmaHorizon : 99,
          fails: report.checks.filter((c) => c.status === 'fail').map((c) => c.id),
          a: [a.pnl as number, a.outcome as Outcome], b: null, c: null, acted: false,
          bLev: 0, bMargin: 0, bStopAdded: false,
          flat: FLAT_CAPS.map((k) => fly({ ...plan, leverage: Math.min(lev, k) }, inst, air, now, false).pnl as number),
        };
        if (route.ok) {
          const b = fly(route.plan, inst, air, now, false);
          const c = fly(route.plan, inst, air, now, true);
          t.b = [b.pnl as number, b.outcome as Outcome];
          t.c = [c.pnl as number, c.outcome as Outcome];
          t.acted = Boolean(c.watchLog?.length);
          t.bLev = route.plan.leverage;
          t.bMargin = route.plan.margin;
          t.bStopAdded = route.changes.some((x) => x.startsWith('stop added'));
        } else t.blockers = route.blockers;
        out.push(t);
      }
    }
    if (log && (i - WARM_UP_H) % 100 === 0) console.error(`${sc.id} ${symbol} hour ${i - WARM_UP_H}/${bars.length - sc.horizonH - WARM_UP_H} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  return out;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('run.')) {
  const [, , id, ...symbols] = process.argv;
  const sc = SCENARIOS[id];
  if (!sc) { console.error(`scenario must be one of: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1); }
  const full = studyMarket();
  const dir = path.join(path.dirname(process.argv[1]), 'out');
  fs.mkdirSync(dir, { recursive: true });
  for (const symbol of symbols.length ? symbols : Object.keys(full.instruments)) {
    const trades = runSymbol(sc, symbol, full);
    fs.writeFileSync(path.join(dir, `${sc.id}-${symbol}.json`), JSON.stringify(trades));
    console.error(`${sc.id} ${symbol}: ${trades.length} trades`);
  }
}
