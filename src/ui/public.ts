import { LIVE_EXTRA, snapshot } from '../core/market';
import { Instrument } from '../core/types';

/**
 * FLIGHTDECK's own deck. Every visitor sees it read-only on the Ledger page,
 * straight from the server mirror, so nobody has to take a posted trade on trust.
 * The page only reads it. Visitors' own decks stay private to their browsers.
 */
export const PUBLIC_DECK = 'xxkc6trqkq';

/**
 * Terms for drawing a pass. Recorded symbols use their real terms; a live-only
 * symbol (GOOGL, META...) gets display terms, which is all a pass needs.
 */
export function instFor(symbol: string, live?: Record<string, Instrument>): Instrument {
  const known = live?.[symbol] ?? snapshot().instruments[symbol];
  if (known) return known;
  const extra = LIVE_EXTRA[symbol];
  const base = extra?.base ?? symbol.replace(/USDT$/, '');
  return { symbol, base, name: extra?.name ?? base, cls: extra?.cls ?? 'rwa', maxLever: 0, takerFee: 0, mmr: 0, pricePlace: 2, sizePlace: 2 };
}

/**
 * The recording ends here. Anything opened or written after it happened on the
 * Live feed: recorded trades live inside the recording's own clock.
 */
export const RECORDING_END = snapshot().asOf;
export const isLiveTime = (t: number): boolean => t > RECORDING_END;
