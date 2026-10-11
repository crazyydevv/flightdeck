// Shared pieces of the study: the 40-day market, the "what the engines could
// see at that hour" view, and the statistics. Nothing here changes an engine;
// the study only calls the same functions the app calls.

import fs from 'node:fs';
import path from 'node:path';
import { earningsCalendar } from '../src/core/earnings';
import { INSTRUMENTS, snapshot } from '../src/core/market';
import { Candle, MarketState } from '../src/core/types';
import { DAY, HOUR } from '../src/core/util';
import { DAILY_HISTORY_FIRST_OPEN, DAILY_HISTORY_ROWS, DAILY_HISTORY_START } from './history-daily';
import { HISTORY_FIRST_OPEN, HISTORY_ROWS, HISTORY_START } from './history-hourly';

/** Rows of "high low close", each bar opening at the previous close. */
export function parseRows(text: string, start: number, step: number, firstOpen: number): Candle[] {
  const out: Candle[] = [];
  let prev = firstOpen;
  text.trim().split('\n').forEach((line, i) => {
    const [h, l, c] = line.trim().split(/\s+/).map(Number);
    out.push({ t: start + i * step, o: prev, h, l, c });
    prev = c;
  });
  return out;
}

export const parseHistory = (symbol: string) => parseRows(HISTORY_ROWS[symbol], HISTORY_START, HOUR, HISTORY_FIRST_OPEN[symbol]);
export const parseDailyHistory = (symbol: string) => parseRows(DAILY_HISTORY_ROWS[symbol], DAILY_HISTORY_START, DAY, DAILY_HISTORY_FIRST_OPEN[symbol]);

/** Daily bars (16:00 to 16:00 UTC, as Bitget cuts them) built from complete sets of 24 hourly bars. */
export function dailyFromHourly(hourly: Candle[], from: number): Candle[] {
  const out: Candle[] = [];
  for (let t = from; ; t += DAY) {
    const inside = hourly.filter((c) => c.t >= t && c.t < t + DAY);
    if (inside.length !== 24) break;
    out.push({ t, o: inside[0].o, h: Math.max(...inside.map((c) => c.h)), l: Math.min(...inside.map((c) => c.l)), c: inside[23].c });
  }
  return out;
}

/**
 * The market the study runs on. Hourly: 968 consecutive bars per contract (the
 * 800 recorded in this folder plus the app's own 168). Daily: 90 recorded bars
 * up to 29 Aug, then one bar per complete day of hourly data, 130 in all.
 */
export function studyMarket(forward: Record<string, Candle[]> = {}): MarketState {
  const snap = snapshot();
  const hourly: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const sym of Object.keys(INSTRUMENTS)) {
    hourly[sym] = [...parseHistory(sym), ...snap.hourly[sym], ...(forward[sym] ?? [])];
    const recorded = parseDailyHistory(sym);
    daily[sym] = [...recorded, ...dailyFromHourly(hourly[sym], recorded[recorded.length - 1].t + DAY)];
  }
  // Funding is left out: the only rates on file were printed on 08 Oct, and
  // using them for a trade in September would be reading the future.
  return { ...snap, hourly, daily, funding: {}, basis: {} };
}

// ---- the forward test's candles ------------------------------------------------
// Hourly bars recorded AFTER the study was frozen (8 October 2026 19:00 UTC).
// research/forward-fetch.ts appends to this file; the frozen study never reads it.

export const FORWARD_FILE = process.env.FLIGHTDECK_FORWARD_FILE || path.join(process.cwd(), 'research', 'forward-hourly.json');

export interface ForwardStore { start: number; bars: Record<string, number[][]> }

export function readForward(file = FORWARD_FILE): ForwardStore {
  const start = snapshot().asOf;
  if (!fs.existsSync(file)) return { start, bars: {} };
  const store = JSON.parse(fs.readFileSync(file, 'utf8')) as ForwardStore;
  if (store.start !== start) throw new Error(`forward file starts at ${store.start}, expected ${start}`);
  return store;
}

/** The stored forward bars as candles, cut to the hours every contract has. */
export function forwardCandles(store: ForwardStore = readForward()): Record<string, Candle[]> {
  const symbols = Object.keys(INSTRUMENTS);
  const n = Math.min(...symbols.map((s) => store.bars[s]?.length ?? 0));
  return Object.fromEntries(symbols.map((s) => [s, (store.bars[s] ?? []).slice(0, n).map(([o, h, l, c], i) => ({ t: store.start + i * HOUR, o, h, l, c }))]));
}

/** How many hourly and daily bars the live app asks Bitget for (src/core/bitget.ts). */
export const LOOKBACK_H = 500;
export const LOOKBACK_D = 90;

/**
 * The market exactly as the live app would have seen it at `now`: the last 500
 * hourly bars and the last 90 daily bars that had closed. No bar that
 * closes after `now` is in here.
 */
export function viewAt(full: MarketState, now: number): MarketState {
  const hourly: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const s of Object.keys(full.hourly)) {
    const closed = full.hourly[s].filter((c) => c.t + HOUR <= now);
    hourly[s] = closed.slice(-LOOKBACK_H);
    daily[s] = (full.daily[s] ?? []).filter((c) => c.t + DAY <= now).slice(-LOOKBACK_D);
  }
  return { ...full, source: 'recorded', asOf: now, hourly, daily, earnings: earningsCalendar(now) };
}

// ---- statistics --------------------------------------------------------------

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Mean of the worst `q` share of results: the expected shortfall. */
export function shortfall(xs: number[], q = 0.05): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return mean(s.slice(0, Math.max(1, Math.round(s.length * q))));
}

/** Deterministic generator, so the confidence intervals are the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% interval for a statistic by resampling whole entry days. Trades entered
 * on the same day, on any contract, stay together, because they share the same
 * market and are not independent of one another.
 */
export function dayBootstrap<T>(byDay: T[][], stat: (rows: T[]) => number, draws = 1000, seed = 7): [number, number] {
  const r = rng(seed);
  const out: number[] = [];
  for (let b = 0; b < draws; b++) {
    const rows: T[] = [];
    for (let i = 0; i < byDay.length; i++) for (const x of byDay[Math.floor(r() * byDay.length)]) rows.push(x);
    const v = stat(rows);
    if (Number.isFinite(v)) out.push(v);
  }
  return [quantile(out, 0.025), quantile(out, 0.975)];
}
