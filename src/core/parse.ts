// Turns one typed line into a flight plan, with no model call:
//   "5x long NVDA 400 usdt stop 228 target 245 for 2 days"
// Anything the line leaves out keeps its current value.

import { FlightPlan, MarketState } from './types';

export function parseThesis(text: string, m: MarketState, current: FlightPlan): { plan: FlightPlan; understood: string[] } {
  const plan = { ...current, thesis: text.trim() || undefined };
  const understood: string[] = [];
  const t = ' ' + text.toLowerCase().replace(/,/g, '') + ' ';
  const num = (re: RegExp) => { const x = t.match(re); return x ? Number(x[1]) : undefined; };

  for (const sym of Object.keys(m.instruments)) {
    const inst = m.instruments[sym];
    if (new RegExp(`\\b(${inst.base}|${inst.name})\\b`, 'i').test(text)) {
      if (plan.symbol !== sym) { plan.symbol = sym; plan.stop = undefined; plan.target = undefined; }
      const cs = m.hourly[sym];
      if (cs?.length) plan.entry = cs[cs.length - 1].c;
      understood.push(inst.base);
      break;
    }
  }
  if (/\b(short|sell|fade|put)\b/.test(t)) { plan.side = 'short'; understood.push('short'); }
  else if (/\b(long|buy|call)\b/.test(t)) { plan.side = 'long'; understood.push('long'); }

  const lev = num(/(\d+(?:\.\d+)?)\s*x\b/);
  if (lev) { plan.leverage = Math.max(1, lev); understood.push(`${plan.leverage}x`); }

  const margin = num(/(?:\$\s*|margin\s+)(\d+(?:\.\d+)?)/) ?? num(/(\d+(?:\.\d+)?)\s*(?:usdt|usd|dollars)\b/);
  if (margin) { plan.margin = margin; understood.push(`${margin} USDT margin`); }

  const stop = num(/(?:stop|sl)\s*(?:loss)?\s*(?:at|@)?\s*(\d+(?:\.\d+)?)/);
  if (stop) { plan.stop = stop; understood.push(`stop ${stop}`); }
  const target = num(/(?:target|tp|take profit)\s*(?:at|@)?\s*(\d+(?:\.\d+)?)/);
  if (target) { plan.target = target; understood.push(`target ${target}`); }

  const days = num(/(\d+(?:\.\d+)?)\s*(?:d|day|days)\b/);
  const hours = num(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (/\b(weekend|over the weekend)\b/.test(t)) { plan.horizonH = 72; understood.push('72h'); }
  else if (/\bovernight\b/.test(t)) { plan.horizonH = 18; understood.push('18h'); }
  else if (days) { plan.horizonH = Math.round(days * 24); understood.push(`${plan.horizonH}h`); }
  else if (hours) { plan.horizonH = Math.round(hours); understood.push(`${plan.horizonH}h`); }

  return { plan, understood };
}
