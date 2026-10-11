// PREFLIGHT: tries to kill a trade before the market does. Eight deterministic
// checks, each answering one question with numbers from Bitget candles. No
// model call decides anything here; the crew (crew.ts) only argues about the
// numbers this file produces.

import { isUsOpen, opensBetween } from './calendar';
import { earningsCalendar } from './earnings';
import { logReturns } from './market';
import {
  Candle, Check, CheckStatus, FlightPlan, Guidance, Instrument, MarketState, PreflightReport, ReplayStats,
} from './types';
import { fmtPct, fmtUsd, hashOf, HOUR, prng, seedFrom, stdev, zulu } from './util';

const dirOf = (p: FlightPlan) => (p.side === 'long' ? 1 : -1);

/** Isolated-margin liquidation price, ignoring fees. */
export function liquidationPrice(plan: FlightPlan, inst: Instrument): number {
  const k = 1 / plan.leverage - inst.mmr;
  const px = plan.side === 'long' ? plan.entry * (1 - k) : plan.entry * (1 + k);
  return Math.max(0, px);
}

export function planHash(p: FlightPlan): string {
  return hashOf({
    symbol: p.symbol, side: p.side, leverage: p.leverage, margin: p.margin, entry: p.entry,
    stop: p.stop ?? null, target: p.target ?? null, horizonH: p.horizonH, origin: p.origin,
  });
}

/** A stop only protects if it sits between the entry and the liquidation price. */
export function stopState(plan: FlightPlan, liq: number): 'none' | 'wrong-side' | 'beyond-liq' | 'valid' {
  if (plan.stop === undefined || !Number.isFinite(plan.stop)) return 'none';
  const d = dirOf(plan);
  if ((plan.stop - plan.entry) * d >= 0) return 'wrong-side';
  if ((plan.stop - liq) * d <= 0) return 'beyond-liq';
  return 'valid';
}

interface Costs { fees: number; fundingPerHour: number }

type Landing = { outcome: 'target' | 'stopped' | 'liquidated' | 'timeout'; pnl: number };

/** Fly the plan through one historical window, scaled so the window starts at the plan's entry. */
function flyWindow(plan: FlightPlan, liq: number, bars: Candle[], base: number, hoursPerBar: number, costs: Costs, slip: number): Landing {
  const d = dirOf(plan);
  const k = plan.entry / base;
  const qty = (plan.margin * plan.leverage) / plan.entry;
  const hasStop = stopState(plan, liq) === 'valid';
  const hasTarget = plan.target !== undefined && (plan.target - plan.entry) * d > 0;
  const result = (exit: number, i: number, outcome: Landing['outcome']): Landing => {
    const gross = qty * (exit - plan.entry) * d;
    const pnl = gross - costs.fees - costs.fundingPerHour * hoursPerBar * (i + 1);
    return { outcome, pnl: Math.max(pnl, -plan.margin) };
  };
  for (let i = 0; i < bars.length; i++) {
    const o = bars[i].o * k, h = bars[i].h * k, l = bars[i].l * k, c = bars[i].c * k;
    const adverse = d === 1 ? l : h;
    const favourable = d === 1 ? h : l;
    if (hasStop) {
      const stop = plan.stop as number;
      if ((adverse - stop) * d <= 0) {
        // a bar that opens through the stop fills at the open, not at the stop
        const gapped = (o - stop) * d <= 0;
        const fill = (gapped ? o : stop) * (1 - d * slip);
        if ((fill - liq) * d <= 0) return { outcome: 'liquidated', pnl: -plan.margin };
        return result(fill, i, 'stopped');
      }
    } else if ((adverse - liq) * d <= 0) {
      return { outcome: 'liquidated', pnl: -plan.margin };
    }
    if (hasTarget && (favourable - (plan.target as number)) * d >= 0) return result(plan.target as number, i, 'target');
    if (i === bars.length - 1) return result(c, i, 'timeout');
  }
  return { outcome: 'timeout', pnl: 0 };
}

function replay(plan: FlightPlan, liq: number, m: MarketState, costs: Costs, slip: number): ReplayStats {
  const hourly = m.hourly[plan.symbol] ?? [];
  const daily = m.daily[plan.symbol] ?? [];
  const useHourly = plan.horizonH <= 48 && hourly.length >= plan.horizonH + 24;
  const bars = useHourly ? hourly : daily;
  const n = Math.max(1, useHourly ? Math.round(plan.horizonH) : Math.ceil(plan.horizonH / 24));
  const stats: ReplayStats = {
    basis: useHourly ? 'hourly' : 'daily', windows: 0, target: 0, stopped: 0, liquidated: 0, timeout: 0,
    meanPnl: 0, worstPnl: 0, bestPnl: 0,
  };
  let total = 0;
  for (let i = 1; i + n <= bars.length; i++) {
    const r = flyWindow(plan, liq, bars.slice(i, i + n), bars[i - 1].c, useHourly ? 1 : 24, costs, slip);
    stats[r.outcome]++;
    total += r.pnl;
    stats.worstPnl = stats.windows ? Math.min(stats.worstPnl, r.pnl) : r.pnl;
    stats.bestPnl = stats.windows ? Math.max(stats.bestPnl, r.pnl) : r.pnl;
    stats.windows++;
  }
  stats.meanPnl = stats.windows ? total / stats.windows : 0;
  return stats;
}

/**
 * Block bootstrap on the same bars the replay used: draw past bars at random
 * (in short runs, so clustering survives), chain them into new paths, and fly
 * the plan through each. Seeded from the plan hash, so it is reproducible.
 */
function monteCarlo(plan: FlightPlan, liq: number, m: MarketState, basis: ReplayStats['basis'], costs: Costs, slip: number, seed: number) {
  const bars = (basis === 'hourly' ? m.hourly : m.daily)[plan.symbol] ?? [];
  const out = { paths: 0, liquidated: 0, stopped: 0, target: 0, timeout: 0 };
  if (bars.length < 24) return out;
  const rnd = prng(seed);
  const n = Math.max(1, basis === 'hourly' ? Math.round(plan.horizonH) : Math.ceil(plan.horizonH / 24));
  const block = basis === 'hourly' ? 6 : 2;
  out.paths = 1000;
  for (let p = 0; p < out.paths; p++) {
    const path: Candle[] = [];
    let px = plan.entry;
    while (path.length < n) {
      const start = 1 + Math.floor(rnd() * (bars.length - block));
      for (let b = 0; b < block && path.length < n; b++) {
        const bar = bars[start + b], prev = bars[start + b - 1].c;
        path.push({ t: 0, o: px * (bar.o / prev), h: px * (bar.h / prev), l: px * (bar.l / prev), c: px * (bar.c / prev) });
        px *= bar.c / prev;
      }
    }
    out[flyWindow(plan, liq, path, plan.entry, basis === 'hourly' ? 1 : 24, costs, slip).outcome]++;
  }
  return out;
}

const worst = (xs: CheckStatus[]): CheckStatus => (xs.includes('fail') ? 'fail' : xs.includes('caution') ? 'caution' : 'pass');

interface Core { checks: Check[]; numbers: PreflightReport['numbers']; replay: ReplayStats; liq: number; costs: Costs; slip: number }

function runChecks(plan: FlightPlan, inst: Instrument, m: MarketState, now: number, equity: number): Core {
  const d = dirOf(plan);
  const daily = m.daily[plan.symbol] ?? [];
  const hourly = m.hourly[plan.symbol] ?? [];
  const notional = plan.margin * plan.leverage;
  const qty = notional / plan.entry;
  const liq = liquidationPrice(plan, inst);
  const liqDist = Math.abs(plan.entry - liq) / plan.entry;
  const fees = notional * inst.takerFee * 2;
  const rate = m.funding[plan.symbol] ?? 0;
  // longs pay positive funding, shorts receive it
  const fundingPerHour = (notional * rate * d) / 8;
  const funding = fundingPerHour * plan.horizonH;
  const sState = stopState(plan, liq);
  const slip = inst.cls === 'rwa' ? 0.002 : 0.001;

  const sigmaDay = daily.length > 10 ? stdev(logReturns(daily)) : stdev(logReturns(hourly)) * Math.sqrt(24);
  const sigmaHorizon = sigmaDay * Math.sqrt(plan.horizonH / 24);

  // The shock is the worst single-day adverse move this instrument has already
  // printed, or a 4-sigma day if history has been kind so far.
  let observed = 0;
  for (const c of daily) observed = Math.max(observed, d === 1 ? 1 - c.l / c.o : c.h / c.o - 1);
  const usOpen = inst.cls === 'rwa' ? isUsOpen(now) : null;
  const opensCrossed = inst.cls === 'rwa' ? opensBetween(now, now + plan.horizonH * HOUR) : 0;
  const insideOneSession = inst.cls === 'rwa' && usOpen === true && opensCrossed === 0;
  let shock = Math.max(observed, 4 * sigmaDay);
  let shockSource = observed >= 4 * sigmaDay ? `worst day in ${daily.length} sessions` : '4-sigma day';
  if (insideOneSession) {
    shock = Math.min(shock, 4 * sigmaHorizon);
    shockSource = '4-sigma move inside one session';
  }

  const lossAtStop = sState === 'valid' ? qty * Math.abs(plan.entry - (plan.stop as number)) * (1 + slip) + fees : plan.margin;
  const lossAtShock = Math.min(plan.margin, notional * shock + fees);
  const hasTarget = plan.target !== undefined && (plan.target - plan.entry) * d > 0;
  const reward = hasTarget ? qty * Math.abs((plan.target as number) - plan.entry) - fees - Math.max(0, funding) : 0;
  const rr = lossAtStop > 0 ? reward / lossAtStop : 0;
  const riskPct = lossAtStop / equity;

  const rp = replay(plan, liq, m, { fees, fundingPerHour }, slip);
  const checks: Check[] = [];

  // 1. Runway: how many normal moves away is liquidation?
  const runway = sigmaHorizon > 0 ? liqDist / sigmaHorizon : 99;
  checks.push({
    id: 'runway', label: 'Liquidation runway',
    status: runway < 2 ? 'fail' : runway < 3.5 ? 'caution' : 'pass',
    readout: `${runway >= 99 ? '99+' : runway.toFixed(1)}σ`,
    headline: `Liquidation at ${liq.toFixed(inst.pricePlace)}, ${fmtPct(liqDist, 1, false)} from entry.`,
    detail: `A normal ${plan.horizonH}h move in ${inst.base} is ${fmtPct(sigmaHorizon, 1, false)}. Liquidation sits ${runway.toFixed(1)} of those away. Under 2 is a coin toss on noise alone.`,
  });

  // 2. Gap shock: stops do not fill inside a gap.
  const gapStatus: CheckStatus = shock >= liqDist ? 'fail' : lossAtShock > 2 * lossAtStop || shock >= 0.7 * liqDist ? 'caution' : 'pass';
  const crossText = inst.cls !== 'rwa' ? 'Crypto has no closing bell, but it does have flash moves.'
    : opensCrossed === 0 ? 'This flight lands before the next opening bell.'
    : `This flight crosses ${opensCrossed} opening bell${opensCrossed > 1 ? 's' : ''}; each is a chance to gap past a stop.`;
  checks.push({
    id: 'gap', label: 'Gap shock',
    status: gapStatus,
    readout: fmtPct(-shock, 1),
    headline: shock >= liqDist
      ? `A ${fmtPct(shock, 1, false)} move liquidates this position. ${observed >= 4 * sigmaDay ? `${inst.base} printed one in the last ${daily.length} sessions.` : `That is a 4-sigma day for ${inst.base}.`}`
      : `Survives a ${fmtPct(shock, 1, false)} shock with ${fmtUsd(lossAtShock)} USDT lost.`,
    detail: `Shock size: ${shockSource} (${fmtPct(shock, 1, false)}). ${crossText} Loss at the shock is ${fmtUsd(lossAtShock)} USDT against ${fmtUsd(lossAtStop)} planned.`,
  });

  // 3. Earnings: a known date on which the stop stops being the risk.
  const cal = m.earnings ?? earningsCalendar(now);
  const next = inst.cls === 'rwa' ? cal[plan.symbol] : undefined;
  const crossing = next !== undefined && next.at <= now + plan.horizonH * HOUR;
  const bigDay = Math.max(observed, 4 * sigmaDay);
  const lossThrough = Math.min(plan.margin, notional * bigDay + fees);
  const throughPct = lossThrough / equity;
  const label = next ? `${zulu(next.at)}${next.announced ? '' : ' (estimated date)'}` : '';
  checks.push({
    id: 'earnings', label: 'Earnings',
    status: !crossing ? 'pass' : bigDay >= liqDist || throughPct > 0.05 ? 'fail' : 'caution',
    readout: inst.cls !== 'rwa' || inst.etf ? 'n/a' : !next ? 'no date' : crossing ? 'IN HOLD' : 'clear',
    headline: inst.cls !== 'rwa' ? 'No earnings on a crypto perp.'
      : inst.etf ? `${inst.base} is an index fund with no earnings date of its own.`
      : !next ? `No ${inst.base} earnings date on file. Check before a long hold.`
      : !crossing ? `Lands before ${inst.base} reports on ${label}.`
      : bigDay >= liqDist ? `Holds through ${inst.base} earnings on ${label}. A ${fmtPct(bigDay, 1, false)} reaction liquidates it.`
      : `Holds through ${inst.base} earnings on ${label}.`,
    detail: crossing
      ? `Results come out with New York closed, so the perp takes the whole reaction at once and the stop does not fill inside it. ${inst.base}'s largest one-day move in ${daily.length} sessions was ${fmtPct(observed, 1, false)}. At that size the loss is ${fmtUsd(lossThrough)} USDT, ${fmtPct(throughPct, 1, false)} of the account, whatever the stop says.`
      : inst.cls === 'rwa' ? 'A hold that crosses a results date is judged on the gap, not on the stop.' : 'Applies to stock perps only.',
  });

  // 4. Regime replay: fly the same plan through every past window.
  const liqRate = rp.windows ? rp.liquidated / rp.windows : 0;
  const replayStatus: CheckStatus = rp.windows < 10 ? 'caution' : liqRate >= 0.05 ? 'fail' : liqRate > 0 || rp.meanPnl < 0 ? 'caution' : 'pass';
  checks.push({
    id: 'replay', label: 'Regime replay',
    status: replayStatus,
    readout: rp.windows ? `${rp.liquidated}/${rp.windows}` : 'n/a',
    headline: rp.windows < 10 ? 'Not enough history to replay this horizon.'
      : `Flown through ${rp.windows} past ${rp.basis} windows: ${rp.target} reached target, ${rp.stopped} stopped out, ${rp.liquidated} liquidated.`,
    detail: `Average result ${fmtUsd(rp.meanPnl)} USDT per flight, worst ${fmtUsd(rp.worstPnl)}, best ${fmtUsd(rp.bestPnl)}. ${rp.timeout} ran out of time before either level.`,
  });

  // 5. Stop integrity.
  const stopDist = sState === 'valid' ? Math.abs(plan.entry - (plan.stop as number)) / plan.entry : 0;
  const stopStatus: CheckStatus = sState !== 'valid' ? 'fail' : stopDist < 0.35 * sigmaHorizon ? 'caution' : 'pass';
  checks.push({
    id: 'stop', label: 'Stop integrity',
    status: stopStatus,
    readout: sState === 'valid' ? fmtPct(-stopDist, 1) : 'NONE',
    headline: sState === 'none' ? 'No stop filed. The only exit below is liquidation.'
      : sState === 'wrong-side' ? 'The stop is on the profit side of the entry.'
      : sState === 'beyond-liq' ? `The stop sits beyond liquidation (${liq.toFixed(inst.pricePlace)}). It can never fill.`
      : stopStatus === 'caution' ? 'The stop is inside normal noise for this horizon.'
      : `Stop ${fmtPct(stopDist, 1, false)} from entry, clear of noise and inside liquidation.`,
    detail: sState === 'valid'
      ? `Stop at ${(plan.stop as number).toFixed(inst.pricePlace)}; a normal ${plan.horizonH}h move is ${fmtPct(sigmaHorizon, 1, false)}. Loss at the stop: ${fmtUsd(lossAtStop)} USDT including fees and slippage.`
      : `Without a working stop the whole margin (${fmtUsd(plan.margin)} USDT) is the risk.`,
  });

  // 6. Payoff.
  const breakeven = rr > 0 ? 1 / (1 + rr) : 1;
  // judge the hit rate only on flights that reached a level, not on timeouts
  const resolved = rp.target + rp.stopped + rp.liquidated;
  const hit = resolved ? rp.target / resolved : 0;
  const payoffStatus: CheckStatus = !hasTarget ? (plan.target === undefined ? 'caution' : 'fail')
    : rr < 0.5 ? 'fail' : rr < 1 || (resolved >= 10 && hit < breakeven) ? 'caution' : 'pass';
  checks.push({
    id: 'payoff', label: 'Payoff',
    status: payoffStatus,
    readout: hasTarget ? `${rr.toFixed(2)}R` : 'NONE',
    headline: !hasTarget ? (plan.target === undefined ? 'No target filed, so the payoff cannot be judged.' : 'The target is on the loss side of the entry.')
      : `Risking ${fmtUsd(lossAtStop)} to make ${fmtUsd(reward)} USDT: ${rr.toFixed(2)} to 1.`,
    detail: hasTarget
      ? `This needs to win ${fmtPct(breakeven, 0, false)} of the time to break even. Of the ${resolved} replayed flights that reached a level, ${fmtPct(hit, 0, false)} reached the target.`
      : 'File a target to compare reward against risk.',
  });

  // 7. Fees and funding.
  const costs = fees + Math.max(0, funding);
  const dragBase = hasTarget ? reward + costs : lossAtStop;
  const drag = dragBase > 0 ? costs / dragBase : 0;
  checks.push({
    id: 'drag', label: 'Fees and funding',
    status: drag > 0.35 ? 'fail' : drag > 0.15 ? 'caution' : 'pass',
    readout: fmtPct(drag, 0, false),
    headline: `Round-trip fees ${fmtUsd(fees)} USDT, funding ${fmtUsd(funding)} over ${plan.horizonH}h.`,
    detail: `Costs take ${fmtPct(drag, 0, false)} of the ${hasTarget ? 'gross reward' : 'planned risk'}. Taker fee ${fmtPct(inst.takerFee, 2, false)} per side, funding ${fmtPct(rate, 4)} per 8h.`,
  });

  // 8. Risk to account.
  checks.push({
    id: 'exposure', label: 'Risk to account',
    status: riskPct > 0.05 ? 'fail' : riskPct > 0.02 ? 'caution' : 'pass',
    readout: fmtPct(riskPct, 1, false),
    headline: `${fmtUsd(lossAtStop)} USDT at risk, ${fmtPct(riskPct, 1, false)} of a ${fmtUsd(equity, 0)} USDT account.`,
    detail: 'Under 2% per flight leaves room to be wrong many times in a row. Over 5% does not.',
  });

  return {
    checks, replay: rp, liq, costs: { fees, fundingPerHour }, slip,
    numbers: {
      notional, qty, liqPrice: liq, liqDist, sigmaDay, sigmaHorizon, shock, shockSource,
      lossAtStop, lossAtShock, reward, fees, funding, rr, riskPct, usOpen, opensCrossed,
      earningsAt: crossing && next ? next.at : null,
    },
  };
}

const failing = (core: Core) => core.checks.filter((c) => c.status === 'fail');

/** The largest version of this plan with no failed check: the magenta bug on the tape. */
function guide(plan: FlightPlan, inst: Instrument, m: MarketState, now: number, equity: number): Guidance {
  const fails = (p: FlightPlan) => failing(runChecks(p, inst, m, now, equity));
  let lo = 1, hi = Math.min(plan.leverage, inst.maxLever);
  const atOne = { ...plan, leverage: 1 };
  let margin = plan.margin;

  // If it fails even unlevered, see whether a smaller margin fixes it.
  if (fails(atOne).length) {
    const core = runChecks(atOne, inst, m, now, equity);
    const onlyExposure = failing(core).every((c) => c.id === 'exposure');
    if (onlyExposure) {
      margin = Math.floor((plan.margin * 0.045) / core.numbers.riskPct);
      if (margin >= 5 && !fails({ ...atOne, margin }).length) return { fixable: true, leverage: 1, margin, blockers: [] };
    }
    return { fixable: false, leverage: plan.leverage, margin: plan.margin, blockers: failing(core).map((c) => c.label) };
  }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fails({ ...plan, leverage: mid }).length) hi = mid; else lo = mid;
  }
  // Bitget sets leverage in whole numbers, so the answer is one the exchange can take.
  const leverage = Math.max(1, Math.floor(lo + 1e-9));
  return { fixable: true, leverage, margin, blockers: [] };
}

export function preflight(plan: FlightPlan, m: MarketState, now: number, equity: number): PreflightReport {
  const inst = m.instruments[plan.symbol];
  if (!inst) throw new Error(`Unknown instrument ${plan.symbol}`);
  const core = runChecks(plan, inst, m, now, equity);
  const status = worst(core.checks.map((c) => c.status));
  const hash = planHash(plan);
  const guidance: Guidance = status === 'fail'
    ? guide(plan, inst, m, now, equity)
    : { fixable: true, leverage: plan.leverage, margin: plan.margin, blockers: [] };
  return {
    planHash: hash, at: now, plan,
    verdict: status === 'fail' ? 'NO-GO' : status === 'caution' ? 'CAUTION' : 'GO',
    checks: core.checks, numbers: core.numbers, replay: core.replay,
    monteCarlo: monteCarlo(plan, core.liq, m, core.replay.basis, core.costs, core.slip, seedFrom(hash)),
    guidance,
  };
}
