// GET /api/market : live Bitget market state for the whole board, one call.
import type { ServerResponse } from 'node:http';
import { loadLiveMarket } from '../src/core/bitget';
import { Req, send } from './_http';

export default async function handler(_req: Req, res: ServerResponse) {
  try {
    send(res, 200, await loadLiveMarket(), 'public, s-maxage=30, stale-while-revalidate=60');
  } catch (e) {
    send(res, 502, { error: 'bitget_unreachable', message: (e as Error).message });
  }
}
