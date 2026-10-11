// FLIGHT: the paper book. Opens a cleared plan, steps it through hourly bars,
// and lands it at the stop, the target, liquidation or the pilot's command.

import { isUsOpen } from './calendar';
import { liquidationPrice, stopState } from './preflight';
import { Candle, Flight, FlightPlan, Instrument, Outcome } from './types';
import { HOUR, sha256 } from './util';

export function takeoff(plan: FlightPlan, inst: Instrument, now: number, venue = 'paper'): Flight {
  const liq = liquidationPrice(plan, inst);
  const valid = stopState(plan, liq) === 'valid';
  return {
    id: 'FD' + sha256(`${plan.symbol}${plan.side}${now}${plan.margin}${plan.leverage}`).slice(0, 6).toUpperCase(),
    symbol: plan.symbol, side: plan.side, leverage: plan.leverage, margin: plan.margin,
    qty: (plan.margin * plan.leverage) / plan.entry, entry: plan.entry,
    stop: valid ? plan.stop : undefined, stop0: valid ? plan.stop : undefined, target: plan.target, liqPrice: liq,
    openedAt: now, horizonH: plan.horizonH, origin: plan.origin, cls: inst.cls,
    usOpenAtEntry: inst.cls === 'rwa' ? isUsOpen(now) : null, venue,
  };
}

/** Result on the part of the position that is still open. */
export function unrealised(f: Flight, price: number): number {
  return f.qty * (f.open ?? 1) * (price - f.entry) * (f.side === 'long' ? 1 : -1);
}

export function land(f: Flight, exit: number, at: number, outcome: Outcome, inst: Instrument, balanceBefore: number): Flight {
  const open = f.open ?? 1;
  const banked = f.realised ?? 0;
  const fees = f.margin * f.leverage * open * inst.takerFee * 2;
  // liquidation takes the margin still committed; partial closes already banked stay banked
  const pnl = outcome === 'liquidated' ? banked - f.margin * open : Math.max(-f.margin, banked + unrealised(f, exit) - fees);
  return { ...f, closedAt: at, exit, pnl, fees, outcome, balanceAfter: balanceBefore + pnl };
}

/** Close a fraction of the open position at `price` and bank the result. */
export function cut(f: Flight, fraction: number, price: number, inst: Instrument): Flight {
  const open = f.open ?? 1;
  const closing = open * Math.min(1, Math.max(0, fraction));
  const d = f.side === 'long' ? 1 : -1;
  const gross = f.qty * closing * (price - f.entry) * d;
  const fees = f.margin * f.leverage * closing * inst.takerFee * 2;
  return { ...f, open: open - closing, realised: (f.realised ?? 0) + gross - fees };
}

/**
 * Advance an airborne flight across one closed hourly bar. Returns the landed
 * flight if a level was hit, otherwise null. Adverse levels are checked first.
 */
export function stepFlight(f: Flight, bar: Candle, inst: Instrument, balanceBefore: number): Flight | null {
  const d = f.side === 'long' ? 1 : -1;
  const adverse = d === 1 ? bar.l : bar.h;
  const favourable = d === 1 ? bar.h : bar.l;
  const at = bar.t + HOUR;
  const slip = inst.cls === 'rwa' ? 0.002 : 0.001;
  if (f.stop !== undefined && (adverse - f.stop) * d <= 0) {
    const gapped = (bar.o - f.stop) * d <= 0;
    const fill = (gapped ? bar.o : f.stop) * (1 - d * slip);
    if ((fill - f.liqPrice) * d <= 0) return land(f, f.liqPrice, at, 'liquidated', inst, balanceBefore);
    return land(f, fill, at, 'stopped', inst, balanceBefore);
  }
  if ((adverse - f.liqPrice) * d <= 0) return land(f, f.liqPrice, at, 'liquidated', inst, balanceBefore);
  if (f.target !== undefined && (favourable - f.target) * d >= 0) return land(f, f.target, at, 'target', inst, balanceBefore);
  if (at >= f.openedAt + f.horizonH * HOUR) return land(f, bar.c, at, 'timeout', inst, balanceBefore);
  return null;
}

/**
 * Fly the plan as it was first filed through the same hours the amended flight
 * actually flew. It shows what the amendment was worth, with no forecasting.
 */
export function shadowOf(f: Flight, bars: Candle[], inst: Instrument): Flight['shadow'] {
  if (!f.filed || f.closedAt === undefined || f.exit === undefined) return undefined;
  const plan: FlightPlan = {
    symbol: f.symbol, side: f.side, leverage: f.filed.leverage, margin: f.filed.margin, entry: f.entry,
    stop: f.filed.stop, target: f.filed.target, horizonH: f.horizonH, origin: f.origin,
  };
  const ghost = takeoff(plan, inst, f.openedAt);
  for (const bar of bars) {
    if (bar.t < f.openedAt || bar.t + HOUR > f.closedAt) continue;
    const done = stepFlight(ghost, bar, inst, 0);
    if (done) return { leverage: plan.leverage, pnl: done.pnl as number, outcome: done.outcome as Outcome };
  }
  const done = land(ghost, f.exit, f.closedAt, 'landed', inst, 0);
  return { leverage: plan.leverage, pnl: done.pnl as number, outcome: 'landed' };
}

/**
 * Fly the same flight, at the same size, through the same hours with Night
 * Watch off: the stop stays where it was cleared and nothing is cut. Returned
 * only when Night Watch actually acted, so the two results can be compared.
 */
export function unwatchedOf(f: Flight, bars: Candle[], inst: Instrument): Flight['unwatched'] {
  if (!f.watchLog?.length || f.closedAt === undefined || f.exit === undefined) return undefined;
  const ghost: Flight = { ...f, stop: f.stop0, open: 1, realised: 0, watch: false, watchLog: [], closedAt: undefined, exit: undefined, pnl: undefined, outcome: undefined };
  for (const bar of bars) {
    if (bar.t < f.openedAt || bar.t + HOUR > f.closedAt) continue;
    const done = stepFlight(ghost, bar, inst, 0);
    if (done) return { pnl: done.pnl as number, outcome: done.outcome as Outcome };
  }
  const done = land(ghost, f.exit, f.closedAt, 'landed', inst, 0);
  return { pnl: done.pnl as number, outcome: 'landed' };
}

/** The paper-trading log judges ask for: one row per fill, with the balance change. */
export function logbookCsv(flights: Flight[], startBalance: number): string {
  const rows = ['timestamp_utc,flight,pair,direction,action,price,quantity,leverage,pnl_usdt,balance_usdt,venue'];
  const events: { t: number; row: string }[] = [];
  const landed = flights.filter((f) => f.closedAt !== undefined).sort((a, b) => (a.closedAt as number) - (b.closedAt as number));
  let bal = startBalance;
  const balanceAt = new Map<string, number>();
  for (const f of landed) { bal += f.pnl ?? 0; balanceAt.set(f.id, bal); }
  for (const f of flights) {
    const iso = (t: number) => new Date(t).toISOString();
    events.push({ t: f.openedAt, row: [iso(f.openedAt), f.id, f.symbol, f.side, 'open', f.entry, f.qty.toFixed(4), f.leverage, '', '', f.venue ?? 'paper'].join(',') });
    if (f.closedAt !== undefined) {
      events.push({ t: f.closedAt, row: [iso(f.closedAt), f.id, f.symbol, f.side, `close:${f.outcome}`, (f.exit as number).toFixed(4), f.qty.toFixed(4), f.leverage, (f.pnl as number).toFixed(2), (balanceAt.get(f.id) as number).toFixed(2), f.venue ?? 'paper'].join(',') });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return rows.concat(events.map((e) => e.row)).join('\n');
}
