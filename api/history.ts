// POST /api/history : a visitor's own Bitget history, for the Black Box.
// The key arrives in the request body, signs two read-only calls to Bitget and
// is then dropped. It is never written to storage or to a log.
import type { ServerResponse } from 'node:http';
import { fetchHistory } from '../src/core/bitget';
import { historyToFlights } from '../src/core/logbook';
import { Req, readJson, send } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  try {
    const b = await readJson<{ key?: string; secret?: string; passphrase?: string; demo?: boolean }>(req);
    if (!b.key || !b.secret || !b.passphrase) return send(res, 400, { error: 'missing_key', message: 'API key, secret and passphrase are all required.' });
    const raw = await fetchHistory({ key: String(b.key), secret: String(b.secret), passphrase: String(b.passphrase) }, Boolean(b.demo));
    const out = historyToFlights(raw.positions, raw.orders);
    send(res, 200, { flights: out.flights, skipped: out.skipped, leverageFromOrders: raw.orders.length > 0 });
  } catch (e) {
    // Bitget's own message is the useful one here (bad signature, missing permission, IP not allowed)
    send(res, 502, { error: 'bitget_refused', message: (e as Error).message });
  }
}
