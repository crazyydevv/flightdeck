// NIGHT WATCH: minds an airborne flight during the hours nobody is looking.
//
// One invariant makes it safe to leave unattended: every action it can take
// reduces risk. It may tighten a stop, cut the position or land it. It can
// never add size, widen a stop or remove one. A model may choose among those
// actions (api/watch.ts); the guard below applies to the model exactly as it
// applies to the built-in rules, so a wrong answer can cost opportunity, never
// extra exposure.

import { isUsOpen, lastUsClose, nextUsOpen } from './calendar';
import { cut, land } from './flight';
import { Candle, Flight, Instrument, WatchEvent } from './types';
import { fmtPct, HOUR, stdev } from './util';

export interface WatchFacts {
  price: number;
  /** result so far in units of the planned risk (1R = entry to the cleared stop) */
  r: number;
  /** best R reached since take-off */
  bestR: number;
  /** consecutive hourly closes against the position */
  adverseStreak: number;
  /** distance to liquidation in units of a normal four-hour move */
  runway: number;
  usOpen: boolean | null;
  hoursToBell: number | null;
  /** off-hours drift against the position, in sigma; 0 when New York is open */
  adverseDrift: number;
  hoursToEarnings: number | null;
  open: number;
}

export type Proposal =
  | { action: 'hold'; rule: string; why: string }
  | { action: 'stop-to-entry'; rule: string; why: string }
  | { action: 'trail-stop'; rule: string; why: string; stop: number }
  | { action: 'cut-half'; rule: string; why: string }
  | { action: 'land'; rule: string; why: string };

export const WATCH_RULES: { id: string; title: string; does: string }[] = [
  { id: 'runway', title: 'Runway alarm', does: 'Lands the flight when liquidation is closer than 1.5 normal four-hour moves.' },
  { id: 'earnings', title: 'No unattended earnings', does: 'Lands a stock perp two hours before its company reports.' },
  { id: 'pre-bell', title: 'Pre-bell de-risk', does: 'Cuts half when the opening bell is under an hour away and the off-hours drift is 2 sigma against you.' },
  { id: 'bleed', title: 'Slow bleed', does: 'Cuts half at -0.6R after three straight hourly closes against you.' },
  { id: 'free-ride', title: 'Free ride', does: 'Moves the stop to entry once the flight has been 1R in profit.' },
  { id: 'trail', title: 'Trail', does: 'From 2R in profit, keeps the stop 1R behind the best price.' },
];

const dirOf = (f: Flight) => (f.side === 'long' ? 1 : -1);

/** What Night Watch can see at `now`: closed hourly bars only. */
export function assess(f: Flight, bars: Candle[], inst: Instrument, now: number, earningsAt?: number): WatchFacts {
  const d = dirOf(f);
  const closed = bars.filter((c) => c.t + HOUR <= now);
  const since = closed.filter((c) => c.t >= f.openedAt);
  const price = closed.length ? closed[closed.length - 1].c : f.entry;
  const risk = Math.abs(f.entry - (f.stop0 ?? f.stop ?? f.liqPrice)) || f.entry * 0.01;
  const best = since.reduce((b, c) => Math.max(b, ((d === 1 ? c.h : c.l) - f.entry) * d), 0);
  let streak = 0;
  for (let i = since.length - 1; i > 0 && (since[i].c - since[i - 1].c) * d < 0; i--) streak++;
  const rets = closed.slice(-120).slice(1).map((c, i, a) => Math.log(c.c / (i ? a[i - 1].c : closed[Math.max(0, closed.length - 120)].c)));
  const sigmaH = stdev(rets) || 0.004;

  let usOpen: boolean | null = null, hoursToBell: number | null = null, adverseDrift = 0;
  if (inst.cls === 'rwa') {
    usOpen = isUsOpen(now);
    if (!usOpen) {
      hoursToBell = (nextUsOpen(now) - now) / HOUR;
      const ref = lastUsClose(now);
      const before = closed.filter((c) => c.t + HOUR <= ref);
      const refPx = before.length ? before[before.length - 1].c : f.entry;
      const hours = Math.max(1, (now - ref) / HOUR);
      adverseDrift = Math.max(0, (-Math.log(price / refPx) * d) / (sigmaH * Math.sqrt(hours)));
    }
  }
  return {
    price, r: ((price - f.entry) * d) / risk, bestR: best / risk, adverseStreak: streak,
    runway: Math.abs(price - f.liqPrice) / price / (sigmaH * 2),
    usOpen, hoursToBell, adverseDrift,
    hoursToEarnings: earningsAt !== undefined && inst.cls === 'rwa' ? (earningsAt - now) / HOUR : null,
    open: f.open ?? 1,
  };
}

/** The built-in policy: the first rule that fires wins, most urgent first. */
export function decide(f: Flight, x: WatchFacts): Proposal {
  const d = dirOf(f);
  const risk = Math.abs(f.entry - (f.stop0 ?? f.stop ?? f.liqPrice));
  if (x.runway < 1.5) return { action: 'land', rule: 'runway', why: `Liquidation is ${x.runway.toFixed(1)} normal four-hour moves away.` };
  if (x.hoursToEarnings !== null && x.hoursToEarnings >= 0 && x.hoursToEarnings <= 2) return { action: 'land', rule: 'earnings', why: `Earnings in ${x.hoursToEarnings.toFixed(1)}h. Nobody is watching, so the flight comes down first.` };
  if (x.open > 0.5 && x.hoursToBell !== null && x.hoursToBell <= 1 && x.adverseDrift >= 2) return { action: 'cut-half', rule: 'pre-bell', why: `Opening bell in ${Math.round(x.hoursToBell * 60)} min with a ${x.adverseDrift.toFixed(1)} sigma off-hours drift against the position.` };
  if (x.open > 0.5 && x.r <= -0.6 && x.adverseStreak >= 3) return { action: 'cut-half', rule: 'bleed', why: `${x.r.toFixed(2)}R after ${x.adverseStreak} straight hourly closes against the position.` };
  if (x.bestR >= 2 && risk > 0) {
    const stop = f.entry + d * (x.bestR * risk - risk);
    if (f.stop === undefined || (stop - f.stop) * d > risk * 0.05) return { action: 'trail-stop', rule: 'trail', why: `Best price was ${x.bestR.toFixed(1)}R in profit. Stop follows 1R behind it.`, stop };
  }
  if (x.bestR >= 1 && f.stop !== undefined && (f.entry - f.stop) * d > 0) return { action: 'stop-to-entry', rule: 'free-ride', why: `The flight has been ${x.bestR.toFixed(1)}R in profit. The stop moves to entry.` };
  return { action: 'hold', rule: 'none', why: 'Nothing breached.' };
}

/**
 * The invariant. A proposal passes only if it leaves the flight with the same
 * or less risk than before. Applied to rules and to model output alike.
 */
export function guard(f: Flight, p: Proposal, x: WatchFacts): { ok: boolean; reason: string } {
  const d = dirOf(f);
  if (p.action === 'hold' || p.action === 'land') return { ok: true, reason: 'Holding and landing never add risk.' };
  if (p.action === 'cut-half') return x.open > 0 ? { ok: true, reason: 'Cutting reduces exposure.' } : { ok: false, reason: 'Nothing left to cut.' };
  const stop = p.action === 'stop-to-entry' ? f.entry : p.stop;
  if (!Number.isFinite(stop)) return { ok: false, reason: 'No stop price given.' };
  if (f.stop !== undefined && (stop - f.stop) * d <= 0) return { ok: false, reason: 'That would widen the stop. Night Watch only tightens.' };
  if ((x.price - stop) * d <= 0) return { ok: false, reason: 'That stop is already through the market.' };
  return { ok: true, reason: 'The stop moves toward the price.' };
}

export interface Tick { flight: Flight; landed: boolean; event?: WatchEvent; refused?: string }

/** Assess, decide (or take the model's proposal), guard, act. */
export function watchTick(f: Flight, bars: Candle[], inst: Instrument, now: number, balance: number, earningsAt?: number, fromModel?: Proposal): Tick {
  const x = assess(f, bars, inst, now, earningsAt);
  const checked = { ...f, watchChecks: (f.watchChecks ?? 0) + 1 };
  let p = fromModel ?? decide(f, x);
  let by: WatchEvent['by'] = fromModel ? 'model' : 'rules';
  let refused: string | undefined;
  const g = guard(f, p, x);
  if (!g.ok) {
    // a refused model proposal falls back to the built-in policy
    refused = g.reason;
    p = decide(f, x);
    by = 'rules';
    if (!guard(f, p, x).ok) return { flight: checked, landed: false, refused };
  }
  if (p.action === 'hold') return { flight: checked, landed: false, refused };
  const place = inst.pricePlace;
  const event = (detail: string): WatchEvent => ({ at: now, action: p.action as WatchEvent['action'], rule: p.rule, detail: `${p.why} ${detail}`, price: x.price, by });
  const log = (e: WatchEvent) => [...(f.watchLog ?? []), e];
  if (p.action === 'land') {
    const e = event(`Landed at ${x.price.toFixed(place)}.`);
    return { flight: { ...land({ ...checked, watchLog: log(e) }, x.price, now, 'landed', inst, balance) }, landed: true, event: e, refused };
  }
  if (p.action === 'cut-half') {
    const e = event(`Closed half at ${x.price.toFixed(place)} (${fmtPct(x.price / f.entry - 1, 2)} from entry).`);
    return { flight: { ...cut(checked, 0.5, x.price, inst), watchLog: log(e) }, landed: false, event: e, refused };
  }
  const stop = Number((p.action === 'stop-to-entry' ? f.entry : p.stop).toFixed(place));
  const e = event(`Stop ${f.stop?.toFixed(place) ?? 'none'} to ${stop.toFixed(place)}.`);
  return { flight: { ...checked, stop, watchLog: log(e) }, landed: false, event: e, refused };
}

/** The note left for the pilot in the morning. */
export function debrief(f: Flight, base: string): string {
  const log = f.watchLog ?? [];
  const checks = f.watchChecks ?? 0;
  if (!checks) return `Night Watch has not checked ${f.id} yet.`;
  const acts = log.map((e) => (e.action === 'cut-half' ? 'cut half' : e.action === 'land' ? 'landed it' : e.action === 'stop-to-entry' ? 'moved the stop to entry' : 'trailed the stop'));
  const head = `Night Watch checked ${base} ${f.id} ${checks} time${checks === 1 ? '' : 's'}`;
  if (!log.length) return `${head} and held every time. Nothing breached.`;
  return `${head}, held ${checks - log.length} and acted ${log.length}: ${acts.join(', then ')}. ${log[log.length - 1].detail}`;
}

/** The menu handed to a model, and the parser for what it sends back. */
export function watchPrompt(f: Flight, x: WatchFacts, base: string): { system: string; user: string } {
  return {
    system:
      'You are the night watch on a leveraged position. Nobody else is awake. Choose exactly one action from this menu and reply with JSON only: ' +
      '{"action":"hold"|"stop-to-entry"|"cut-half"|"land","why":"one sentence using only the numbers given"}. ' +
      'You cannot add size, widen the stop or remove it; any such reply is discarded. When in doubt, reduce risk.',
    user: JSON.stringify({ instrument: base, side: f.side, leverage: f.leverage, entry: f.entry, stop: f.stop, liquidation: f.liqPrice, facts: x }),
  };
}

export function parseWatchReply(content: string): Proposal | null {
  try {
    const data = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    const why = typeof data.why === 'string' ? data.why.slice(0, 240) : 'Model decision.';
    if (['hold', 'stop-to-entry', 'cut-half', 'land'].includes(data.action)) return { action: data.action, rule: 'model', why } as Proposal;
    return null;
  } catch {
    return null;
  }
}
