// RADAR: finds instruments that moved further than usual while the market that
// prices them was shut. A stock perp on Bitget trades 24/7; the shares trade
// 6.5 hours a day. The Radar measures the gap between those two clocks.

import { isUsOpen, lastUsClose, sessionOpen } from './calendar';
import { logReturns } from './market';
import { Candle, Contact, MarketState } from './types';
import { beta as olsBeta, HOUR, stdev } from './util';

function priceAt(cs: Candle[], t: number): number {
  // close of the last bar that had finished by t
  let p = cs[0].o;
  for (const c of cs) {
    if (c.t + HOUR <= t) p = c.c;
    else break;
  }
  return p;
}

function splitVol(cs: Candle[]): { open: number; closed: number } {
  const open: number[] = [], closed: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const r = Math.log(cs[i].c / cs[i - 1].c);
    (isUsOpen(cs[i].t + HOUR / 2) ? open : closed).push(r);
  }
  return { open: stdev(open), closed: stdev(closed) };
}

export function scan(m: MarketState, now: number): Contact[] {
  const contacts: Contact[] = [];
  for (const sym of Object.keys(m.instruments)) {
    const inst = m.instruments[sym];
    const cs = m.hourly[sym];
    if (!cs || cs.length < 24) continue;
    const last = cs[cs.length - 1].c;
    const all = stdev(logReturns(cs));

    let session: Contact['session'] = 'always';
    let refTime = now - 24 * HOUR;
    let sigmaHour = all;
    let vol = { open: all, closed: all };

    if (inst.cls === 'rwa') {
      const open = isUsOpen(now);
      session = open ? 'open' : 'closed';
      refTime = open ? sessionOpen(now) : lastUsClose(now);
      vol = splitVol(cs);
      sigmaHour = (open ? vol.open : vol.closed) || all;
    }

    const hoursSinceRef = Math.max(1, (now - refTime) / HOUR);
    const ref = priceAt(cs, refTime);
    const drift = last / ref - 1;
    const z = sigmaHour > 0 ? Math.log(last / ref) / (sigmaHour * Math.sqrt(hoursSinceRef)) : 0;

    const c: Contact = {
      symbol: sym, cls: inst.cls, last, session, refTime, hoursSinceRef, drift, z,
      volOpen: vol.open, volClosed: vol.closed,
      funding: m.funding[sym], basis: m.basis[sym],
      score: Math.abs(z), note: '',
    };

    // Remove the part of the move the benchmark explains: BTC for the crypto
    // proxies, the Nasdaq 100 for the other stock perps. What is left is the
    // contract's own. Bars are paired by timestamp, so a missing hour on either
    // side cannot shift the two series against each other.
    const proxy = inst.proxyOf ? m.hourly[inst.proxyOf] : undefined;
    if (proxy && proxy.length >= 24) {
      const at = new Map(proxy.map((b) => [b.t, b.c]));
      const rx: number[] = [], ry: number[] = [];
      for (let i = 1; i < cs.length; i++) {
        const a0 = at.get(cs[i - 1].t), a1 = at.get(cs[i].t);
        if (a0 && a1) { rx.push(Math.log(a1 / a0)); ry.push(Math.log(cs[i].c / cs[i - 1].c)); }
      }
      if (rx.length >= 24) {
        const b = olsBeta(rx, ry);
        const sResid = stdev(ry.map((y, i) => y - b * rx[i]));
        const proxyDrift = Math.log(priceAt(proxy, now) / priceAt(proxy, refTime));
        c.beta = b;
        c.resid = Math.log(last / ref) - b * proxyDrift;
        c.zResid = sResid > 0 ? c.resid / (sResid * Math.sqrt(hoursSinceRef)) : 0;
        c.score = Math.max(Math.abs(c.zResid), Math.abs(z) * 0.5);
      }
    }

    c.note = describe(c, inst.base, inst.proxyOf ? m.instruments[inst.proxyOf]?.base : undefined);
    contacts.push(c);
  }
  return contacts.sort((a, b) => b.score - a.score);
}

function describe(c: Contact, base: string, proxyBase?: string): string {
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  const h = Math.round(c.hoursSinceRef);
  const size = Math.abs(c.z) >= 2 ? 'an unusually large move' : Math.abs(c.z) >= 1 ? 'a firm move' : 'a normal move';
  let s: string;
  if (c.session === 'closed') s = `${base} is ${pct(c.drift)} since the New York close ${h}h ago, ${size} for a shut market (${c.z.toFixed(1)} sigma).`;
  else if (c.session === 'open') s = `${base} is ${pct(c.drift)} since the opening bell ${h}h ago (${c.z.toFixed(1)} sigma for session hours).`;
  else s = `${base} is ${pct(c.drift)} over 24h (${c.z.toFixed(1)} sigma).`;
  if (c.zResid !== undefined && c.resid !== undefined && proxyBase) {
    s += Math.abs(c.zResid) >= 1.5
      ? ` ${proxyBase} explains only part of it: ${pct(c.resid)} is unexplained (${c.zResid.toFixed(1)} sigma).`
      : ` ${proxyBase} explains most of it (beta ${c.beta?.toFixed(2)}).`;
  }
  if (c.session !== 'always' && c.volClosed > 0 && c.volOpen > 0) {
    s += ` It moves ${(c.volOpen / c.volClosed).toFixed(1)}x more per hour when New York is open.`;
  }
  return s;
}
