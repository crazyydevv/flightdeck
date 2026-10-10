// Server-side Bitget client: public market data (no key) and signed orders.
// Never import this file from the browser bundle; it reads secrets from env.

import { createHmac, randomUUID } from 'node:crypto';
import { earningsCalendar } from './earnings';
import { INSTRUMENTS, LIVE_EXTRA } from './market';
import { Candle, FlightPlan, Instrument, MarketState } from './types';

const BASE = process.env.BITGET_BASE_URL || 'https://api.bitget.com';
const PRODUCT = 'USDT-FUTURES';

async function publicGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { locale: 'en-US' }, signal: AbortSignal.timeout(12_000) });
  const json = (await res.json()) as { code: string; msg: string; data: T };
  if (!res.ok || json.code !== '00000') throw new Error(`Bitget ${path}: ${json.code} ${json.msg}`);
  return json.data;
}

const toCandles = (rows: string[][]): Candle[] =>
  rows.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));

interface Ticker { symbol: string; lastPr: string; indexPrice: string; fundingRate: string }
interface Contract { symbol: string; maxLever: string; takerFeeRate: string; pricePlace: string; volumePlace: string; isRwa?: string }

/** Everything the engines need, from four public endpoints. */
export async function loadLiveMarket(): Promise<MarketState> {
  const wanted = [...Object.keys(INSTRUMENTS), ...Object.keys(LIVE_EXTRA)];
  const tickers = await publicGet<Ticker[]>('/api/v2/mix/market/tickers', { productType: PRODUCT });
  const tick = new Map(tickers.map((t) => [t.symbol, t]));

  const state: MarketState = { source: 'live', asOf: Date.now(), instruments: {}, hourly: {}, daily: {}, funding: {}, basis: {} };
  await Promise.all(wanted.filter((s) => tick.has(s)).map(async (symbol) => {
    try {
      const [hourly, daily, contracts] = await Promise.all([
        publicGet<string[][]>('/api/v2/mix/market/candles', { symbol, productType: PRODUCT, granularity: '1H', limit: 500 }),
        publicGet<string[][]>('/api/v2/mix/market/candles', { symbol, productType: PRODUCT, granularity: '1D', limit: 90 }),
        publicGet<Contract[]>('/api/v2/mix/market/contracts', { symbol, productType: PRODUCT }),
      ]);
      const known = INSTRUMENTS[symbol];
      const extra = LIVE_EXTRA[symbol];
      const c = contracts[0];
      const rwa = c?.isRwa ? c.isRwa === 'YES' : (known ?? extra).cls === 'rwa';
      const inst: Instrument = {
        symbol,
        base: (known ?? extra).base,
        name: (known ?? extra).name,
        cls: rwa ? 'rwa' : 'crypto',
        maxLever: Number(c?.maxLever) || known?.maxLever || 20,
        takerFee: Number(c?.takerFeeRate) || known?.takerFee || 0.0006,
        mmr: known?.mmr ?? (rwa ? (Number(c?.maxLever) <= 50 ? 0.01 : 0.005) : 0.004),
        pricePlace: Number(c?.pricePlace ?? known?.pricePlace ?? 2),
        sizePlace: Number(c?.volumePlace ?? known?.sizePlace ?? 2),
        proxyOf: (known ?? extra).proxyOf,
        etf: (known ?? extra).etf,
      };
      const t = tick.get(symbol) as Ticker;
      state.instruments[symbol] = inst;
      state.hourly[symbol] = toCandles(hourly);
      state.daily[symbol] = toCandles(daily);
      state.funding[symbol] = Number(t.fundingRate) || 0;
      const index = Number(t.indexPrice), last = Number(t.lastPr);
      if (index > 0 && last > 0) state.basis[symbol] = last / index - 1;
    } catch {
      // one bad symbol must not take the board down
    }
  }));
  if (!Object.keys(state.hourly).length) throw new Error('Bitget returned no usable market data');
  state.earnings = earningsCalendar(Date.now(), process.env.EARNINGS_JSON);
  return state;
}

// ---- Signed trading -------------------------------------------------------------

export interface Credentials { key: string; secret: string; passphrase: string }

export function credentialsFromEnv(): Credentials | null {
  const { BITGET_API_KEY: key, BITGET_SECRET_KEY: secret, BITGET_PASSPHRASE: passphrase } = process.env;
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

/** 'demo' unless the operator explicitly opts in to real money. */
export function tradingMode(): 'demo' | 'live' {
  return process.env.BITGET_TRADING_MODE === 'live' ? 'live' : 'demo';
}

/** Bitget signature: base64(HMAC-SHA256(secret, timestamp + METHOD + path + body)). */
export function sign(secret: string, timestamp: string, method: string, pathWithQuery: string, body: string): string {
  return createHmac('sha256', secret).update(timestamp + method.toUpperCase() + pathWithQuery + body).digest('base64');
}

async function signedPost<T>(path: string, payload: unknown, creds: Credentials, demo: boolean): Promise<T> {
  const body = JSON.stringify(payload);
  const ts = Date.now().toString();
  const headers: Record<string, string> = {
    'ACCESS-KEY': creds.key,
    'ACCESS-SIGN': sign(creds.secret, ts, 'POST', path, body),
    'ACCESS-TIMESTAMP': ts,
    'ACCESS-PASSPHRASE': creds.passphrase,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
  // Demo Trading uses the same REST paths with this header and a demo API key.
  if (demo) headers.paptrading = '1';
  const res = await fetch(BASE + path, { method: 'POST', headers, body, signal: AbortSignal.timeout(12_000) });
  const json = (await res.json()) as { code: string; msg: string; data: T };
  if (json.code !== '00000') throw new Error(`${json.code} ${json.msg}`);
  return json.data;
}

/** The exact order FLIGHTDECK would send. Also returned on dry runs so it can be inspected. */
export function orderPayload(plan: FlightPlan, inst: Instrument) {
  const qty = (plan.margin * plan.leverage) / plan.entry;
  // Never send more than was cleared: size rounds down to the contract's precision,
  // and leverage goes to the exchange as a whole number, rounded down.
  const unit = 10 ** inst.sizePlace;
  const size = Math.floor(qty * unit + 1e-9) / unit;
  const productType = process.env.BITGET_PRODUCT_TYPE || PRODUCT;
  return {
    leverage: { symbol: plan.symbol, productType, marginCoin: 'USDT', leverage: String(Math.max(1, Math.floor(plan.leverage))), holdSide: plan.side },
    order: {
      symbol: plan.symbol, productType, marginMode: 'isolated', marginCoin: 'USDT',
      size: size.toFixed(inst.sizePlace), side: plan.side === 'long' ? 'buy' : 'sell', tradeSide: 'open',
      orderType: 'market', clientOid: 'fd-' + randomUUID(),
      ...(plan.stop ? { presetStopLossPrice: plan.stop.toFixed(inst.pricePlace) } : {}),
      ...(plan.target ? { presetStopSurplusPrice: plan.target.toFixed(inst.pricePlace) } : {}),
    },
  };
}

export async function placeOrder(plan: FlightPlan, inst: Instrument, creds: Credentials, demo = tradingMode() === 'demo'): Promise<{ orderId: string; venue: string }> {
  const payload = orderPayload(plan, inst);
  await signedPost('/api/v2/mix/account/set-leverage', payload.leverage, creds, demo);
  const data = await signedPost<{ orderId: string }>('/api/v2/mix/order/place-order', payload.order, creds, demo);
  return { orderId: data.orderId, venue: demo ? 'bitget-demo' : 'bitget-live' };
}

/**
 * Close part or all of a position at market. In Bitget hedge mode a long is
 * closed with side "buy" and tradeSide "close", a short with "sell" and "close".
 */
export async function closeOrder(symbol: string, side: 'long' | 'short', qty: number, inst: Instrument, creds: Credentials): Promise<{ orderId: string }> {
  const payload = {
    symbol, productType: process.env.BITGET_PRODUCT_TYPE || PRODUCT, marginMode: 'isolated', marginCoin: 'USDT',
    size: qty.toFixed(inst.sizePlace), side: side === 'long' ? 'buy' : 'sell', tradeSide: 'close', orderType: 'market', clientOid: 'fd-' + randomUUID(),
  };
  return signedPost<{ orderId: string }>('/api/v2/mix/order/place-order', payload, creds, tradingMode() === 'demo');
}

async function signedGet<T>(path: string, params: Record<string, string | number>, creds: Credentials, demo: boolean): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const ts = Date.now().toString();
  const headers: Record<string, string> = {
    'ACCESS-KEY': creds.key, 'ACCESS-SIGN': sign(creds.secret, ts, 'GET', `${path}?${qs}`, ''), 'ACCESS-TIMESTAMP': ts,
    'ACCESS-PASSPHRASE': creds.passphrase, 'Content-Type': 'application/json', locale: 'en-US',
  };
  if (demo) headers.paptrading = '1';
  const res = await fetch(`${BASE}${path}?${qs}`, { headers, signal: AbortSignal.timeout(12_000) });
  const json = (await res.json()) as { code: string; msg: string; data: T };
  if (json.code !== '00000') throw new Error(`${json.code} ${json.msg}`);
  return json.data;
}

/**
 * A trader's own closed futures positions for the last `days`, plus the order
 * history needed to recover leverage. Read permission is enough.
 */
export async function fetchHistory(creds: Credentials, demo: boolean, days = 90): Promise<{ positions: Record<string, unknown>[]; orders: Record<string, unknown>[] }> {
  const endTime = Date.now(), startTime = endTime - days * 86_400_000;
  const base = { productType: process.env.BITGET_PRODUCT_TYPE || PRODUCT, startTime, endTime, limit: 100 };
  const positions: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await signedGet<{ list?: Record<string, unknown>[]; endId?: string }>('/api/v2/mix/position/history-position', cursor ? { ...base, idLessThan: cursor } : base, creds, demo);
    positions.push(...(data.list ?? []));
    if (!data.endId || (data.list ?? []).length < 100) break;
    cursor = data.endId;
  }
  let orders: Record<string, unknown>[] = [];
  try {
    const data = await signedGet<{ entrustedList?: Record<string, unknown>[] }>('/api/v2/mix/order/orders-history', base, creds, demo);
    orders = data.entrustedList ?? [];
  } catch {
    // leverage falls back to 1x when order history is not readable
  }
  return { positions, orders };
}
