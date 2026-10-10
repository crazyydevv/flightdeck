// Incident scenarios: one click loads a situation on the recorded Bitget candles
// and lets the guide fly it. Nothing here is simulated price action; every
// scenario starts at the same recorded moment (07 Oct 2026, 13:00 UTC, half an
// hour before the New York bell) and uses the hours that actually followed.

import { lastPrice } from '../core/market';
import { FlightPlan, MarketState } from '../core/types';

export type ScenarioId = 'overnight' | 'watch' | 'earnings' | 'agent';

export interface Scenario {
  id: ScenarioId;
  kicker: string;
  title: string;
  blurb: string;
  /** what to look for while it plays */
  watchFor: string;
  /** where autoplay hands the controls back; undefined plays the whole loop */
  stopAt?: 'cleared' | 'landed';
  plan?: (m: MarketState) => FlightPlan;
}

function draft(m: MarketState, symbol: string, side: FlightPlan['side'], leverage: number, margin: number, horizonH: number): FlightPlan {
  const entry = lastPrice(m, symbol);
  const d = side === 'long' ? 1 : -1;
  const place = m.instruments[symbol].pricePlace;
  return {
    symbol, side, leverage, margin, entry, horizonH, origin: 'pilot',
    stop: Number((entry * (1 - d * 0.025)).toFixed(place)), target: Number((entry * (1 + d * 0.06)).toFixed(place)),
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'overnight', kicker: 'The whole loop',
    title: 'NVDA at 20x before the bell',
    blurb: 'A pilot files NVIDIA 20x long with New York still shut. Refused, re-routed, flown through the recorded hours, then the Black Box writes new rules.',
    watchFor: 'The refusal turns into a cleared 5x flight in one click, and the landing shows what the first size would have cost.',
    plan: (m) => draft(m, 'NVDAUSDT', 'long', 20, 400, 72),
  },
  {
    id: 'watch', kicker: 'Night Watch',
    title: 'BTC turns while you sleep',
    blurb: 'A 50x BTC long is re-routed to a size that survives. Then the market falls hour after hour and Night Watch cuts half before the stop goes.',
    watchFor: 'Night Watch acts on its own in the flight log, and the landing compares the result with the watch off.',
    stopAt: 'landed',
    plan: (m) => draft(m, 'BTCUSDT', 'long', 50, 400, 72),
  },
  {
    id: 'earnings', kicker: 'Earnings',
    title: 'TSLA held through its results',
    blurb: 'Three weeks long at 20x crosses Tesla\'s 21 October earnings call. Preflight flags the date; the Tower offers the size that lives through it.',
    watchFor: 'At 20x the Earnings check fails: results land with New York closed, so the stop cannot fill inside the move. At the re-routed size the trade lives through it.',
    stopAt: 'cleared',
    plan: (m) => draft(m, 'TSLAUSDT', 'long', 20, 400, 504),
  },
  {
    id: 'agent', kicker: 'Agent firewall',
    title: 'A bot asks for 25x with no stop',
    blurb: 'An AI agent files MSTR 25x, 2,000 USDT, no stop. The Tower refuses it rule by rule and sends back the version it would clear.',
    watchFor: 'Six charter rules broken, a hashed refusal in the ledger, and a counter-offer the agent can refile.',
  },
];

export const scenarioById = (id?: string) => SCENARIOS.find((s) => s.id === id);
