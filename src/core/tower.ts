// TOWER: the deterministic gate every order passes, whether a person or an
// agent filed it. No model output can change a decision made here. Each
// decision is written to a hash-chained ledger so it can be audited later.

import { isUsOpen } from './calendar';
import { liquidationPrice, planHash, stopState } from './preflight';
import { Clearance, Finding, Flight, FlightPlan, Instrument, LedgerEntry, PreflightReport, Rule } from './types';
import { canonical, DAY, fmtPct, fmtUsd, hashOf, HOUR, sha256 } from './util';

/** The rules the Tower ships with. Black Box adds to these; it never removes them. */
export const CHARTER: Rule[] = [
  { id: 'preflight', kind: 'preflight_required', title: 'Fresh preflight on this exact plan', params: { maxAgeMin: 30 }, source: 'charter', enabled: true },
  { id: 'stop', kind: 'stop_required', title: 'A working stop is filed', params: {}, source: 'charter', enabled: true },
  { id: 'risk', kind: 'max_risk_pct', title: 'Risk per flight', params: { pct: 5 }, source: 'charter', enabled: true },
  { id: 'lev-rwa', kind: 'max_leverage', title: 'Leverage on stock perps', params: { cls: 'rwa', max: 10 }, source: 'charter', enabled: true },
  { id: 'lev-crypto', kind: 'max_leverage', title: 'Leverage on crypto perps', params: { cls: 'crypto', max: 20 }, source: 'charter', enabled: true },
  { id: 'offhours', kind: 'offhours_leverage', title: 'Stock perps while New York is closed', params: { max: 5 }, source: 'charter', enabled: true },
  { id: 'daily-loss', kind: 'daily_loss_stop', title: 'Grounded after a bad day', params: { pct: 6 }, source: 'charter', enabled: true },
  { id: 'agent', kind: 'agent_leverage_cap', title: 'Leverage for orders filed by an agent', params: { max: 5 }, source: 'charter', enabled: true },
];

export interface TowerContext {
  now: number;
  equity: number;
  instrument: Instrument;
  /** the latest preflight the pilot ran, if any */
  preflight?: Pick<PreflightReport, 'planHash' | 'verdict' | 'at'>;
  /** landed flights, any order */
  logbook: Flight[];
}

export const rulesHash = (rules: Rule[]) => hashOf(rules.filter((r) => r.enabled).map((r) => ({ id: r.id, kind: r.kind, params: r.params })));

function check(rule: Rule, plan: FlightPlan, ctx: TowerContext): { ok: boolean; detail: string; cap?: number } {
  const p = rule.params;
  const inst = ctx.instrument;
  const landed = ctx.logbook.filter((f) => f.closedAt !== undefined && f.closedAt <= ctx.now).sort((a, b) => (a.closedAt as number) - (b.closedAt as number));
  const lastLanding = landed[landed.length - 1];
  switch (rule.kind) {
    case 'max_leverage': {
      if (p.cls !== 'any' && p.cls !== inst.cls) return { ok: true, detail: `Applies to ${p.cls === 'rwa' ? 'stock' : 'crypto'} perps only.` };
      const max = Number(p.max);
      return { ok: plan.leverage <= max, cap: max, detail: `Filed ${plan.leverage}x, limit ${max}x.` };
    }
    case 'offhours_leverage': {
      if (inst.cls !== 'rwa') return { ok: true, detail: 'Applies to stock perps only.' };
      if (isUsOpen(ctx.now)) return { ok: true, detail: 'New York is open.' };
      const max = Number(p.max);
      return { ok: plan.leverage <= max, cap: max, detail: `New York is closed. Filed ${plan.leverage}x, off-hours limit ${max}x.` };
    }
    case 'agent_leverage_cap': {
      if (plan.origin !== 'agent') return { ok: true, detail: 'Filed by the pilot.' };
      const max = Number(p.max);
      return { ok: plan.leverage <= max, cap: max, detail: `Agent ${plan.agentId ?? 'unknown'} filed ${plan.leverage}x, agent limit ${max}x.` };
    }
    case 'stop_required': {
      const s = stopState(plan, liquidationPrice(plan, inst));
      return { ok: s === 'valid', detail: s === 'valid' ? 'Stop sits between entry and liquidation.' : s === 'none' ? 'No stop filed.' : s === 'wrong-side' ? 'Stop is on the wrong side of entry.' : 'Stop is beyond liquidation and cannot fill.' };
    }
    case 'max_risk_pct': {
      const liq = liquidationPrice(plan, inst);
      const qty = (plan.margin * plan.leverage) / plan.entry;
      const risk = stopState(plan, liq) === 'valid' ? qty * Math.abs(plan.entry - (plan.stop as number)) : plan.margin;
      const pct = risk / ctx.equity;
      return { ok: pct * 100 <= Number(p.pct), detail: `${fmtUsd(risk)} USDT at risk is ${fmtPct(pct, 1, false)} of the account, limit ${p.pct}%.` };
    }
    case 'preflight_required': {
      const pf = ctx.preflight;
      if (!pf) return { ok: false, detail: 'No preflight on file.' };
      if (pf.planHash !== planHash(plan)) return { ok: false, detail: 'The plan changed after preflight. Run it again.' };
      const ageMin = (ctx.now - pf.at) / 60000;
      if (ageMin > Number(p.maxAgeMin)) return { ok: false, detail: `Preflight is ${Math.round(ageMin)} min old, limit ${p.maxAgeMin}.` };
      return { ok: pf.verdict !== 'NO-GO', detail: `Preflight verdict: ${pf.verdict}.` };
    }
    case 'cooldown_after_loss': {
      if (!lastLanding || (lastLanding.pnl ?? 0) >= 0) return { ok: true, detail: 'Last landing was not a loss.' };
      const mins = (ctx.now - (lastLanding.closedAt as number)) / 60000;
      return { ok: mins >= Number(p.minutes), detail: `Last flight lost ${fmtUsd(lastLanding.pnl ?? 0)} USDT ${Math.round(mins)} min ago. Cooldown is ${p.minutes} min.` };
    }
    case 'no_size_up_after_loss': {
      if (!lastLanding || (lastLanding.pnl ?? 0) >= 0) return { ok: true, detail: 'Last landing was not a loss.' };
      if (ctx.now - (lastLanding.closedAt as number) > Number(p.hours) * HOUR) return { ok: true, detail: `Last loss was more than ${p.hours}h ago.` };
      const prev = lastLanding.margin * lastLanding.leverage;
      const next = plan.margin * plan.leverage;
      return { ok: next <= prev * 1.05, detail: `Last flight lost at ${fmtUsd(prev, 0)} USDT notional. This one is ${fmtUsd(next, 0)}.` };
    }
    case 'max_flights_per_day': {
      const n = ctx.logbook.filter((f) => ctx.now - f.openedAt < DAY && f.openedAt <= ctx.now).length;
      return { ok: n < Number(p.n), detail: `${n} flights in the last 24h, limit ${p.n}.` };
    }
    case 'daily_loss_stop': {
      const net = landed.filter((f) => ctx.now - (f.closedAt as number) < DAY).reduce((a, f) => a + (f.pnl ?? 0), 0);
      const lost = -net;
      const pct = Math.max(0, lost) / ctx.equity;
      return { ok: pct * 100 < Number(p.pct), detail: `Net result over 24h: ${fmtUsd(-lost)} USDT (${fmtPct(pct, 1, false)} of account lost), limit ${p.pct}%.` };
    }
  }
}

/** Evaluate a plan against every enabled rule. Pure: same inputs, same clearance. */
export function requestClearance(plan: FlightPlan, rules: Rule[], ctx: TowerContext): Clearance {
  const findings: Finding[] = [];
  let cap = Infinity;
  let uncapped = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const r = check(rule, plan, ctx);
    findings.push({ ruleId: rule.id, title: rule.title, source: rule.source, ok: r.ok, detail: r.detail });
    if (!r.ok && r.cap !== undefined) cap = Math.min(cap, r.cap);
    else if (!r.ok) uncapped++;
  }
  const failed = findings.filter((f) => !f.ok);
  const clearance: Clearance = {
    decision: failed.length ? 'REFUSED' : 'CLEARED',
    at: ctx.now, planHash: planHash(plan), rulesHash: rulesHash(rules), findings,
  };
  // If every refusal is a leverage cap, say what size would clear.
  if (failed.length && uncapped === 0 && Number.isFinite(cap)) clearance.amendment = { leverage: cap };
  return clearance;
}

/** The highest leverage a pilot could get cleared on this instrument right now. */
export function leverageCap(rules: Rule[], inst: Instrument, now: number): number {
  let cap = inst.maxLever;
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.kind === 'max_leverage' && (r.params.cls === 'any' || r.params.cls === inst.cls)) cap = Math.min(cap, Number(r.params.max));
    if (r.kind === 'offhours_leverage' && inst.cls === 'rwa' && !isUsOpen(now)) cap = Math.min(cap, Number(r.params.max));
  }
  return cap;
}

/** A rule in one plain sentence. */
export function describeRule(r: Rule): string {
  const p = r.params;
  switch (r.kind) {
    case 'max_leverage': return `${p.cls === 'rwa' ? 'Stock perps' : p.cls === 'crypto' ? 'Crypto perps' : 'Any perp'}: at most ${p.max}x`;
    case 'offhours_leverage': return `Stock perps with New York closed: at most ${p.max}x`;
    case 'max_risk_pct': return `At most ${p.pct}% of the account at risk per flight`;
    case 'stop_required': return 'A stop between entry and liquidation';
    case 'preflight_required': return `Preflight on the exact plan, under ${p.maxAgeMin} minutes old, not NO-GO`;
    case 'cooldown_after_loss': return `No take-off for ${p.minutes} minutes after a losing landing`;
    case 'no_size_up_after_loss': return `No larger position for ${p.hours}h after a loss`;
    case 'max_flights_per_day': return `At most ${p.n} flights per 24 hours`;
    case 'daily_loss_stop': return `Grounded once ${p.pct}% of the account is lost in 24 hours`;
    case 'agent_leverage_cap': return `Orders filed by an agent: at most ${p.max}x`;
  }
}

// ---- Ledger -----------------------------------------------------------------

export const GENESIS = '0'.repeat(64);

export function appendEntry(ledger: LedgerEntry[], kind: LedgerEntry['kind'], summary: string, body: unknown, at: number): LedgerEntry[] {
  const prev = ledger.length ? ledger[ledger.length - 1].hash : GENESIS;
  const seq = ledger.length + 1;
  const hash = sha256(prev + canonical({ seq, at, kind, summary, body }));
  return [...ledger, { seq, at, kind, summary, body, prev, hash }];
}

/** Recompute the chain. Returns the first broken sequence number, or 0 if intact. */
export function verifyLedger(ledger: LedgerEntry[]): number {
  let prev = GENESIS;
  for (const e of ledger) {
    const hash = sha256(prev + canonical({ seq: e.seq, at: e.at, kind: e.kind, summary: e.summary, body: e.body }));
    if (e.prev !== prev || e.hash !== hash) return e.seq;
    prev = e.hash;
  }
  return 0;
}

/** Squawk code: four octal digits derived from a hash, like a transponder code. */
export function squawk(hash: string): string {
  return (parseInt(hash.slice(0, 6), 16) % 4096).toString(8).padStart(4, '0');
}
