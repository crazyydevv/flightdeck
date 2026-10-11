// BLACK BOX: reads the logbook, finds the habits that cost money, and writes
// each one up as a Tower rule. The loop closes here: a leak found in past
// flights becomes a refusal on future ones.

import { requestClearance, TowerContext } from './tower';
import { Autopsy, Flight, Instrument, Leak, Rule } from './types';
import { DAY, fmtUsd, HOUR, sum } from './util';

const landedOnly = (fs: Flight[]) =>
  fs.filter((f) => f.closedAt !== undefined && f.pnl !== undefined).sort((a, b) => a.openedAt - b.openedAt);

const pnlOf = (fs: Flight[]) => sum(fs.map((f) => f.pnl as number));
const notional = (f: Flight) => f.margin * f.leverage;

/** The most recent flight that landed before this one took off. */
function previousLanding(f: Flight, all: Flight[]): Flight | undefined {
  let best: Flight | undefined;
  for (const g of all) {
    if (g.id === f.id || (g.closedAt as number) > f.openedAt) continue;
    if (!best || (g.closedAt as number) > (best.closedAt as number)) best = g;
  }
  return best;
}

const MIN_EVIDENCE = 3;

export function autopsy(logbook: Flight[], now: number): Autopsy {
  const fs = landedOnly(logbook);
  const leaks: Leak[] = [];
  const add = (leak: Omit<Leak, 'count' | 'cost' | 'evidence'>, flagged: Flight[]) => {
    const cost = pnlOf(flagged);
    const real = flagged.length >= MIN_EVIDENCE && cost < 0;
    leaks.push({ ...leak, count: flagged.length, cost, evidence: flagged.map((f) => f.id), proposal: real ? leak.proposal : undefined });
  };
  const rule = (id: string, kind: Rule['kind'], title: string, params: Rule['params'], evidence: string): Rule => ({
    id: `bb-${id}`, kind, title, params, source: 'blackbox', enabled: true, evidence, addedAt: now,
  });

  // 1. Revenge flights: taking off within 30 minutes of a losing landing.
  const revenge = fs.filter((f) => {
    const prev = previousLanding(f, fs);
    return prev && (prev.pnl as number) < 0 && f.openedAt - (prev.closedAt as number) <= 30 * 60000;
  });
  add({
    id: 'revenge', title: 'Revenge flights',
    summary: `${revenge.length} flights took off within 30 minutes of a loss. Together they made ${fmtUsd(pnlOf(revenge))} USDT.`,
    proposal: rule('cooldown', 'cooldown_after_loss', 'Cooldown after a losing flight', { minutes: 60 },
      `${revenge.length} flights within 30 min of a loss: ${fmtUsd(pnlOf(revenge))} USDT`),
  }, revenge);

  // 2. Sizing up after a loss.
  const sizeup = fs.filter((f) => {
    const prev = previousLanding(f, fs);
    return prev && (prev.pnl as number) < 0 && f.openedAt - (prev.closedAt as number) <= 6 * HOUR && notional(f) > notional(prev) * 1.25;
  });
  add({
    id: 'sizeup', title: 'Sizing up after a loss',
    summary: `${sizeup.length} flights were at least 25% larger than the losing flight before them. Together: ${fmtUsd(pnlOf(sizeup))} USDT.`,
    proposal: rule('sizeup', 'no_size_up_after_loss', 'No larger position for 6h after a loss', { hours: 6 },
      `${sizeup.length} sized-up flights after a loss: ${fmtUsd(pnlOf(sizeup))} USDT`),
  }, sizeup);

  // 3. Leverage on stock perps while New York is shut.
  const offHigh = fs.filter((f) => f.cls === 'rwa' && f.usOpenAtEntry === false && f.leverage > 3);
  const offLow = fs.filter((f) => f.cls === 'rwa' && f.usOpenAtEntry === false && f.leverage <= 3);
  add({
    id: 'offhours', title: 'Leverage while New York is shut',
    summary: `${offHigh.length} stock-perp flights above 3x took off with New York closed: ${fmtUsd(pnlOf(offHigh))} USDT. The ${offLow.length} at 3x or less made ${fmtUsd(pnlOf(offLow))}.`,
    proposal: rule('offhours', 'offhours_leverage', 'Stock perps while New York is closed', { max: 3 },
      `${offHigh.length} off-hours flights above 3x: ${fmtUsd(pnlOf(offHigh))} USDT`),
  }, offHigh);

  // 4. Overtrading: flights on days with more than five take-offs.
  const byDay = new Map<number, Flight[]>();
  for (const f of fs) {
    const day = Math.floor(f.openedAt / DAY);
    byDay.set(day, [...(byDay.get(day) ?? []), f]);
  }
  const busy = [...byDay.values()].filter((d) => d.length > 5).flat();
  const busyTail = [...byDay.values()].filter((d) => d.length > 5).flatMap((d) => d.slice(5));
  add({
    id: 'overtrading', title: 'Overtrading',
    summary: `${busyTail.length} flights were the sixth or later of their day. Those alone made ${fmtUsd(pnlOf(busyTail))} USDT; the busy days as a whole made ${fmtUsd(pnlOf(busy))}.`,
    proposal: rule('perday', 'max_flights_per_day', 'Flights per 24 hours', { n: 5 },
      `${busyTail.length} flights beyond the fifth of the day: ${fmtUsd(pnlOf(busyTail))} USDT`),
  }, busyTail);

  // 5. No stop, or liquidated.
  // imported history often cannot say whether a stop existed; those flights are not accused
  const stopless = fs.filter((f) => f.outcome === 'liquidated' || (f.stop === undefined && !f.stopUnknown && (f.pnl as number) < 0));
  add({
    id: 'stopless', title: 'Flying without a stop',
    summary: `${stopless.length} losing flights had no working stop or ended in liquidation: ${fmtUsd(pnlOf(stopless))} USDT.`,
    proposal: rule('stop', 'stop_required', 'A working stop is filed', {},
      `${stopless.length} stopless or liquidated flights: ${fmtUsd(pnlOf(stopless))} USDT`),
  }, stopless);

  // 6. Where the edge ends: the leverage above which results turn negative.
  const byLev = [...fs].sort((a, b) => a.leverage - b.leverage);
  let run = 0, bestRun = -Infinity, cut = 0;
  byLev.forEach((f, i) => {
    run += f.pnl as number;
    const next = byLev[i + 1];
    if ((!next || next.leverage > f.leverage) && run > bestRun) { bestRun = run; cut = f.leverage; }
  });
  const above = fs.filter((f) => f.leverage > cut);
  const below = fs.filter((f) => f.leverage <= cut);
  add({
    id: 'leverage', title: 'Where your edge ends',
    summary: above.length
      ? `At ${cut}x or less you made ${fmtUsd(pnlOf(below))} USDT over ${below.length} flights. Above ${cut}x you made ${fmtUsd(pnlOf(above))} over ${above.length}.`
      : 'Results do not fall off at higher leverage in this logbook.',
    proposal: rule('lev', 'max_leverage', `Leverage on any perp`, { cls: 'any', max: cut },
      `${above.length} flights above ${cut}x: ${fmtUsd(pnlOf(above))} USDT`),
  }, above);

  const wins = fs.filter((f) => (f.pnl as number) > 0).length;
  return {
    flights: fs.length, net: pnlOf(fs), winRate: fs.length ? wins / fs.length : 0,
    leaks: leaks.sort((a, b) => a.cost - b.cost),
  };
}

/** True when an existing rule of the same kind is already at least as strict. */
export function covered(rules: Rule[], p: Rule): boolean {
  return rules.some((r) => {
    if (!r.enabled || r.kind !== p.kind || r.id === p.id) return false;
    if (r.kind === 'max_leverage' && r.params.cls !== 'any' && r.params.cls !== p.params.cls) return false;
    for (const key of ['max', 'pct', 'n']) if (key in p.params) return Number(r.params[key]) <= Number(p.params[key]);
    for (const key of ['minutes', 'hours']) if (key in p.params) return Number(r.params[key]) >= Number(p.params[key]);
    return true;
  });
}

/** Add proposed rules to the Tower. Proposals an existing rule already covers are skipped. */
export function adopt(rules: Rule[], proposals: Rule[]): Rule[] {
  let out = [...rules];
  for (const p of proposals) {
    if (covered(out, p)) continue;
    out = out.filter((r) => r.id !== p.id);
    out.push(p);
  }
  return out;
}

export interface Counterfactual {
  refused: Flight[];
  keptNet: number;
  actualNet: number;
}

/**
 * Re-fly the logbook through the Tower with a candidate rule set. A refused
 * flight is removed and the flights after it are judged as if it never
 * happened. This is a naive counterfactual: it assumes the pilot would not
 * have found another way to lose the money.
 */
export function counterfactual(logbook: Flight[], rules: Rule[], instruments: Record<string, Instrument>, startEquity: number): Counterfactual {
  const fs = landedOnly(logbook);
  const kept: Flight[] = [];
  const refused: Flight[] = [];
  const active = rules.filter((r) => r.kind !== 'preflight_required');
  for (const f of fs) {
    const inst = instruments[f.symbol] ?? { symbol: f.symbol, base: f.symbol, name: f.symbol, cls: f.cls, maxLever: 100, takerFee: 0.0006, mmr: 0.005, pricePlace: 2, sizePlace: 2 };
    const done = kept.filter((k) => (k.closedAt as number) <= f.openedAt);
    const ctx: TowerContext = { now: f.openedAt, equity: startEquity + pnlOf(done), instrument: inst, logbook: kept };
    const c = requestClearance(
      { symbol: f.symbol, side: f.side, leverage: f.leverage, margin: f.margin, entry: f.entry, stop: f.stop, target: f.target, horizonH: f.horizonH, origin: f.origin },
      active, ctx,
    );
    (c.decision === 'CLEARED' ? kept : refused).push(f);
  }
  return { refused, keptNet: pnlOf(kept), actualNet: pnlOf(fs) };
}
