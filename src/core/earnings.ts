// Earnings dates for the stock perps. A stock perp trades straight through its
// company's results; the shares do not, so the perp takes the whole move at
// once and a stop does not fill inside it.
//
// Dates recorded 08 Oct 2026. "announced" means the company published the date;
// the rest are calendar estimates and are labelled as such wherever shown.
// Live deployments can replace this table with the EARNINGS_JSON env variable:
//   {"TSLAUSDT":{"date":"2026-10-21","announced":true}}

import { nyTime } from './calendar';
import { EarningsDate } from './types';
import { HOUR } from './util';

const TABLE: Record<string, { date: string; announced: boolean }[]> = {
  TSLAUSDT: [{ date: '2026-10-21', announced: true }],
  AAPLUSDT: [{ date: '2026-11-02', announced: true }],
  MSFTUSDT: [{ date: '2026-10-27', announced: false }],
  NVDAUSDT: [{ date: '2026-11-17', announced: false }],
};

/** 16:05 New York time on the given date: results land just after the close. */
export function afterClose(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, 20, 5);
  // 20:05 UTC is 16:05 in summer; in winter New York is an hour further behind
  if (Math.floor(nyTime(t).minutes / 60) !== 16) t += HOUR;
  return t;
}

/** The next release at or after `now` for each symbol with a date on file. */
export function earningsCalendar(now: number, override?: string): Record<string, EarningsDate> {
  let table = TABLE;
  if (override) {
    try {
      const raw = JSON.parse(override) as Record<string, { date: string; announced?: boolean }>;
      table = { ...TABLE };
      for (const [sym, v] of Object.entries(raw)) if (/^\d{4}-\d{2}-\d{2}$/.test(v.date)) table[sym] = [{ date: v.date, announced: Boolean(v.announced) }];
    } catch { /* a bad override leaves the built-in table in place */ }
  }
  const out: Record<string, EarningsDate> = {};
  for (const [sym, rows] of Object.entries(table)) {
    const next = rows.map((r) => ({ at: afterClose(r.date), announced: r.announced })).filter((r) => r.at >= now).sort((a, b) => a.at - b.at)[0];
    if (next) out[sym] = next;
  }
  return out;
}
