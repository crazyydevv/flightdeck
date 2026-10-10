// GET  /api/ledger?deck=ID   the published ledger for a deck, verified on read
// POST /api/ledger           { deck, entries } appended only if they chain
import type { ServerResponse } from 'node:http';
import { storeFromEnv } from '../src/core/store';
import { verifyLedger } from '../src/core/tower';
import { LedgerEntry } from '../src/core/types';
import { mirror } from '../src/core/watchman';
import { Req, operatorOk, query, readJson, send, validDeck } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  const store = storeFromEnv();
  if (!store) return send(res, 501, { error: 'no_storage' });
  try {
    if (req.method === 'GET') {
      const deck = query(req).get('deck');
      if (!validDeck(deck)) return send(res, 400, { error: 'bad_deck' });
      const entries = await store.ledgerList(deck, 500);
      // a window that does not start at entry 1 is checked from its own first link
      const whole = entries.length > 0 && entries[0].seq === 1;
      return send(res, 200, { deck, entries, brokenAt: whole ? verifyLedger(entries) : null });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!operatorOk(req)) return send(res, 401, { error: 'operator_key_required' });
    const { deck, entries } = await readJson<{ deck: string; entries: LedgerEntry[] }>(req);
    if (!validDeck(deck) || !Array.isArray(entries) || entries.length > 200) return send(res, 400, { error: 'bad_request' });
    const out = await mirror(store, deck, entries);
    send(res, out.ok ? 200 : 409, out);
  } catch (e) {
    send(res, 502, { error: 'storage_failed', message: (e as Error).message });
  }
}
