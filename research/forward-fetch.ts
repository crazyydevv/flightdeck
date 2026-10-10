// THE FORWARD TEST, part 1: fetch the hours that have happened since the study
// was frozen (8 October 2026 19:00 UTC) and append them to
// research/forward-hourly.json.
//
//   tsx research/forward-fetch.ts
//
// Run weekly by .github/workflows/forward-test.yml. It only ever appends closed
// bars that join the bars already held, and it writes nothing if any contract
// fails a check, so a bad response cannot corrupt the record.

import fs from 'node:fs';
import { INSTRUMENTS, snapshot } from '../src/core/market';
import { Candle } from '../src/core/types';
import { HOUR } from '../src/core/util';
import { FORWARD_FILE, ForwardStore, readForward } from './lib';

const PAGE = 200;

/** Closed hourly bars with `since <= t` and `t + 1h <= now`, oldest first. */
export async function fetchSince(symbol: string, since: number, now: number, base: string): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  let end = Math.floor(now / HOUR) * HOUR; // bars that opened before this hour have closed
  for (let page = 0; page < 200 && end > since; page++) {
    const url = `${base}/api/v2/mix/market/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1H&endTime=${end}&limit=${PAGE}`;
    const res = await fetch(url, { headers: { locale: 'en-US' }, signal: AbortSignal.timeout(20_000) });
    const json = (await res.json()) as { code: string; msg: string; data: string[][] };
    if (!res.ok || json.code !== '00000') throw new Error(`Bitget history-candles ${symbol}: ${json.code} ${json.msg}`);
    const rows = json.data.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
    if (!rows.length) break;
    for (const c of rows) if (c.t >= since && c.t + HOUR <= now) byTime.set(c.t, c);
    const oldest = Math.min(...rows.map((c) => c.t));
    if (oldest >= end) break; // no progress
    end = oldest;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** Throws unless `bars` continues directly from `prevClose` at `since`, hour by hour, with sane ranges. */
export function checkJoin(symbol: string, bars: Candle[], since: number, prevClose: number): void {
  bars.forEach((c, i) => {
    if (![c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0)) throw new Error(`${symbol}: bad number at ${new Date(c.t).toISOString()}`);
    if (c.t !== since + i * HOUR) throw new Error(`${symbol}: expected ${new Date(since + i * HOUR).toISOString()}, got ${new Date(c.t).toISOString()}`);
    if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) throw new Error(`${symbol}: range does not hold open and close at ${new Date(c.t).toISOString()}`);
    const before = i ? bars[i - 1].c : prevClose;
    // Bitget's hourly bars open at the previous close; allow a hair for a contract that ever breaks that
    if (Math.abs(c.o / before - 1) > 0.02) throw new Error(`${symbol}: ${new Date(c.t).toISOString()} opens ${c.o}, previous close ${before}`);
  });
}

export async function update(now: number, base: string, file = FORWARD_FILE): Promise<{ added: number; hours: number }> {
  const store: ForwardStore = readForward(file);
  const snap = snapshot();
  const next: Record<string, number[][]> = {};
  for (const symbol of Object.keys(INSTRUMENTS)) {
    const held = store.bars[symbol] ?? [];
    const since = store.start + held.length * HOUR;
    const prevClose = held.length ? held[held.length - 1][3] : snap.hourly[symbol][snap.hourly[symbol].length - 1].c;
    const fresh = await fetchSince(symbol, since, now, base);
    checkJoin(symbol, fresh, since, prevClose);
    next[symbol] = [...held, ...fresh.map((c) => [c.o, c.h, c.l, c.c])];
  }
  // keep only the hours every contract has, so the eight series always end together
  const hours = Math.min(...Object.values(next).map((b) => b.length));
  const before = Math.min(...Object.keys(INSTRUMENTS).map((s) => store.bars[s]?.length ?? 0));
  for (const s of Object.keys(next)) next[s] = next[s].slice(0, hours);
  fs.writeFileSync(file, JSON.stringify({ start: store.start, bars: next }) + '\n');
  return { added: hours - before, hours };
}

if (process.argv[1] && /forward-fetch\.[cm]?[tj]s$/.test(process.argv[1])) {
  update(Date.now(), process.env.BITGET_BASE_URL || 'https://api.bitget.com')
    .then((r) => console.log(`forward candles: ${r.added} new hours, ${r.hours} held since the study was frozen`))
    .catch((e) => { console.error(String(e)); process.exit(1); });
}
