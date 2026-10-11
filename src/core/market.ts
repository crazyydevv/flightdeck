// Market data: the recorded Bitget snapshot that ships with the repo, the
// instrument table, and helpers that guarantee no engine ever looks ahead.

import { Candle, Instrument, MarketState } from './types';
import { earningsCalendar } from './earnings';
import { DAY, HOUR } from './util';
import { HOURLY_FIRST_OPEN, HOURLY_ROWS, HOURLY_START } from './snapshot-hourly';
import { DAILY_FIRST_OPEN, DAILY_ROWS, DAILY_START } from './snapshot-daily';

// Contract terms recorded from GET /api/v2/mix/market/contracts on 08 Oct 2026
// (max leverage, taker fee, precision). Maintenance margin was recorded for
// NVDA and BTC from /query-position-lever (tier 1); the other stock perps reuse
// the NVDA rate, and the 20-25x contracts (MSTR, COIN, QQQ) assume 1%. Live mode
// refreshes leverage, fee and precision from the API.
//
// QQQ is the benchmark: the Radar removes the part of a stock perp's move that
// the Nasdaq 100 explains, so what is left is the stock's own.
export const INSTRUMENTS: Record<string, Instrument> = {
  NVDAUSDT: { symbol: 'NVDAUSDT', base: 'NVDA', name: 'NVIDIA', cls: 'rwa', maxLever: 100, takerFee: 0.0006, mmr: 0.005, pricePlace: 2, sizePlace: 2, proxyOf: 'QQQUSDT' },
  TSLAUSDT: { symbol: 'TSLAUSDT', base: 'TSLA', name: 'Tesla', cls: 'rwa', maxLever: 100, takerFee: 0.0006, mmr: 0.005, pricePlace: 2, sizePlace: 2, proxyOf: 'QQQUSDT' },
  MSTRUSDT: { symbol: 'MSTRUSDT', base: 'MSTR', name: 'Strategy', cls: 'rwa', maxLever: 25, takerFee: 0.0006, mmr: 0.01, pricePlace: 2, sizePlace: 2, proxyOf: 'BTCUSDT' },
  COINUSDT: { symbol: 'COINUSDT', base: 'COIN', name: 'Coinbase', cls: 'rwa', maxLever: 20, takerFee: 0.0006, mmr: 0.01, pricePlace: 2, sizePlace: 2, proxyOf: 'BTCUSDT' },
  MSFTUSDT: { symbol: 'MSFTUSDT', base: 'MSFT', name: 'Microsoft', cls: 'rwa', maxLever: 100, takerFee: 0.0006, mmr: 0.005, pricePlace: 2, sizePlace: 2, proxyOf: 'QQQUSDT' },
  AAPLUSDT: { symbol: 'AAPLUSDT', base: 'AAPL', name: 'Apple', cls: 'rwa', maxLever: 100, takerFee: 0.0006, mmr: 0.005, pricePlace: 2, sizePlace: 2, proxyOf: 'QQQUSDT' },
  QQQUSDT: { symbol: 'QQQUSDT', base: 'QQQ', name: 'Nasdaq 100 ETF', cls: 'rwa', maxLever: 20, takerFee: 0.0006, mmr: 0.01, pricePlace: 2, sizePlace: 2, etf: true },
  BTCUSDT: { symbol: 'BTCUSDT', base: 'BTC', name: 'Bitcoin', cls: 'crypto', maxLever: 150, takerFee: 0.0006, mmr: 0.004, pricePlace: 1, sizePlace: 4 },
};

// Extra symbols requested in live mode. Their terms come from the API.
// PLTR and SPY were confirmed on the contracts endpoint on 08 Oct 2026; any
// symbol Bitget does not list is skipped when the live market loads.
export const LIVE_EXTRA: Record<string, Pick<Instrument, 'base' | 'name' | 'cls' | 'proxyOf' | 'etf'>> = {
  METAUSDT: { base: 'META', name: 'Meta', cls: 'rwa', proxyOf: 'QQQUSDT' },
  AMZNUSDT: { base: 'AMZN', name: 'Amazon', cls: 'rwa', proxyOf: 'QQQUSDT' },
  GOOGLUSDT: { base: 'GOOGL', name: 'Alphabet', cls: 'rwa', proxyOf: 'QQQUSDT' },
  PLTRUSDT: { base: 'PLTR', name: 'Palantir', cls: 'rwa', proxyOf: 'QQQUSDT' },
  SPYUSDT: { base: 'SPY', name: 'S&P 500 ETF', cls: 'rwa', etf: true },
  ETHUSDT: { base: 'ETH', name: 'Ether', cls: 'crypto' },
  SOLUSDT: { base: 'SOL', name: 'Solana', cls: 'crypto' },
};

function parseRows(text: string, start: number, step: number, firstOpen?: number): Candle[] {
  const out: Candle[] = [];
  let prevClose = firstOpen ?? NaN;
  text.trim().split('\n').forEach((line, i) => {
    const n = line.trim().split(/\s+/).map(Number);
    const [o, h, l, c] = n.length === 4 ? n : [prevClose, n[0], n[1], n[2]];
    // a bar's range always contains its open and close
    out.push({ t: start + i * step, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c });
    prevClose = c;
  });
  return out;
}

let cached: MarketState | null = null;

/** The recorded Bitget snapshot: 7 days of hourly bars and about 90 daily bars. */
export function snapshot(): MarketState {
  if (cached) return cached;
  const hourly: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const sym of Object.keys(INSTRUMENTS)) {
    hourly[sym] = parseRows(HOURLY_ROWS[sym], HOURLY_START, HOUR, HOURLY_FIRST_OPEN[sym]);
    daily[sym] = parseRows(DAILY_ROWS[sym], DAILY_START[sym], DAY, DAILY_FIRST_OPEN[sym]);
  }
  cached = {
    source: 'recorded',
    asOf: HOURLY_START + 168 * HOUR,
    instruments: INSTRUMENTS,
    hourly,
    daily,
    // funding as printed by the ticker endpoint when recorded
    funding: { NVDAUSDT: 0, TSLAUSDT: 0, MSTRUSDT: -0.000271, COINUSDT: 0, MSFTUSDT: 0, AAPLUSDT: 0, BTCUSDT: 0.0001 },
    basis: {},
  };
  return cached;
}

export const SNAPSHOT_END = HOURLY_START + 168 * HOUR;
/** The simulator clock starts here so 30 recorded hours remain to fly through. */
export const SIM_START = SNAPSHOT_END - 30 * HOUR;

/**
 * The market as it was known at `now`: every bar that had not fully closed by
 * then is dropped. Radar and Preflight only ever see this view, so a recorded
 * session can be replayed without the engines peeking at the outcome.
 */
export function viewAsOf(m: MarketState, now: number): MarketState {
  // live data is already "as of now"; its last bar is the one still forming
  if (m.source === 'live') return m;
  const cut = (cs: Candle[], step: number) => cs.filter((c) => c.t + step <= now);
  const hourly: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const s of Object.keys(m.hourly)) hourly[s] = cut(m.hourly[s], HOUR);
  for (const s of Object.keys(m.daily)) daily[s] = cut(m.daily[s] ?? [], DAY);
  return { ...m, asOf: Math.min(m.asOf, now), hourly, daily, earnings: earningsCalendar(now) };
}

export function lastPrice(m: MarketState, symbol: string): number {
  const cs = m.hourly[symbol];
  return cs && cs.length ? cs[cs.length - 1].c : NaN;
}

/** Hourly bars that opened at or after `from` and closed by `to`. */
export function hourlyBetween(m: MarketState, symbol: string, from: number, to: number): Candle[] {
  return (m.hourly[symbol] ?? []).filter((c) => c.t >= from && c.t + HOUR <= to);
}

export const logReturns = (cs: Candle[]) => cs.slice(1).map((c, i) => Math.log(c.c / cs[i].c));
