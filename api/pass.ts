// GET /api/pass?deck=ID&seq=N : one published decision, re-verified against its
// neighbour in the chain. This is what a shared boarding-pass link opens.
import type { ServerResponse } from 'node:http';
import { storeFromEnv } from '../src/core/store';
import { proof } from '../src/core/watchman';
import { Req, query, send, validDeck } from './_http';

export default async function handler(req: Req, res: ServerResponse) {
  const store = storeFromEnv();
  if (!store) return send(res, 501, { error: 'no_storage' });
  const q = query(req);
  const deck = q.get('deck'), seq = Number(q.get('seq'));
  if (!validDeck(deck) || !Number.isInteger(seq) || seq < 1) return send(res, 400, { error: 'bad_request' });
  try {
    const p = await proof(store, deck, seq);
    if (!p) return send(res, 404, { error: 'not_found' });
    send(res, 200, p, 'public, s-maxage=60');
  } catch (e) {
    send(res, 502, { error: 'storage_failed', message: (e as Error).message });
  }
}
