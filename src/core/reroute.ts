// RE-ROUTE: a refusal should end with an offer. Given a plan the deck will not
// fly, this finds the largest version of the same trade that passes every
// preflight check and every Tower rule right now.
//
// It keeps the instrument, the side, the hold and the target. It may lower
// leverage, lower margin, and, if no working stop was filed, add one a normal
// move away from entry. It never raises anything. The result is an offer: the
// pilot or the agent still has to accept it, and the Tower still records it.

import { liquidationPrice, preflight, stopState } from './preflight';
import { leverageCap, requestClearance } from './tower';
import { Clearance, Flight, FlightPlan, MarketState, PreflightReport, Rule } from './types';

export interface Reroute {
  ok: true;
  plan: FlightPlan;
  report: PreflightReport;
  clearance: Clearance;
  /** what was changed, in plain words; empty when the plan clears as filed */
  changes: string[];
}
export interface NoRoute {
  ok: false;
  /** what size cannot fix */
  blockers: string[];
}

export function reroute(plan: FlightPlan, rules: Rule[], m: MarketState, now: number, equity: number, logbook: Flight[]): Reroute | NoRoute {
  const inst = m.instruments[plan.symbol];
  if (!inst) return { ok: false, blockers: ['Unknown instrument'] };
  const d = plan.side === 'long' ? 1 : -1;
  let p: FlightPlan = { ...plan };

  // Start from the highest leverage any rule would allow this filer.
  let cap = leverageCap(rules, inst, now);
  if (p.origin === 'agent') for (const r of rules) if (r.enabled && r.kind === 'agent_leverage_cap') cap = Math.min(cap, Number(r.params.max));
  if (p.leverage > cap) p.leverage = cap;

  let stopAdded = false;
  for (let i = 0; i < 8; i++) {
    let report = preflight(p, m, now, equity);

    // No working stop: file one a normal move for this hold away from entry.
    if (stopState(p, liquidationPrice(p, inst)) !== 'valid') {
      if (stopAdded) return { ok: false, blockers: ['No stop fits between entry and liquidation'] };
      const dist = Math.max(report.numbers.sigmaHorizon, 0.005);
      p = { ...p, stop: Number((p.entry * (1 - d * dist)).toFixed(inst.pricePlace)) };
      stopAdded = true;
      continue;
    }

    if (report.verdict === 'NO-GO') {
      const g = report.guidance;
      if (!g.fixable) return { ok: false, blockers: g.blockers };
      if (g.leverage >= p.leverage && g.margin >= p.margin) return { ok: false, blockers: report.checks.filter((c) => c.status === 'fail').map((c) => c.label) };
      p = { ...p, leverage: Math.min(p.leverage, g.leverage), margin: Math.min(p.margin, g.margin) };
      report = preflight(p, m, now, equity);
      if (report.verdict === 'NO-GO') continue;
    }

    const clearance = requestClearance(p, rules, { now, equity, instrument: inst, preflight: report, logbook });
    if (clearance.decision === 'CLEARED') return { ok: true, plan: p, report, clearance, changes: describe(plan, p, stopAdded, inst.pricePlace) };

    const failed = clearance.findings.filter((f) => !f.ok);
    const kinds = failed.map((f) => rules.find((r) => r.id === f.ruleId)?.kind);
    const sizeOnly = kinds.every((k) => k === 'max_risk_pct' || k === 'max_leverage' || k === 'offhours_leverage' || k === 'agent_leverage_cap' || k === 'no_size_up_after_loss');
    if (!sizeOnly) return { ok: false, blockers: failed.filter((_, j) => !['max_risk_pct', 'max_leverage', 'offhours_leverage', 'agent_leverage_cap', 'no_size_up_after_loss'].includes(kinds[j] as string)).map((f) => f.title) };

    if (clearance.amendment?.leverage && clearance.amendment.leverage < p.leverage) { p = { ...p, leverage: clearance.amendment.leverage }; continue; }

    // Too much of the account at risk, or bigger than the flight that just lost: shrink the margin.
    let scale = 1;
    const riskRule = rules.find((r) => r.enabled && r.kind === 'max_risk_pct');
    if (riskRule && kinds.includes('max_risk_pct')) {
      const qty = (p.margin * p.leverage) / p.entry;
      const pct = (qty * Math.abs(p.entry - (p.stop as number))) / equity;
      scale = Math.min(scale, (Number(riskRule.params.pct) / 100 / pct) * 0.99);
    }
    if (kinds.includes('no_size_up_after_loss')) {
      const last = logbook.filter((f) => f.closedAt !== undefined && f.closedAt <= now).sort((a, b) => (a.closedAt as number) - (b.closedAt as number)).pop();
      if (last) scale = Math.min(scale, (last.margin * last.leverage * 1.04) / (p.margin * p.leverage));
    }
    const margin = Math.floor(p.margin * scale);
    if (!(scale < 1) || margin < 5) return { ok: false, blockers: failed.map((f) => f.title) };
    p = { ...p, margin };
  }
  return { ok: false, blockers: ['No size was found that clears'] };
}

function describe(from: FlightPlan, to: FlightPlan, stopAdded: boolean, place: number): string[] {
  const out: string[] = [];
  if (to.leverage !== from.leverage) out.push(`leverage ${from.leverage}x to ${to.leverage}x`);
  if (to.margin !== from.margin) out.push(`margin ${from.margin} to ${to.margin} USDT`);
  if (stopAdded) out.push(`stop added at ${(to.stop as number).toFixed(place)}`);
  return out;
}

/** One line for a refusal: what the Tower would clear instead. */
export function offerLine(r: Reroute | NoRoute, base: string): string {
  if (!r.ok) return `No size clears this: ${r.blockers.join(', ').toLowerCase()}.`;
  if (!r.changes.length) return `${base} clears as filed.`;
  return `The Tower will clear ${base} at ${r.plan.leverage}x on ${r.plan.margin} USDT (${r.changes.join(', ')}).`;
}
