// GET  /api/flights?deck=ID   flights the server holds for a deck
// POST /api/flights           { deck, flight } hand a flight to Night Watch, or update it
import type { ServerResponse } from 'node:http';
import { storeFromEnv } from '../src/core/store';
import { Flight } from '../src/core/types';
import { Req, operatorOk, query, readJson, send, validDeck } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  const store = storeFromEnv();
  if (!store) return send(res, 501, { error: 'no_storage' });
  try {
    if (req.method === 'GET') {
      const deck = query(req).get('deck');
      if (!validDeck(deck)) return send(res, 400, { error: 'bad_deck' });
      return send(res, 200, { flights: await store.flightsOf(deck) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!operatorOk(req)) return send(res, 401, { error: 'operator_key_required' });
    const { deck, flight } = await readJson<{ deck: string; flight: Flight }>(req);
    if (!validDeck(deck) || !flight || !/^[A-Z0-9]{4,12}$/.test(String(flight.id)) || !(flight.entry > 0)) return send(res, 400, { error: 'bad_request' });
    await store.flightPut(deck, flight);
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, 502, { error: 'storage_failed', message: (e as Error).message });
  }
}
