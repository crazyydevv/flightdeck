// POST /api/order : the only door to the exchange. The server re-runs
// Preflight and the Tower on live Bitget data; nothing the browser claims
// about its own clearance is trusted. Without API keys this is a dry run that
// returns the exact order it would have sent.
import type { ServerResponse } from 'node:http';
import { Credentials, credentialsFromEnv, loadLiveMarket, orderPayload, placeOrder, tradingMode } from '../src/core/bitget';
import { lastPrice } from '../src/core/market';
import { preflight } from '../src/core/preflight';
import { CHARTER, requestClearance } from '../src/core/tower';
import { Flight, FlightPlan, Rule } from '../src/core/types';
import { Req, readJson, send } from './_http';

interface Body { plan: FlightPlan; learnedRules?: Rule[]; logbook?: Flight[]; equity?: number; byok?: Credentials }

export default async function handler(req: Req, res: ServerResponse) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  try {
    const body = await readJson<Body>(req);
    const plan = body.plan;
    const market = await loadLiveMarket();
    const inst = market.instruments[plan?.symbol];
    if (!inst) return send(res, 400, { error: 'unknown_symbol' });

    const live = lastPrice(market, plan.symbol);
    if (!(plan.entry > 0) || Math.abs(plan.entry / live - 1) > 0.01) {
      return send(res, 409, { error: 'stale_price', message: `Plan entry ${plan.entry} is more than 1% from the live price ${live}. Refresh and run preflight again.` });
    }

    const now = Date.now();
    const equity = Math.max(1, Number(body.equity) || 10_000);
    const report = preflight(plan, market, now, equity);
    // The charter always applies. A client can add learned rules, never remove these.
    const learned = (body.learnedRules ?? []).filter((r) => r.source === 'blackbox' && r.enabled);
    const rules = [...CHARTER, ...learned];
    const clearance = requestClearance(plan, rules, { now, equity, instrument: inst, preflight: report, logbook: body.logbook ?? [] });

    if (clearance.decision !== 'CLEARED') return send(res, 200, { clearance, report, execution: null });

    // A visitor's own key is used for this one request and never stored. It may
    // only place demo orders; real-money trading needs the operator's own env keys.
    const b = body.byok;
    const own = b && b.key && b.secret && b.passphrase ? { key: String(b.key), secret: String(b.secret), passphrase: String(b.passphrase) } : null;
    const creds = own ?? credentialsFromEnv();
    if (!creds) {
      return send(res, 200, { clearance, report, execution: { venue: 'paper', dryRun: orderPayload(plan, inst), note: 'No Bitget API key, so nothing was sent.' } });
    }
    const placed = await placeOrder(plan, inst, creds, own ? true : tradingMode() === 'demo');
    send(res, 200, { clearance, report, execution: { ...placed, mode: own ? 'demo' : tradingMode() } });
  } catch (e) {
    send(res, 502, { error: 'order_failed', message: (e as Error).message });
  }
}
