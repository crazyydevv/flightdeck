// /api/watch : one Night Watch round over every flight left in its care.
// Call it on a schedule (see .github/workflows/night-watch.yml). Each flight is
// stepped through the hourly bars that closed since the last round; Night Watch
// acts after each bar, and its actions are sent to Bitget when the flight was
// opened there. If CRON_SECRET is set the caller must send it as a bearer token.
import type { ServerResponse } from 'node:http';
import { closeOrder, credentialsFromEnv, loadLiveMarket } from '../src/core/bitget';
import { chat, llmConfigured } from '../src/core/llm';
import { assess, parseWatchReply, watchPrompt } from '../src/core/nightwatch';
import { storeFromEnv } from '../src/core/store';
import { tickFlight } from '../src/core/watchman';
import { Req, operatorOk, send } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  const store = storeFromEnv();
  if (!store) return send(res, 501, { error: 'no_storage' });
  const secret = process.env.CRON_SECRET;
  if (secret ? req.headers.authorization !== `Bearer ${secret}` : !operatorOk(req)) return send(res, 401, { error: 'unauthorised' });
  try {
    const watched = await store.watched();
    if (!watched.length) return send(res, 200, { checked: 0, acted: 0, landed: 0 });
    const market = await loadLiveMarket();
    const now = Date.now();
    const creds = credentialsFromEnv();
    const report: { deck: string; id: string; events: string[]; landed: boolean; orders: string[] }[] = [];

    for (const { deck, flight } of watched) {
      const inst = market.instruments[flight.symbol];
      if (!inst) continue;
      // The model may pick from the menu; the guard inside tickFlight decides whether it stands.
      let proposal;
      if (llmConfigured()) {
        try {
          const p = watchPrompt(flight, assess(flight, market.hourly[flight.symbol] ?? [], inst, now, market.earnings?.[flight.symbol]?.at), inst.base);
          proposal = parseWatchReply((await chat(p.system, p.user, 200)) ?? '') ?? undefined;
        } catch { /* no model answer: the built-in rules run */ }
      }
      const before = flight.open ?? 1;
      const out = tickFlight(flight, market, now, 0, proposal);
      const orders: string[] = [];
      if (creds && flight.venue?.startsWith('bitget')) {
        // only Night Watch's own actions need an order; stops and targets were preset on the exchange
        const closedByWatch = out.events.some((e) => e.action === 'land') ? before : before - (out.flight.open ?? 1);
        if (closedByWatch > 0) {
          try { orders.push((await closeOrder(flight.symbol, flight.side, flight.qty * closedByWatch, inst, creds)).orderId); }
          catch (e) { orders.push(`failed: ${(e as Error).message}`); }
        }
      }
      await store.flightPut(deck, out.flight);
      report.push({ deck, id: flight.id, events: out.events.map((e) => `${e.rule}: ${e.detail}`), landed: out.landed, orders });
    }
    send(res, 200, { checked: report.length, acted: report.filter((r) => r.events.length).length, landed: report.filter((r) => r.landed).length, report });
  } catch (e) {
    send(res, 502, { error: 'watch_failed', message: (e as Error).message });
  }
}
