export interface Candle {
  /** candle open time, ms since epoch (UTC) */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type AssetClass = 'rwa' | 'crypto';
export type Side = 'long' | 'short';

export interface Instrument {
  symbol: string;
  base: string;
  name: string;
  cls: AssetClass;
  /** exchange maximum leverage, from Bitget contract config */
  maxLever: number;
  takerFee: number;
  /** maintenance margin rate of the first position tier */
  mmr: number;
  pricePlace: number;
  sizePlace: number;
  /** the benchmark this contract mostly tracks: BTC for MSTR and COIN, the Nasdaq 100 (QQQ) for the other stock perps */
  proxyOf?: string;
  /** an index fund: it has no earnings date of its own */
  etf?: boolean;
}

export interface MarketState {
  source: 'live' | 'recorded';
  /** the newest moment the data covers */
  asOf: number;
  instruments: Record<string, Instrument>;
  hourly: Record<string, Candle[]>;
  daily: Record<string, Candle[]>;
  /** current funding rate per 8h, where known */
  funding: Record<string, number>;
  /** (last - index) / index, where known */
  basis: Record<string, number>;
  /** next earnings release per stock perp, where a date is on file */
  earnings?: Record<string, EarningsDate>;
}

export interface EarningsDate {
  /** release time, ms since epoch (results come out after the New York close) */
  at: number;
  /** true when the company announced the date, false when it is a calendar estimate */
  announced: boolean;
}

export interface FlightPlan {
  symbol: string;
  side: Side;
  leverage: number;
  /** isolated margin committed, USDT */
  margin: number;
  entry: number;
  stop?: number;
  target?: number;
  /** how long the pilot intends to hold, hours */
  horizonH: number;
  thesis?: string;
  origin: 'pilot' | 'agent';
  agentId?: string;
}

export type CheckStatus = 'pass' | 'caution' | 'fail';

export interface Check {
  id: 'runway' | 'gap' | 'earnings' | 'replay' | 'stop' | 'payoff' | 'drag' | 'exposure';
  label: string;
  status: CheckStatus;
  /** one line the pilot can act on */
  headline: string;
  detail: string;
  /** the single number shown on the annunciator */
  readout: string;
}

export interface ReplayStats {
  basis: 'hourly' | 'daily';
  windows: number;
  target: number;
  stopped: number;
  liquidated: number;
  timeout: number;
  meanPnl: number;
  worstPnl: number;
  bestPnl: number;
}

export interface Guidance {
  /** true when shrinking the position clears every failed check */
  fixable: boolean;
  leverage: number;
  margin: number;
  /** checks that no position size can fix (missing stop, bad payoff) */
  blockers: string[];
}

export interface PreflightReport {
  planHash: string;
  at: number;
  plan: FlightPlan;
  verdict: 'GO' | 'CAUTION' | 'NO-GO';
  checks: Check[];
  numbers: {
    notional: number;
    qty: number;
    liqPrice: number;
    liqDist: number;
    sigmaDay: number;
    sigmaHorizon: number;
    shock: number;
    shockSource: string;
    lossAtStop: number;
    lossAtShock: number;
    reward: number;
    fees: number;
    funding: number;
    rr: number;
    riskPct: number;
    usOpen: boolean | null;
    opensCrossed: number;
    /** earnings release inside the hold, if any */
    earningsAt: number | null;
  };
  replay: ReplayStats;
  monteCarlo: { paths: number; liquidated: number; stopped: number; target: number; timeout: number };
  guidance: Guidance;
}

export type RuleKind =
  | 'max_leverage'
  | 'offhours_leverage'
  | 'max_risk_pct'
  | 'stop_required'
  | 'preflight_required'
  | 'cooldown_after_loss'
  | 'no_size_up_after_loss'
  | 'max_flights_per_day'
  | 'daily_loss_stop'
  | 'agent_leverage_cap';

export interface Rule {
  id: string;
  kind: RuleKind;
  title: string;
  params: Record<string, number | string>;
  /** charter rules ship with the Tower; blackbox rules were learned from the logbook */
  source: 'charter' | 'blackbox';
  enabled: boolean;
  evidence?: string;
  addedAt?: number;
}

export interface Finding {
  ruleId: string;
  title: string;
  source: Rule['source'];
  ok: boolean;
  detail: string;
}

export interface Clearance {
  decision: 'CLEARED' | 'REFUSED';
  at: number;
  planHash: string;
  rulesHash: string;
  findings: Finding[];
  /** a smaller plan that would clear, when the refusal is only about size */
  amendment?: { leverage?: number; margin?: number };
}

export interface LedgerEntry {
  seq: number;
  at: number;
  kind: 'clearance' | 'refusal' | 'takeoff' | 'landing' | 'rule' | 'watch';
  summary: string;
  body: unknown;
  prev: string;
  hash: string;
}

export type Outcome = 'target' | 'stopped' | 'liquidated' | 'landed' | 'timeout';

export interface Flight {
  id: string;
  symbol: string;
  side: Side;
  leverage: number;
  margin: number;
  qty: number;
  entry: number;
  stop?: number;
  target?: number;
  liqPrice: number;
  openedAt: number;
  horizonH: number;
  origin: 'pilot' | 'agent';
  cls: AssetClass;
  usOpenAtEntry: boolean | null;
  /** set once the flight has landed */
  closedAt?: number;
  exit?: number;
  pnl?: number;
  fees?: number;
  outcome?: Outcome;
  balanceAfter?: number;
  /** where the fill happened: paper book, or a Bitget demo order id */
  venue?: string;
  /** imported history that does not say whether a stop was set */
  stopUnknown?: boolean;
  /** fraction of the position still open (Night Watch may cut it); 1 when absent */
  open?: number;
  /** result already banked by partial closes, USDT */
  realised?: number;
  /** the stop as cleared, before Night Watch moved it */
  stop0?: number;
  /** Night Watch is minding this flight */
  watch?: boolean;
  watchChecks?: number;
  watchLog?: WatchEvent[];
  /** end time of the last hourly bar this flight was stepped through */
  cursor?: number;
  /** the plan as the pilot first filed it, when Preflight or the Tower had it amended */
  filed?: { leverage: number; margin: number; stop?: number; target?: number };
  /** what the first-filed plan would have done over the same hours */
  shadow?: { leverage: number; pnl: number; outcome: Outcome };
  /** the same flight over the same hours with Night Watch off, kept when Night Watch acted */
  unwatched?: { pnl: number; outcome: Outcome };
}

export interface WatchEvent {
  at: number;
  action: 'stop-to-entry' | 'trail-stop' | 'cut-half' | 'land';
  rule: string;
  detail: string;
  price: number;
  by: 'rules' | 'model';
}

export interface Leak {
  id: 'revenge' | 'sizeup' | 'offhours' | 'overtrading' | 'stopless' | 'leverage';
  title: string;
  count: number;
  /** summed result of the flagged flights, USDT (negative means it cost money) */
  cost: number;
  evidence: string[];
  summary: string;
  proposal?: Rule;
}

export interface Autopsy {
  flights: number;
  net: number;
  winRate: number;
  leaks: Leak[];
}

export interface Contact {
  symbol: string;
  cls: AssetClass;
  last: number;
  session: 'open' | 'closed' | 'always';
  refTime: number;
  hoursSinceRef: number;
  /** move since the reference time */
  drift: number;
  /** drift in units of what is normal for that many hours */
  z: number;
  volOpen: number;
  volClosed: number;
  funding?: number;
  basis?: number;
  /** for proxies: the part of the move the tracked crypto asset does not explain */
  resid?: number;
  zResid?: number;
  beta?: number;
  score: number;
  note: string;
}
