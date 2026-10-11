// THE FORWARD TEST, part 2: fly the plans on hours that did not exist when the
// study was written, with the engines exactly as they were, and keep score.
//
//   tsx research/forward.ts
//
// Writes research/FORWARD.md and the `forward` key of research/headline.json. The frozen study
// (research/RESULTS.md) is never touched by this.

import fs from 'node:fs';
import path from 'node:path';
import { INSTRUMENTS, snapshot } from '../src/core/market';
import { DAY, HOUR } from '../src/core/util';
import { forwardCandles, mean, readForward, shortfall, studyMarket } from './lib';
import { SCENARIOS, Trade, runSymbol } from './run';

const pct = (x: number, dp = 1) => (Number.isFinite(x) ? (x * 100).toFixed(dp) + '%' : 'n/a');
const usd = (x: number) => (Number.isFinite(x) ? (x < 0 ? '-' : '') + Math.abs(x).toFixed(2) : 'n/a');
const int = (x: number) => x.toLocaleString('en-US');
const share = <T>(xs: T[], f: (x: T) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface ForwardRow { label: string; plans: number; entryHours: number; liq50: number; forecast50: number; liqAsFiled: number; liqRerouted: number; meanAsFiled: number; meanRerouted: number; es5AsFiled: number; es5Rerouted: number }

function row(label: string, g: Trade[]): ForwardRow {
  const g50 = g.filter((t) => t.lev === 50), A = g.map((t) => t.a[0]), B = g.map((t) => (t.b ? t.b[0] : 0));
  return {
    label, plans: g.length, entryHours: new Set(g.map((t) => t.t)).size,
    liq50: share(g50, (t) => t.a[1] === 'liquidated'), forecast50: mean(g50.map((t) => t.mcLiq)),
    liqAsFiled: share(g, (t) => t.a[1] === 'liquidated'), liqRerouted: share(g, (t) => t.b?.[1] === 'liquidated'),
    meanAsFiled: mean(A), meanRerouted: mean(B), es5AsFiled: shortfall(A), es5Rerouted: shortfall(B),
  };
}

/** Fly the Day test on every entry hour whose flight ends after the study was frozen. */
export function forwardTrades(file?: string, symbols: string[] = Object.keys(INSTRUMENTS)): { trades: Trade[]; hours: number; through: number } {
  const store = readForward(file);
  const extra = forwardCandles(store);
  const hours = extra.NVDAUSDT?.length ?? 0;
  const frozen = snapshot().hourly.NVDAUSDT.length + 800; // bars per contract in the frozen study
  const full = studyMarket(extra);
  const sc = SCENARIOS.day;
  // the frozen study's last entry was bar frozen - 24; everything after it has an outcome the study never saw
  const from = frozen - sc.horizonH + 1;
  const trades = hours ? symbols.flatMap((s) => runSymbol(sc, s, full, false, from)) : [];
  return { trades, hours, through: store.start + hours * HOUR };
}

export function render(trades: Trade[], hours: number, through: number): { md: string; rows: ForwardRow[] } {
  const head = `# Forward test

The study in docs/STUDY.md was frozen on candles up to 8 October 2026 19:00 UTC. This file is what
happened next: the same plans, judged by the same engines with no threshold changed, on hours
that did not exist when the study was written. A scheduled job
(\`.github/workflows/forward-test.yml\`) pulls the new Bitget candles every week, reruns this and
commits the result. Nothing here is tuned on what it finds; it only keeps score.

Plans are the study's Day test: the app's default stop and target (2.5% and 6%), 400 USDT of
margin, long and short, 10x, 20x and 50x, held at most 24 hours, entered at every hour.
`;
  if (!trades.length) return { md: `${head}\n**No forward results yet.** ${hours ? `${hours} new hours are on file; a full day is needed before the first plans can land.` : 'The first run of the scheduled job will add them.'}\n`, rows: [] };
  const weeks = new Map<string, Trade[]>();
  for (const t of trades) { const monday = t.t - ((new Date(t.t).getUTCDay() + 6) % 7) * DAY; const k = day(monday); if (!weeks.has(k)) weeks.set(k, []); weeks.get(k)!.push(t); }
  const rows = [row('All forward hours', trades), ...[...weeks.entries()].sort().map(([k, g]) => row(`Week of ${k}`, g))];
  const table = [
    '| Period | Entry hours | Plans | 50x liquidated as filed | Preflight forecast for 50x | Liquidated as filed, all | Liquidated re-routed | Mean as filed | Mean re-routed | Worst 5% as filed | Worst 5% re-routed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((r) => `| ${r.label} | ${int(r.entryHours)} | ${int(r.plans)} | ${pct(r.liq50)} | ${pct(r.forecast50)} | ${pct(r.liqAsFiled)} | ${pct(r.liqRerouted)} | ${usd(r.meanAsFiled)} | ${usd(r.meanRerouted)} | ${usd(r.es5AsFiled)} | ${usd(r.es5Rerouted)} |`),
  ].join('\n');
  const first = Math.min(...trades.map((t) => t.t)), last = Math.max(...trades.map((t) => t.t));
  const md = `${head}
Candles on file through ${new Date(through).toISOString().slice(0, 16).replace('T', ' ')} UTC. Entries from ${new Date(first).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(last).toISOString().slice(0, 16).replace('T', ' ')} UTC.

${table}

For comparison, the frozen study's Day test: 50x liquidated 24.2% as filed against a forecast of
25.3%; 5.8% of all plans liquidated as filed and none re-routed; mean -18.35 as filed and -3.60
re-routed.

A week is a small sample: one bad or quiet week will move these figures a long way. The row to
watch is the first one, as it grows.
`;
  return { md, rows };
}

if (process.argv[1] && /forward\.[cm]?[tj]s$/.test(process.argv[1])) {
  const { trades, hours, through } = forwardTrades();
  const { md, rows } = render(trades, hours, through);
  const dir = path.dirname(process.argv[1]);
  fs.writeFileSync(path.join(dir, 'FORWARD.md'), md);
  // The app's landing page shows the running total beside the frozen study's figures.
  // It lives under its own key in headline.json; nothing else in that file is touched.
  const headline = path.join(dir, 'headline.json');
  if (fs.existsSync(headline)) {
    const h = JSON.parse(fs.readFileSync(headline, 'utf8'));
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const all = rows[0];
    h.forward = all
      ? { through, entryHours: all.entryHours, plans: all.plans, liquidated50: r3(all.liq50), forecast50: r3(all.forecast50), liquidatedAsFiled: r3(all.liqAsFiled), liquidatedRerouted: r3(all.liqRerouted) }
      : { through, entryHours: 0, plans: 0, liquidated50: 0, forecast50: 0, liquidatedAsFiled: 0, liquidatedRerouted: 0 };
    fs.writeFileSync(headline, JSON.stringify(h, null, 1) + '\n');
  }
  console.log(md);
}
