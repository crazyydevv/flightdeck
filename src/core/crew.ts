// CREW: three adversaries who argue against the plan. They never produce
// numbers; they are handed the preflight report and may only argue from it.
// With no model configured, the briefs are written from templates, and the UI
// says so. With a model configured (api/crew.ts), the same facts go to the LLM.

import { PreflightReport } from './types';
import { fmtPct, fmtUsd } from './util';

export interface Brief {
  seat: 'Weather' | 'Engineering' | 'Dispatch';
  role: string;
  text: string;
  written: 'rules' | 'model';
}

export const SEATS: { seat: Brief['seat']; role: string; focus: string }[] = [
  { seat: 'Weather', role: 'Regime and volatility', focus: 'volatility regime, the replay of past windows, how often this setup reached its target' },
  { seat: 'Engineering', role: 'Margin and liquidation', focus: 'leverage, liquidation distance, the gap shock, whether the stop can actually fill' },
  { seat: 'Dispatch', role: 'Timing and cost', focus: 'the US session clock, opening bells crossed, fees and funding, risk as a share of the account' },
];

const byId = (r: PreflightReport, id: string) => r.checks.find((c) => c.id === id);

/** Template-written briefs: the fallback when no model is configured. */
export function ruleBriefs(r: PreflightReport, base: string): Brief[] {
  const n = r.numbers, p = r.plan, rp = r.replay;
  const mc = r.monteCarlo;
  const weather =
    `${base} moves about ${fmtPct(n.sigmaDay, 1, false)} a day, so ${fmtPct(n.sigmaHorizon, 1, false)} over your ${p.horizonH}h. ` +
    (rp.windows >= 10
      ? `I flew this plan through ${rp.windows} past windows: ${rp.target} hit target, ${rp.stopped} stopped out, ${rp.liquidated} were liquidated, average ${fmtUsd(rp.meanPnl)} USDT. `
      : 'There is not enough history to replay this horizon, so I cannot vouch for it. ') +
    (mc.paths ? `A thousand reshuffled paths agree on the shape: ${Math.round((mc.target / mc.paths) * 100)}% target, ${Math.round((mc.stopped / mc.paths) * 100)}% stop, ${Math.round((mc.liquidated / mc.paths) * 100)}% liquidation.` : '');
  const engineering =
    `At ${p.leverage}x the position is ${fmtUsd(n.notional, 0)} USDT on ${fmtUsd(p.margin, 0)} of margin, liquidated ${fmtPct(n.liqDist, 1, false)} away. ` +
    `${byId(r, 'gap')?.headline} ${byId(r, 'stop')?.headline} ` +
    (r.verdict === 'NO-GO' && r.guidance.fixable ? `The airframe holds at ${r.guidance.leverage}x.` : '');
  const dispatch =
    (n.usOpen === null ? 'No closing bell on this one. '
      : `New York is ${n.usOpen ? 'open' : 'closed'} and you cross ${n.opensCrossed} opening bell${n.opensCrossed === 1 ? '' : 's'}. `) +
    `${byId(r, 'drag')?.headline} ${byId(r, 'exposure')?.headline} ` +
    (byId(r, 'payoff')?.status !== 'pass' ? byId(r, 'payoff')?.headline : `Payoff is ${n.rr.toFixed(2)} to 1.`);
  return [
    { seat: 'Weather', role: SEATS[0].role, text: weather.trim(), written: 'rules' },
    { seat: 'Engineering', role: SEATS[1].role, text: engineering.trim(), written: 'rules' },
    { seat: 'Dispatch', role: SEATS[2].role, text: dispatch.trim(), written: 'rules' },
  ];
}

/** The facts handed to the model. Nothing else is allowed into a brief. */
export function crewFacts(r: PreflightReport, base: string) {
  return {
    instrument: base,
    plan: r.plan,
    verdict: r.verdict,
    checks: r.checks.map((c) => ({ check: c.label, status: c.status, finding: c.headline, detail: c.detail })),
    replay: r.replay,
    monteCarlo: r.monteCarlo,
    numbers: r.numbers,
    survivableSize: r.guidance,
  };
}

export function crewPrompt(r: PreflightReport, base: string): { system: string; user: string } {
  return {
    system:
      'You are three members of a flight-deck crew reviewing a leveraged trade before take-off. Each of you argues AGAINST the plan from your own seat. ' +
      'Use only the numbers in the JSON you are given. Never invent a price, a statistic, a news event or a forecast. If the facts do not support an objection, say the plan is sound from your seat. ' +
      'You do not decide whether the trade happens; a deterministic rule engine does. Reply with JSON only: ' +
      '{"briefs":[{"seat":"Weather","text":"..."},{"seat":"Engineering","text":"..."},{"seat":"Dispatch","text":"..."}]}. ' +
      'Each text is at most 60 words, plain sentences, no markdown. ' +
      SEATS.map((s) => `${s.seat} covers ${s.focus}.`).join(' '),
    user: JSON.stringify(crewFacts(r, base)),
  };
}

export function parseCrewReply(content: string): Brief[] | null {
  try {
    const start = content.indexOf('{'), end = content.lastIndexOf('}');
    const data = JSON.parse(content.slice(start, end + 1));
    const briefs: Brief[] = [];
    for (const s of SEATS) {
      const hit = (data.briefs ?? []).find((b: { seat?: string }) => b.seat === s.seat);
      if (!hit || typeof hit.text !== 'string' || !hit.text.trim()) return null;
      briefs.push({ seat: s.seat, role: s.role, text: hit.text.trim().slice(0, 600), written: 'model' });
    }
    return briefs;
  } catch {
    return null;
  }
}
