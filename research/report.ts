// THE STUDY, part 2: read the flights from research/out and print the tables.
//
//   tsx research/report.ts            every scenario that has been run
//
// Writes research/RESULTS.md (the tables) and research/results.json (the same
// numbers for anything that wants to read them).

import fs from 'node:fs';
import path from 'node:path';
import { isUsOpen } from '../src/core/calendar';
import { INSTRUMENTS } from '../src/core/market';
import { DAY, HOUR } from '../src/core/util';
import { dayBootstrap, mean, quantile, shortfall } from './lib';
import { EQUITY, FLAT_CAPS, LEVERAGES, MARGIN, SCENARIOS, Scenario, Trade } from './run';

const here = path.dirname(process.argv[1]);
const usd = (x: number, dp = 2) => (Number.isFinite(x) ? (x < 0 ? '-' : '') + Math.abs(x).toFixed(dp) : 'n/a');
const pct = (x: number, dp = 1) => (Number.isFinite(x) ? (x * 100).toFixed(dp) + '%' : 'n/a');
const int = (x: number) => x.toLocaleString('en-US');
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i ? '---:' : '---')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const A = (t: Trade) => t.a[0];
/** Re-routed result; a plan the deck would not fly at any size is a trade not taken. */
const B = (t: Trade) => (t.b ? t.b[0] : 0);
const C = (t: Trade) => (t.c ? t.c[0] : 0);
const liqA = (t: Trade) => t.a[1] === 'liquidated';
const liqB = (t: Trade) => t.b?.[1] === 'liquidated';
const liqC = (t: Trade) => t.c?.[1] === 'liquidated';
const share = <T>(xs: T[], f: (x: T) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);
const notionalB = (t: Trade) => (t.b ? t.bLev * t.bMargin : 0);

function byDay(trades: Trade[]): Trade[][] {
  const m = new Map<number, Trade[]>();
  for (const t of trades) { const d = Math.floor(t.t / DAY); if (!m.has(d)) m.set(d, []); m.get(d)!.push(t); }
  return [...m.values()];
}
const ci = (trades: Trade[], stat: (rows: Trade[]) => number, fmt: (x: number) => string) => {
  const [lo, hi] = dayBootstrap(byDay(trades), stat);
  return `${fmt(lo)} to ${fmt(hi)}`;
};

function arm(trades: Trade[], pnl: (t: Trade) => number, liq: (t: Trade) => boolean) {
  const xs = trades.map(pnl);
  return { n: trades.length, liq: share(trades, liq), mean: mean(xs), median: quantile(xs, 0.5), es5: shortfall(xs, 0.05), worst: Math.min(...xs), best: Math.max(...xs), lossOver2: share(xs, (x) => x <= -0.02 * EQUITY) };
}

/** One trade per hold, back to back, for every start offset: what a month of the habit does. */
function chains(trades: Trade[], horizonH: number, pnl: (t: Trade) => number, liq: (t: Trade) => boolean) {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) { const k = `${t.symbol}|${t.side}|${t.lev}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
  const finals: number[] = [], dds: number[] = [], liqs: number[] = [], lens: number[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.t - b.t);
    const t0 = g[0].t;
    for (let off = 0; off < horizonH; off++) {
      let eq = 0, peak = 0, dd = 0, n = 0, k = 0;
      for (const t of g) {
        if (((t.t - t0) / HOUR - off) % horizonH !== 0 || (t.t - t0) / HOUR < off) continue;
        eq += pnl(t); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); n++; if (liq(t)) k++;
      }
      if (n) { finals.push(eq); dds.push(dd); liqs.push(k); lens.push(n); }
    }
  }
  return { chains: finals.length, tradesPerChain: mean(lens), liqPerChain: mean(liqs), anyLiq: share(liqs, (x) => x > 0), finalMean: mean(finals), finalMedian: quantile(finals, 0.5), ddMedian: quantile(dds, 0.5), ddWorst: Math.max(...dds), final5: quantile(finals, 0.05) };
}

function analyse(sc: Scenario, trades: Trade[]) {
  const md: string[] = [];
  const json: Record<string, unknown> = {};
  const days = byDay(trades).length;
  const first = Math.min(...trades.map((t) => t.t)), last = Math.max(...trades.map((t) => t.t));
  md.push(`## ${sc.label}`, '');
  md.push(`${int(trades.length)} plans filed, entered between ${new Date(first).toISOString().slice(0, 16).replace('T', ' ')} and ${new Date(last).toISOString().slice(0, 16).replace('T', ' ')} UTC (${days} calendar days), on ${new Set(trades.map((t) => t.symbol)).size} contracts, long and short. Each plan commits ${MARGIN} USDT of margin from a ${int(EQUITY)} USDT account${sc.stopPct ? `, with a stop ${pct(sc.stopPct)} from entry and a target ${pct(sc.targetPct ?? 0)} away` : ', with no stop and no target'}, and is held for at most ${sc.horizonH} hours. All results are in USDT per plan, after taker fees on both sides.`, '');

  // 1. headline -----------------------------------------------------------------
  const rows: (string | number)[][] = [];
  const head: Record<string, unknown> = {};
  for (const lev of [...LEVERAGES, 0]) {
    const g = lev ? trades.filter((t) => t.lev === lev) : trades;
    const a = arm(g, A, liqA), b = arm(g, B, liqB), c = arm(g, C, liqC);
    const name = lev ? `${lev}x` : 'All';
    head[name] = { asFiled: a, rerouted: b, reroutedWatched: c, noRoute: share(g, (t) => !t.b), meanReroutedLeverage: mean(g.filter((t) => t.b).map((t) => t.bLev)), forecastLiquidation: mean(g.map((t) => t.mcLiq)) };
    rows.push([`${name} as filed`, int(a.n), pct(a.liq), usd(a.mean), usd(a.median), usd(a.es5), usd(a.worst), pct(a.lossOver2)]);
    rows.push([`${name} re-routed`, int(b.n), pct(b.liq), usd(b.mean), usd(b.median), usd(b.es5), usd(b.worst), pct(b.lossOver2)]);
    rows.push([`${name} re-routed + Night Watch`, int(c.n), pct(c.liq), usd(c.mean), usd(c.median), usd(c.es5), usd(c.worst), pct(c.lossOver2)]);
  }
  md.push('### 1. What happened to the plans', '');
  md.push(table(['Filed leverage', 'Plans', 'Liquidated', 'Mean', 'Median', 'Mean of worst 5%', 'Worst', 'Lost over 2% of account'], rows), '');
  const noRoute = share(trades, (t) => !t.b);
  const changed = share(trades, (t) => Boolean(t.b) && (t.bLev !== t.lev || t.bMargin !== MARGIN || t.bStopAdded));
  const asIs = share(trades, (t) => Boolean(t.b) && t.bLev === t.lev && t.bMargin === MARGIN && !t.bStopAdded);
  md.push(`Of all plans, ${pct(asIs)} cleared exactly as filed, ${pct(changed)} were re-routed to a smaller size${sc.stopPct ? '' : ' with a stop added'}, and ${pct(noRoute)} were refused at any size (those count as a trade not taken, result 0). The average re-routed leverage was ${mean(trades.filter((t) => t.b).map((t) => t.bLev)).toFixed(1)}x.`, '');
  md.push('95% intervals, resampling whole entry days:', '');
  md.push(table(['Quantity', 'Estimate', '95% interval'], [
    ['Liquidation rate, as filed', pct(share(trades, liqA)), ci(trades, (r) => share(r, liqA), (x) => pct(x))],
    ['Liquidation rate at 50x, as filed', pct(share(trades.filter((t) => t.lev === 50), liqA)), ci(trades.filter((t) => t.lev === 50), (r) => share(r, liqA), (x) => pct(x))],
    ['Preflight forecast of that rate, made before entry (average)', pct(mean(trades.filter((t) => t.lev === 50).map((t) => t.mcLiq))), 'n/a'],
    ['Liquidation rate, re-routed', pct(share(trades, liqB)), ci(trades, (r) => share(r, liqB), (x) => pct(x))],
    ['Mean of worst 5%, as filed', usd(shortfall(trades.map(A))), ci(trades, (r) => shortfall(r.map(A)), (x) => usd(x))],
    ['Mean of worst 5%, re-routed', usd(shortfall(trades.map(B))), ci(trades, (r) => shortfall(r.map(B)), (x) => usd(x))],
    ['Mean result, as filed', usd(mean(trades.map(A))), ci(trades, (r) => mean(r.map(A)), (x) => usd(x))],
    ['Mean result, re-routed', usd(mean(trades.map(B))), ci(trades, (r) => mean(r.map(B)), (x) => usd(x))],
    ['Mean result, re-routed minus as filed', usd(mean(trades.map((t) => B(t) - A(t)))), ci(trades, (r) => mean(r.map((t) => B(t) - A(t))), (x) => usd(x))],
  ]), '');
  json.headline = head;
  json.shares = { clearedAsFiled: asIs, rerouted: changed, noRoute };

  // the same results per unit of exposure: sizing should not change this, and it is the honest way to compare
  const notA = trades.reduce((s, t) => s + t.lev * MARGIN, 0), notB = trades.reduce((s, t) => s + notionalB(t), 0);
  const per = { asFiled: (trades.reduce((s, t) => s + A(t), 0) / notA) * 1000, rerouted: (trades.reduce((s, t) => s + B(t), 0) / notB) * 1000, fees: -1.2 };
  md.push(`Per 1,000 USDT of exposure the mean result was ${usd(per.asFiled)} as filed and ${usd(per.rerouted)} re-routed; taker fees alone are -1.20. Average exposure per plan was ${int(Math.round(notA / trades.length))} USDT as filed and ${int(Math.round(notB / trades.length))} re-routed.`, '');
  json.perThousand = { ...per, meanNotionalAsFiled: notA / trades.length, meanNotionalRerouted: notB / trades.length };

  const mid = (first + last) / 2;
  const halves = [['First half', trades.filter((t) => t.t < mid)], ['Second half', trades.filter((t) => t.t >= mid)]] as [string, Trade[]][];
  md.push('The same figures for each half of the period, to show they do not come from one stretch of market:', '');
  md.push(table(['Period', 'Plans', 'Liquidated as filed', 'Liquidated at 50x as filed', 'Average forecast at 50x', 'Liquidated re-routed', 'Mean as filed', 'Mean re-routed', 'Worst 5% as filed', 'Worst 5% re-routed'], halves.map(([name, g]) => {
    const g50 = g.filter((t) => t.lev === 50);
    return [name, int(g.length), pct(share(g, liqA)), pct(share(g50, liqA)), pct(mean(g50.map((t) => t.mcLiq))), pct(share(g, liqB)), usd(mean(g.map(A))), usd(mean(g.map(B))), usd(shortfall(g.map(A))), usd(shortfall(g.map(B)))];
  })), '');
  json.halves = halves.map(([name, g]) => ({ name, n: g.length, liqA: share(g, liqA), liq50: share(g.filter((t) => t.lev === 50), liqA), forecast50: mean(g.filter((t) => t.lev === 50).map((t) => t.mcLiq)), liqB: share(g, liqB), meanA: mean(g.map(A)), meanB: mean(g.map(B)), es5A: shortfall(g.map(A)), es5B: shortfall(g.map(B)) }));

  // 2. the price of safety --------------------------------------------------------
  const winners = trades.filter((t) => A(t) > 0), losers = trades.filter((t) => A(t) < 0);
  const kept = mean(winners.map(B)) / mean(winners.map(A)), avoided = 1 - mean(losers.map(B)) / mean(losers.map(A));
  md.push('### 2. What the smaller size costs', '');
  md.push(table(['Plans that, as filed', 'Plans', 'Mean as filed', 'Mean re-routed', 'Re-routed keeps'], [
    ['made money', int(winners.length), usd(mean(winners.map(A))), usd(mean(winners.map(B))), pct(kept) + ' of the gain'],
    ['lost money', int(losers.length), usd(mean(losers.map(A))), usd(mean(losers.map(B))), pct(1 - avoided) + ' of the loss'],
  ]), '');
  json.cost = { winners: winners.length, losers: losers.length, gainKept: kept, lossAvoided: avoided, meanWinA: mean(winners.map(A)), meanWinB: mean(winners.map(B)), meanLossA: mean(losers.map(A)), meanLossB: mean(losers.map(B)) };

  // 3. more than arithmetic? ------------------------------------------------------
  const totalB = trades.reduce((s, t) => s + notionalB(t), 0);
  const flatTotals = FLAT_CAPS.map((k) => trades.reduce((s, t) => s + Math.min(t.lev, k) * MARGIN, 0));
  let ki = 0;
  flatTotals.forEach((v, i) => { if (Math.abs(v - totalB) < Math.abs(flatTotals[ki] - totalB)) ki = i; });
  const K = FLAT_CAPS[ki];
  const F = (t: Trade) => t.flat[ki];
  // scale the flat rule's margin so both rules carry exactly the same total exposure
  const scale = totalB / flatTotals[ki];
  const Fs = (t: Trade) => F(t) * scale;
  const flatLiq = (t: Trade) => F(t) <= -MARGIN + 1e-6;
  const bArm = arm(trades, B, liqB), fArm = arm(trades, Fs, flatLiq);
  md.push('### 3. Is the re-route more than "use less leverage"?', '');
  md.push(`The control is the simplest rule there is: never more than ${K}x, on every contract, at every hour, with margin scaled by ${scale.toFixed(3)} so that it carries exactly the same total exposure as the re-routes (${int(Math.round(totalB))} USDT of notional across all plans). If FLIGHTDECK's checks carry no information, the two rows are the same.`, '');
  md.push(table(['Rule', 'Liquidated', 'Mean', 'Mean of worst 5%', 'Worst', 'Lost over 2% of account'], [
    ['FLIGHTDECK re-route', pct(bArm.liq), usd(bArm.mean), usd(bArm.es5), usd(bArm.worst), pct(bArm.lossOver2)],
    [`Flat ${K}x, same exposure`, pct(fArm.liq), usd(fArm.mean), usd(fArm.es5), usd(fArm.worst), pct(fArm.lossOver2)],
  ]), '');
  md.push(table(['Difference, re-route minus flat rule', 'Estimate', '95% interval'], [
    ['Mean result', usd(bArm.mean - fArm.mean), ci(trades, (r) => mean(r.map((t) => B(t) - Fs(t))), (x) => usd(x))],
    ['Mean of worst 5%', usd(bArm.es5 - fArm.es5), ci(trades, (r) => shortfall(r.map(B)) - shortfall(r.map(Fs)), (x) => usd(x))],
  ]), '');
  json.control = { cap: K, scale, totalNotional: totalB, reroute: bArm, flat: fArm };

  // Does the re-route cut harder where the next hours turned out rougher? Hold leverage fixed and look.
  const i5 = FLAT_CAPS.indexOf(5);
  const lg: [string, (t: Trade) => boolean][] = [['5x or less', (t) => Boolean(t.b) && t.bLev <= 5], ['6x to 9x', (t) => Boolean(t.b) && t.bLev > 5 && t.bLev < 10], ['10x or more', (t) => Boolean(t.b) && t.bLev >= 10]];
  const sd = (xs: number[]) => { const m0 = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m0) ** 2))); };
  const risk = lg.map(([name, f]) => { const g = trades.filter(f); const xs = g.map((t) => t.flat[i5]); return { name, n: g.length, sd: sd(xs), es5: shortfall(xs), stopped: share(g, (t) => t.a[1] === 'stopped' || t.a[1] === 'liquidated') }; });
  md.push('Every plan flown at the same 5x, grouped by the leverage the re-route gave it. If the re-route cuts harder where the following hours were rougher, the first row should show the most risk:', '');
  md.push(table(['Re-route gave', 'Plans', 'Spread of results at a fixed 5x', 'Worst 5% at a fixed 5x'], risk.filter((r) => r.n).map((r) => [r.name, int(r.n), usd(r.sd), usd(r.es5)])), '');
  json.riskByReroute = risk;

  // 4. calibration ----------------------------------------------------------------
  const bins: [string, number, number][] = [['0%', -1, 0], ['0 to 1%', 0, 0.01], ['1 to 5%', 0.01, 0.05], ['5 to 20%', 0.05, 0.2], ['20 to 50%', 0.2, 0.5], ['over 50%', 0.5, 1.01]];
  const cal = bins.map(([name, lo, hi]) => {
    const g = trades.filter((t) => t.mcLiq > lo && t.mcLiq <= hi);
    return { name, n: g.length, predicted: mean(g.map((t) => t.mcLiq)), realised: share(g, liqA) };
  });
  const base = share(trades, liqA);
  const brier = mean(trades.map((t) => (t.mcLiq - (liqA(t) ? 1 : 0)) ** 2)), brier0 = mean(trades.map((t) => (base - (liqA(t) ? 1 : 0)) ** 2));
  md.push('### 4. Were the pre-trade probabilities right?', '');
  md.push('Before each entry Preflight estimates the chance that the plan as filed is liquidated (1,000 bootstrap paths built from past bars only). This compares that estimate with what then happened.', '');
  md.push(table(['Preflight said', 'Plans', 'Average forecast', 'Actually liquidated'], cal.filter((c) => c.n).map((c) => [c.name, int(c.n), pct(c.predicted), pct(c.realised)])), '');
  md.push(`Brier score ${brier.toFixed(4)} against ${brier0.toFixed(4)} for always forecasting the base rate (${pct(base)}): a skill score of ${pct(1 - brier / brier0, 0)}. Zero means no better than the base rate, 100% is a perfect forecast.`, '');
  // Leverage alone explains most of that. The harder question: among plans at the SAME leverage, did a higher forecast mean more liquidations?
  const top = trades.filter((t) => t.mcLiq > 0);
  const within: Record<string, unknown> = {};
  if (top.length > 100) {
    const levs = [...new Set(top.map((t) => t.lev))].sort((a, b) => a - b);
    const rowsW: (string | number)[][] = [];
    for (const lev of levs) {
      const g = top.filter((t) => t.lev === lev).sort((a, b) => a.mcLiq - b.mcLiq);
      if (g.length < 300) continue;
      const third = Math.floor(g.length / 3);
      const parts3 = [g.slice(0, third), g.slice(third, 2 * third), g.slice(2 * third)];
      const pos = g.filter(liqA), neg = g.filter((t) => !liqA(t));
      // rank-sum form of the area under the ROC curve; ties count half
      const sorted = [...g].sort((a, b) => a.mcLiq - b.mcLiq);
      let rankSum = 0;
      for (let i = 0; i < sorted.length;) { let j = i; while (j < sorted.length && sorted[j].mcLiq === sorted[i].mcLiq) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (liqA(sorted[k])) rankSum += r; i = j; }
      const auc = pos.length && neg.length ? (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length) : NaN;
      const aucOf = (rows: Trade[]) => { const s2 = [...rows].sort((a, b) => a.mcLiq - b.mcLiq); const p2 = rows.filter(liqA).length, n2 = rows.length - p2; if (!p2 || !n2) return NaN; let rs = 0; for (let i = 0; i < s2.length;) { let j = i; while (j < s2.length && s2[j].mcLiq === s2[i].mcLiq) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (liqA(s2[k])) rs += r; i = j; } return (rs - (p2 * (p2 + 1)) / 2) / (p2 * n2); };
      const aucCi = ci(g, aucOf, (x) => x.toFixed(2));
      parts3.forEach((part, i) => rowsW.push([`${lev}x, ${['lowest', 'middle', 'highest'][i]} third of forecasts`, int(part.length), pct(mean(part.map((t) => t.mcLiq))), pct(share(part, liqA))]));
      const aucAll = aucOf(trades.filter((t) => t.lev === lev));
      md.push(`Among the ${int(g.length)} plans at ${lev}x that had a forecast above zero, the forecast ranked a plan that was later liquidated above one that was not ${pct(auc, 0)} of the time (area under the ROC curve ${auc.toFixed(2)}, 95% interval ${aucCi}; 0.50 is a coin toss). Counting the plans forecast at exactly zero as well, ${aucAll.toFixed(2)}.`, '');
      within[`${lev}x`] = { n: g.length, auc, aucAllPlans: aucAll, thirds: parts3.map((part) => ({ n: part.length, forecast: mean(part.map((t) => t.mcLiq)), realised: share(part, liqA) })) };
    }
    if (rowsW.length) md.push(table(['Plans at one leverage, sorted by forecast', 'Plans', 'Average forecast', 'Actually liquidated'], rowsW), '');
  }
  // the same question for the commoner event: ending at the stop or at liquidation
  const lossHit = (t: Trade) => t.a[1] === 'stopped' || t.a[1] === 'liquidated';
  const lb: [string, number, number][] = [['under 5%', -1, 0.05], ['5 to 10%', 0.05, 0.1], ['10 to 20%', 0.1, 0.2], ['20 to 35%', 0.2, 0.35], ['over 35%', 0.35, 1.01]];
  const calLoss = lb.map(([name, lo, hi]) => { const g = trades.filter((t) => t.mcLoss > lo && t.mcLoss <= hi); return { name, n: g.length, predicted: mean(g.map((t) => t.mcLoss)), realised: share(g, lossHit) }; });
  const baseL = share(trades, lossHit);
  const brierL = mean(trades.map((t) => (t.mcLoss - (lossHit(t) ? 1 : 0)) ** 2)), brierL0 = mean(trades.map((t) => (baseL - (lossHit(t) ? 1 : 0)) ** 2));
  if (sc.stopPct) {
    md.push('The same comparison for the commoner event, the plan ending at its stop or at liquidation:', '');
    md.push(table(['Preflight said', 'Plans', 'Average forecast', 'Actually stopped or liquidated'], calLoss.filter((c) => c.n).map((c) => [c.name, int(c.n), pct(c.predicted), pct(c.realised)])), '');
    md.push(`Brier score ${brierL.toFixed(4)} against ${brierL0.toFixed(4)} for the base rate (${pct(baseL)}): skill ${pct(1 - brierL / brierL0, 0)}.`, '');
  }
  json.calibration = { bins: cal, brier, brierBaseRate: brier0, skill: 1 - brier / brier0, baseRate: base, withinLeverage: within, loss: { bins: calLoss, brier: brierL, brierBaseRate: brierL0, skill: 1 - brierL / brierL0, baseRate: baseL } };

  // 5. verdicts -------------------------------------------------------------------
  const ver = (['GO', 'CAUTION', 'NO-GO'] as const).map((v) => ({ v, ...arm(trades.filter((t) => t.verdict === v), A, liqA) }));
  const tow = [true, false].map((c) => ({ v: c ? 'Tower would clear as filed' : 'Tower refuses as filed', ...arm(trades.filter((t) => t.cleared === c), A, liqA) }));
  md.push('### 5. Did the verdict separate good plans from bad ones?', '');
  md.push('Every plan flown exactly as filed, grouped by what Preflight and the Tower said about it beforehand.', '');
  md.push(table(['Said beforehand', 'Plans', 'Liquidated', 'Mean', 'Mean of worst 5%', 'Worst'], [...ver, ...tow].filter((r) => r.n).map((r) => [r.v, int(r.n), pct(r.liq), usd(r.mean), usd(r.es5), usd(r.worst)])), '');
  json.verdicts = { preflight: ver, tower: tow };

  // 6. the 2-sigma line -------------------------------------------------------------
  const rb: [string, number, number][] = [['under 1', 0, 1], ['1 to 1.5', 1, 1.5], ['1.5 to 2', 1.5, 2], ['2 to 2.5', 2, 2.5], ['2.5 to 3.5', 2.5, 3.5], ['3.5 to 6', 3.5, 6], ['over 6', 6, 1e9]];
  const run = rb.map(([name, lo, hi]) => { const g = trades.filter((t) => t.runway >= lo && t.runway < hi); return { name, n: g.length, liq: share(g, liqA), mean: mean(g.map(A)) }; });
  md.push('### 6. Is the runway threshold in the right place?', '');
  md.push('Preflight fails a plan whose liquidation price is under 2 normal moves away and cautions under 3.5. Liquidations as filed, by that distance:', '');
  md.push(table(['Runway (normal moves to liquidation)', 'Plans', 'Liquidated', 'Mean result'], run.filter((r) => r.n).map((r) => [r.name, int(r.n), pct(r.liq), usd(r.mean)])), '');
  const liqAll = trades.filter(liqA);
  const zone = { fail: share(liqAll, (t) => t.runway < 2), caution: share(liqAll, (t) => t.runway >= 2 && t.runway < 3.5), pass: share(liqAll, (t) => t.runway >= 3.5) };
  if (liqAll.length) md.push(`Of the ${int(liqAll.length)} liquidations, ${pct(zone.fail)} were in plans the runway check fails, ${pct(zone.caution)} in plans it cautions and ${pct(zone.pass)} in plans it passes. The runway is set by the contract, the leverage and the contract's recent volatility, so within one test these bands are largely labels for leverage and contract.`, '');
  json.runway = run; json.runwayZones = zone;

  // 7. where it matters -------------------------------------------------------------
  const cuts: [string, (t: Trade) => boolean][] = [
    ['Stock perps, New York open at entry', (t) => INSTRUMENTS[t.symbol].cls === 'rwa' && isUsOpen(t.t)],
    ['Stock perps, New York closed at entry', (t) => INSTRUMENTS[t.symbol].cls === 'rwa' && !isUsOpen(t.t)],
    ['BTC', (t) => INSTRUMENTS[t.symbol].cls === 'crypto'],
    ['Long', (t) => t.side === 'long'],
    ['Short', (t) => t.side === 'short'],
    ...Object.keys(INSTRUMENTS).map((s) => [INSTRUMENTS[s].base, (t: Trade) => t.symbol === s] as [string, (t: Trade) => boolean]),
  ];
  const seg = cuts.map(([name, f]) => { const g = trades.filter(f); return { name, n: g.length, a: arm(g, A, liqA), b: arm(g, B, liqB), lev: mean(g.filter((t) => t.b).map((t) => t.bLev)) }; });
  md.push('### 7. By session, side and contract', '');
  md.push(table(['Group', 'Plans', 'Liquidated as filed', 'Liquidated re-routed', 'Mean as filed', 'Mean re-routed', 'Worst 5% as filed', 'Worst 5% re-routed', 'Avg re-routed leverage'], seg.filter((s) => s.n).map((s) => [s.name, int(s.n), pct(s.a.liq), pct(s.b.liq), usd(s.a.mean), usd(s.b.mean), usd(s.a.es5), usd(s.b.es5), s.lev.toFixed(1) + 'x'])), '');
  json.segments = seg;

  // 8. a month of the habit -----------------------------------------------------------
  md.push('### 8. One plan after another for the whole period', '');
  md.push(`The same plan re-entered every ${sc.horizonH} hours with no overlap, for every contract, side, leverage and starting hour. This is what the habit does to an account over the period, not what one trade does. The sequences share the same days and differ only in contract, side and starting hour, so they are far from independent.`, '');
  const ch: (string | number)[][] = [];
  const chJson: Record<string, unknown> = {};
  for (const lev of LEVERAGES) {
    const g = trades.filter((t) => t.lev === lev);
    if (!g.length) continue;
    const a = chains(g, sc.horizonH, A, liqA), b = chains(g, sc.horizonH, B, liqB), c = chains(g, sc.horizonH, C, liqC);
    chJson[`${lev}x`] = { asFiled: a, rerouted: b, reroutedWatched: c };
    ch.push([`${lev}x as filed`, int(a.chains), a.tradesPerChain.toFixed(1), a.liqPerChain.toFixed(2), pct(a.anyLiq), usd(a.finalMedian), usd(a.final5), usd(a.ddMedian), usd(a.ddWorst)]);
    ch.push([`${lev}x re-routed`, int(b.chains), b.tradesPerChain.toFixed(1), b.liqPerChain.toFixed(2), pct(b.anyLiq), usd(b.finalMedian), usd(b.final5), usd(b.ddMedian), usd(b.ddWorst)]);
    ch.push([`${lev}x re-routed + Night Watch`, int(c.chains), c.tradesPerChain.toFixed(1), c.liqPerChain.toFixed(2), pct(c.anyLiq), usd(c.finalMedian), usd(c.final5), usd(c.ddMedian), usd(c.ddWorst)]);
  }
  md.push(table(['Habit', 'Sequences', 'Trades each', 'Liquidations each', 'Sequences with a liquidation', 'Median end result', '5th percentile end result', 'Median drawdown', 'Worst drawdown'], ch), '');
  json.sequences = chJson;

  // 9. Night Watch -----------------------------------------------------------------
  const flown = trades.filter((t) => t.b), acted = flown.filter((t) => t.acted);
  md.push('### 9. Night Watch', '');
  md.push(`Night Watch acted on ${int(acted.length)} of ${int(flown.length)} re-routed flights (${pct(acted.length / flown.length)}).`, '');
  if (acted.length) {
    md.push(table(['Flights where Night Watch acted', 'Mean', 'Median', 'Mean of worst 5%', 'Worst'], [
      ['Watch off', usd(mean(acted.map(B))), usd(quantile(acted.map(B), 0.5)), usd(shortfall(acted.map(B))), usd(Math.min(...acted.map(B)))],
      ['Watch on', usd(mean(acted.map(C))), usd(quantile(acted.map(C), 0.5)), usd(shortfall(acted.map(C))), usd(Math.min(...acted.map(C)))],
    ]), '');
    md.push(`Mean difference per flight it touched: ${usd(mean(acted.map((t) => C(t) - B(t))))} USDT (95% interval ${ci(acted, (r) => mean(r.map((t) => C(t) - B(t))), (x) => usd(x))}). It made the result better on ${pct(share(acted, (t) => C(t) > B(t) + 0.005))} of them and worse on ${pct(share(acted, (t) => C(t) < B(t) - 0.005))}.`, '');
  }
  json.nightWatch = { flown: flown.length, acted: acted.length, meanOff: mean(acted.map(B)), meanOn: mean(acted.map(C)), es5Off: shortfall(acted.map(B)), es5On: shortfall(acted.map(C)), better: share(acted, (t) => C(t) > B(t) + 0.005), worse: share(acted, (t) => C(t) < B(t) - 0.005) };

  // why refused ---------------------------------------------------------------------
  const why = new Map<string, number>();
  for (const t of trades) for (const b of t.blockers ?? []) why.set(b, (why.get(b) ?? 0) + 1);
  if (why.size) {
    md.push('Reasons given when no size clears:', '', table(['Reason', 'Plans'], [...why.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, int(v)])), '');
    const ref = trades.filter((t) => !t.b);
    md.push(`Flown as filed anyway, those refused plans averaged ${usd(mean(ref.map(A)))} USDT with ${pct(share(ref, liqA))} liquidated.`, '');
  }
  const fails = new Map<string, number>();
  for (const t of trades) for (const f of t.fails) fails.set(f, (fails.get(f) ?? 0) + 1);
  md.push('How often each Preflight check failed on the plans as filed:', '', table(['Check', 'Plans failing', 'Share'], [...fails.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, int(v), pct(v / trades.length)])), '');
  json.failedChecks = Object.fromEntries(fails);
  json.plans = trades.length; json.days = days; json.from = first; json.to = last;
  return { md: md.join('\n'), json };
}

const outDir = path.join(here, 'out');
const all: Record<string, unknown> = {};
const parts: string[] = [];
for (const sc of Object.values(SCENARIOS)) {
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.startsWith(`${sc.id}-`) && f.endsWith('.json')) : [];
  if (files.length !== Object.keys(INSTRUMENTS).length) { console.error(`${sc.id}: ${files.length} of ${Object.keys(INSTRUMENTS).length} contracts run, skipped`); continue; }
  const trades: Trade[] = files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')) as Trade[]);
  const r = analyse(sc, trades);
  parts.push(r.md);
  all[sc.id] = r.json;
}
const header = `# Study results

Generated by \`npm run study\` from the recorded Bitget candles in this repository. Nothing in this file is typed by hand. The write-up that explains these tables is docs/STUDY.md.
`;
fs.writeFileSync(path.join(here, 'RESULTS.md'), [header, ...parts].join('\n') + '\n');
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(all, null, 1) + '\n');

// The handful of figures the app's landing page shows, so the page can never drift from the study.
const day = all.day as any;
if (day) {
  const h50 = day.headline['50x'], seq = day.sequences['50x'];
  const r3 = (x: number) => Math.round(x * 1000) / 1000, r2 = (x: number) => Math.round(x * 100) / 100;
  // the forward test keeps its running total in the same file; carry it over untouched
  const headlineFile = path.join(here, 'headline.json');
  const forward = fs.existsSync(headlineFile) ? JSON.parse(fs.readFileSync(headlineFile, 'utf8')).forward : undefined;
  fs.writeFileSync(headlineFile, JSON.stringify({
    scenarios: Object.keys(all).length,
    plansAllScenarios: Object.values(all).reduce((s2: number, x: any) => s2 + x.plans, 0),
    liquidatedReroutedAllScenarios: Object.values(all).reduce((s2: number, x: any) => s2 + Math.round(x.headline.All.rerouted.liq * x.plans), 0),
    plans: day.plans, days: day.days, contracts: Object.keys(INSTRUMENTS).length,
    liquidated50: r3(h50.asFiled.liq), forecast50: r3(h50.forecastLiquidation),
    liquidatedRerouted: r3(day.headline.All.rerouted.liq), meanReroutedLeverage: r2(day.headline.All.meanReroutedLeverage),
    gainKept: r3(day.cost.gainKept), lossKept: r3(1 - day.cost.lossAvoided), flatCap: day.control.cap,
    monthLiquidations50: r2(seq.asFiled.liqPerChain), monthEnd50: Math.round(seq.asFiled.finalMedian), monthEndRerouted: Math.round(seq.rerouted.finalMedian),
    forward: forward ?? { through: 0, entryHours: 0, plans: 0, liquidated50: 0, forecast50: 0, liquidatedAsFiled: 0, liquidatedRerouted: 0 },
  }, null, 1) + '\n');
}
console.log([header, ...parts].join('\n'));
