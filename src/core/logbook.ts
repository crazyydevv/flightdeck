// Logbook sources: a clearly-labelled synthetic sample so the Black Box has
// something to read on first launch, and a CSV importer for real history.

import { isUsOpen } from './calendar';
import { INSTRUMENTS } from './market';
import { AssetClass, Flight, Outcome, Side } from './types';
import { DAY } from './util';

const PRICES: Record<string, number> = { NVDAUSDT: 225, TSLAUSDT: 365, MSFTUSDT: 500, AAPLUSDT: 330, COINUSDT: 185, MSTRUSDT: 150, BTCUSDT: 78000 };
const SEP14 = Date.UTC(2026, 8, 14);

// day offset from Mon 14 Sep 2026, "HH:MM" UTC, symbol, side, leverage, margin,
// result as % of notional (before fees), minutes held, stop filed?, liquidated?
type Row = [number, string, string, Side, number, number, number, number, boolean, boolean?];

const SCRIPT: Row[] = [
  [0, '14:10', 'NVDA', 'long', 3, 300, 1.4, 180, true],
  [0, '17:30', 'MSFT', 'long', 2, 300, 0.6, 120, true],
  [1, '14:40', 'TSLA', 'short', 3, 300, -1.0, 60, true],
  [1, '15:50', 'TSLA', 'short', 6, 400, -1.2, 25, true],
  [1, '16:25', 'TSLA', 'long', 8, 400, -0.9, 20, true],
  [2, '15:00', 'AAPL', 'long', 2, 300, 0.8, 200, true],
  [2, '18:40', 'NVDA', 'long', 3, 300, 0.9, 60, true],
  [3, '14:20', 'COIN', 'long', 3, 250, 2.1, 240, true],
  [4, '18:30', 'BTC', 'long', 4, 300, 0.7, 300, true],
  [5, '03:00', 'NVDA', 'long', 10, 300, -1.6, 240, false],
  [6, '22:00', 'TSLA', 'long', 12, 300, -2.2, 180, true],
  [7, '14:30', 'MSFT', 'long', 2, 300, 1.1, 80, true],
  [7, '16:00', 'NVDA', 'short', 3, 300, 0.5, 120, true],
  [8, '13:40', 'NVDA', 'long', 3, 300, 0.3, 15, true],
  [8, '14:00', 'NVDA', 'long', 3, 300, -0.6, 15, true],
  [8, '14:20', 'NVDA', 'long', 5, 300, -0.8, 25, true],
  [8, '14:50', 'TSLA', 'long', 3, 300, 0.4, 30, true],
  [8, '15:25', 'TSLA', 'short', 3, 300, -0.5, 15, true],
  [8, '15:45', 'TSLA', 'short', 6, 350, -0.9, 40, true],
  [8, '16:30', 'NVDA', 'short', 4, 300, -0.7, 40, true],
  [8, '17:15', 'AAPL', 'long', 4, 300, -0.4, 50, true],
  [8, '18:10', 'AAPL', 'long', 5, 300, 0.2, 60, true],
  [9, '15:10', 'AAPL', 'long', 2, 300, 0.9, 180, true],
  [10, '14:45', 'COIN', 'short', 3, 250, -1.0, 90, true],
  [10, '18:00', 'BTC', 'long', 3, 300, 1.3, 360, true],
  [11, '15:00', 'NVDA', 'long', 3, 300, 1.0, 200, true],
  [12, '09:00', 'MSTR', 'long', 8, 300, -3.9, 420, false],
  [13, '20:00', 'NVDA', 'short', 10, 250, -1.3, 200, true],
  [14, '14:00', 'TSLA', 'long', 3, 300, 1.8, 180, true],
  [14, '17:30', 'MSFT', 'long', 2, 300, 0.4, 120, true],
  [15, '14:30', 'NVDA', 'long', 3, 300, -1.0, 60, true],
  [15, '15:45', 'NVDA', 'long', 7, 400, -1.1, 45, true],
  [16, '02:30', 'TSLA', 'short', 15, 300, -6.2, 300, false, true],
  [16, '15:00', 'AAPL', 'long', 2, 300, 0.7, 180, true],
  [17, '14:15', 'COIN', 'long', 3, 250, 1.6, 120, true],
  [17, '16:40', 'BTC', 'short', 4, 300, 0.9, 150, true],
  [18, '15:20', 'MSFT', 'long', 2, 300, 1.2, 240, true],
  [19, '14:00', 'NVDA', 'long', 2, 300, 0.5, 300, true],
  [20, '15:00', 'AAPL', 'long', 3, 300, 0.3, 240, true],
  [21, '14:30', 'NVDA', 'long', 3, 300, 1.2, 200, true],
  [22, '15:00', 'TSLA', 'short', 3, 300, 0.8, 180, true],
];

/** A synthetic three-week logbook with deliberate bad habits. Not real trades. */
export function sampleLogbook(startBalance = 10_000): Flight[] {
  let balance = startBalance;
  const flights = SCRIPT.map((r, i): Flight => {
    const [day, hm, base, side, leverage, margin, pct, mins, hasStop, liquidated] = r;
    const symbol = base + 'USDT';
    const inst = INSTRUMENTS[symbol];
    const [hh, mm] = hm.split(':').map(Number);
    const openedAt = SEP14 + day * DAY + hh * 3_600_000 + mm * 60_000;
    const d = side === 'long' ? 1 : -1;
    const entry = PRICES[symbol];
    const exit = entry * (1 + (pct / 100) * d);
    const notional = margin * leverage;
    const fees = notional * inst.takerFee * 2;
    const pnl = liquidated ? -margin : (notional * pct) / 100 - fees;
    const outcome: Outcome = liquidated ? 'liquidated' : pct < 0 && hasStop ? 'stopped' : pct > 0.6 ? 'target' : 'landed';
    const k = 1 / leverage - inst.mmr;
    return {
      id: 'SX' + String(i + 1).padStart(2, '0'),
      symbol, side, leverage, margin, qty: notional / entry, entry,
      stop: hasStop ? entry * (1 - d * (pct < 0 ? -pct / 100 : 0.01)) : undefined,
      liqPrice: side === 'long' ? entry * (1 - k) : entry * (1 + k),
      openedAt, horizonH: Math.ceil(mins / 60), origin: 'pilot', cls: inst.cls,
      usOpenAtEntry: inst.cls === 'rwa' ? isUsOpen(openedAt) : null,
      closedAt: openedAt + mins * 60_000, exit, pnl, fees, outcome, venue: 'sample',
    };
  });
  for (const f of [...flights].sort((a, b) => (a.closedAt as number) - (b.closedAt as number))) {
    balance += f.pnl as number;
    f.balanceAfter = balance;
  }
  return flights;
}

// ---- CSV import ---------------------------------------------------------------

const ALIASES: Record<string, string[]> = {
  opened: ['openedat', 'opentime', 'entrytime', 'timestamp', 'timestamputc', 'time', 'date', 'datetime', 'ctime'],
  closed: ['closedat', 'closetime', 'exittime', 'utime'],
  symbol: ['symbol', 'pair', 'instrument', 'market', 'tradingpair'],
  side: ['side', 'direction', 'positionside', 'holdside'],
  entry: ['entry', 'entryprice', 'openprice', 'avgprice', 'openavgprice', 'price'],
  exit: ['exit', 'exitprice', 'closeprice', 'closeavgprice'],
  qty: ['qty', 'quantity', 'size', 'amount', 'closetotalpos', 'opentotalpos'],
  leverage: ['leverage', 'lever'],
  margin: ['margin', 'marginusdt'],
  pnl: ['pnl', 'pnlusdt', 'realizedpnl', 'realisedpnl', 'netprofit', 'profit'],
  stop: ['stop', 'stoploss', 'sl'],
  flight: ['flight', 'id', 'tradeid'],
  action: ['action'],
};

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toTime(v: string): number {
  if (/^\d{12,}$/.test(v)) return Number(v);
  if (/^\d{9,11}$/.test(v)) return Number(v) * 1000;
  return Date.parse(v);
}

const toSide = (v: string): Side => (/short|sell/i.test(v) ? 'short' : 'long');

function classOf(symbol: string): AssetClass {
  return INSTRUMENTS[symbol]?.cls ?? (/^(BTC|ETH|SOL|XRP|DOGE|BNB|ADA)/.test(symbol) ? 'crypto' : 'rwa');
}

export interface ImportResult { flights: Flight[]; skipped: number; error?: string }

/**
 * Accepts either one row per closed trade (needs time, symbol, side, entry
 * price, quantity and pnl) or FLIGHTDECK's own exported log (open/close rows
 * sharing a flight id).
 */
export function importCsv(text: string): ImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { flights: [], skipped: 0, error: 'Paste a header row and at least one trade.' };
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col: Record<string, number> = {};
  for (const key of Object.keys(ALIASES)) {
    col[key] = header.findIndex((h) => ALIASES[key].includes(h));
  }
  const need = ['opened', 'symbol', 'side', 'pnl'].filter((k) => col[k] < 0);
  if (col.entry < 0) need.push('entry');
  if (need.length) return { flights: [], skipped: 0, error: `Missing column${need.length > 1 ? 's' : ''}: ${need.join(', ')}.` };

  const rows = lines.slice(1).map(splitCsv);
  const get = (r: string[], k: string) => (col[k] >= 0 ? r[col[k]] ?? '' : '');
  const flights: Flight[] = [];
  let skipped = 0;

  const build = (open: string[], close: string[], i: number) => {
    const symbol = get(open, 'symbol').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const openedAt = toTime(get(open, 'opened'));
    const entry = Number(get(open, 'entry'));
    const pnl = Number(get(close, 'pnl'));
    if (!symbol || !Number.isFinite(openedAt) || !Number.isFinite(entry) || !Number.isFinite(pnl) || entry <= 0) { skipped++; return; }
    const side = toSide(get(open, 'side'));
    const leverage = Number(get(open, 'leverage')) || 1;
    const qty = Math.abs(Number(get(open, 'qty'))) || 0;
    const margin = Number(get(open, 'margin')) || (qty * entry) / leverage || 100;
    const closedRaw = close === open ? toTime(get(close, 'closed')) : toTime(get(close, 'opened'));
    const closedAt = Number.isFinite(closedRaw) && closedRaw > openedAt ? closedRaw : openedAt + 3_600_000;
    const exitRaw = Number(get(close, close === open ? 'exit' : 'entry'));
    const stop = Number(get(open, 'stop'));
    const cls = classOf(symbol);
    const k = 1 / leverage - 0.005;
    flights.push({
      id: get(open, 'flight') || 'IM' + String(i + 1).padStart(3, '0'),
      symbol, side, leverage, margin, qty: qty || (margin * leverage) / entry, entry,
      stop: Number.isFinite(stop) && stop > 0 ? stop : undefined,
      stopUnknown: col.stop < 0 ? true : undefined,
      liqPrice: side === 'long' ? entry * (1 - k) : entry * (1 + k),
      openedAt, horizonH: Math.max(1, Math.ceil((closedAt - openedAt) / 3_600_000)), origin: 'pilot', cls,
      usOpenAtEntry: cls === 'rwa' ? isUsOpen(openedAt) : null,
      closedAt, exit: Number.isFinite(exitRaw) && exitRaw > 0 ? exitRaw : entry, pnl, fees: 0,
      outcome: /liquid/i.test(get(close, 'action')) ? 'liquidated' : 'landed', venue: 'import',
    });
  };

  if (col.action >= 0 && col.flight >= 0) {
    const opens = new Map<string, string[]>();
    rows.forEach((r, i) => {
      const id = get(r, 'flight');
      if (/^open/i.test(get(r, 'action'))) opens.set(id, r);
      else if (opens.has(id)) build(opens.get(id) as string[], r, i);
      else skipped++;
    });
  } else {
    rows.forEach((r, i) => build(r, r, i));
  }
  return { flights, skipped };
}

// ---- Bitget account history -----------------------------------------------------

type Raw = Record<string, unknown>;
const num = (v: unknown) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const pick = (r: Raw, ...keys: string[]) => { for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k]; return undefined; };

/**
 * Closed positions from Bitget (GET /api/v2/mix/position/history-position)
 * turned into logbook flights. Position history does not carry leverage, so it
 * is read from the order that opened the position when order history is given.
 */
export function historyToFlights(positions: Raw[], orders: Raw[] = []): ImportResult {
  const flights: Flight[] = [];
  let skipped = 0;
  const opens = orders
    .filter((o) => /open/i.test(String(pick(o, 'tradeSide') ?? 'open')))
    .map((o) => ({ symbol: String(o.symbol), side: /short|sell/i.test(String(pick(o, 'posSide', 'side'))) ? 'short' : 'long', at: num(pick(o, 'cTime', 'ctime')), leverage: num(o.leverage) }))
    .filter((o) => o.leverage > 0 && Number.isFinite(o.at));
  positions.forEach((p, i) => {
    const symbol = String(p.symbol ?? '').toUpperCase();
    const entry = num(pick(p, 'openAvgPrice', 'openPriceAvg'));
    const exit = num(pick(p, 'closeAvgPrice', 'closePriceAvg'));
    const qty = Math.abs(num(pick(p, 'openTotalPos', 'closeTotalPos', 'total')));
    const pnl = num(pick(p, 'netProfit', 'pnl'));
    const openedAt = num(pick(p, 'ctime', 'cTime')), closedAt = num(pick(p, 'utime', 'uTime'));
    if (!symbol || !(entry > 0) || !(qty > 0) || !Number.isFinite(pnl) || !Number.isFinite(openedAt)) { skipped++; return; }
    const side: Side = /short/i.test(String(p.holdSide)) ? 'short' : 'long';
    // the opening order is the latest "open" on this symbol and side at or just before the position's start
    const opener = opens.filter((o) => o.symbol === symbol && o.side === side && o.at <= openedAt + 60_000).sort((a, b) => b.at - a.at)[0];
    const leverage = num(p.leverage) > 0 ? num(p.leverage) : opener?.leverage ?? 1;
    const cls = classOf(symbol);
    const k = 1 / leverage - 0.005;
    flights.push({
      id: 'BG' + String(pick(p, 'positionId') ?? i + 1).slice(-6).toUpperCase(),
      symbol, side, leverage, margin: (qty * entry) / leverage, qty, entry,
      stopUnknown: true, liqPrice: side === 'long' ? entry * (1 - k) : entry * (1 + k),
      openedAt, horizonH: Math.max(1, Math.ceil(((closedAt || openedAt) - openedAt) / 3_600_000)), origin: 'pilot', cls,
      usOpenAtEntry: cls === 'rwa' ? isUsOpen(openedAt) : null,
      closedAt: closedAt > openedAt ? closedAt : openedAt + 60_000, exit: exit > 0 ? exit : entry, pnl,
      fees: Math.abs(num(p.openFee) || 0) + Math.abs(num(p.closeFee) || 0), outcome: 'landed', venue: 'bitget-history',
    });
  });
  return { flights, skipped };
}
