// One state object for the whole deck, a set of transitions, and a hook that
// persists the durable part to the browser and talks to the server routes when
// they exist. The browser is the system of record; the server mirrors the
// ledger for public verification and minds flights while the tab is closed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adopt, autopsy, counterfactual, covered } from '../core/blackbox';
import { Brief, ruleBriefs } from '../core/crew';
import { land, shadowOf, takeoff, unwatchedOf } from '../core/flight';
import { importCsv, sampleLogbook } from '../core/logbook';
import { SIM_START, SNAPSHOT_END, lastPrice, snapshot, viewAsOf } from '../core/market';
import { parseThesis } from '../core/parse';
import { planHash, preflight } from '../core/preflight';
import { offerLine, reroute } from '../core/reroute';
import { scan } from '../core/radar';
import { CHARTER, appendEntry, requestClearance } from '../core/tower';
import { Clearance, Flight, FlightPlan, LedgerEntry, MarketState, Rule } from '../core/types';
import { HOUR, sum } from '../core/util';
import { tickFlight } from '../core/watchman';
import { ScenarioId, scenarioById } from './scenarios';

export type Tab = 'gate' | 'board' | 'preflight' | 'tower' | 'flights' | 'watch' | 'blackbox' | 'ledger';

export interface Filed { clearance: Clearance; plan: FlightPlan; seq: number; /** what the Tower would clear instead, for a refused agent order */ offer?: string }
export interface Byok { key: string; secret: string; passphrase: string; demo: boolean }
export interface ServerInfo { trading: string; crew: boolean; model: string | null; storage: string | null; locked: boolean }

export interface Deck {
  id: string;
  feed: 'recorded' | 'live';
  simNow: number;
  tab: Tab;
  plan: FlightPlan;
  filed?: Filed;
  /** the plan before Preflight or the Tower had it amended */
  firstFiled?: FlightPlan;
  rules: Rule[];
  ledger: LedgerEntry[];
  logbook: Flight[];
  airborne: Flight[];
  startEquity: number;
  selected: string;
  /** new flights take off with Night Watch on */
  watchOn: boolean;
  /** the recording is being flown hour by hour */
  flying: boolean;
  guide: { open: boolean; auto: boolean; agentTried: boolean; /** where autoplay hands the controls back */ stopAt?: 'cleared' | 'landed' };
  /** the incident scenario being played, if any */
  scenario?: ScenarioId;
  /** ledger entries already published to the server mirror */
  mirrored: number;
  notice?: string;
}

const START_EQUITY = 10_000;
const KEY = 'flightdeck.v2';
const KEY_BYOK = 'flightdeck.byok';

const newId = () => Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

function defaultPlan(m: MarketState, symbol = 'NVDAUSDT'): FlightPlan {
  const entry = lastPrice(m, symbol);
  const place = m.instruments[symbol]?.pricePlace ?? 2;
  return {
    symbol, side: 'long', leverage: 20, margin: 400, entry,
    stop: Number((entry * 0.975).toFixed(place)), target: Number((entry * 1.06).toFixed(place)),
    horizonH: 72, origin: 'pilot',
  };
}

function fresh(): Deck {
  const m = viewAsOf(snapshot(), SIM_START);
  return {
    id: newId(), feed: 'recorded', simNow: SIM_START, tab: 'gate', plan: defaultPlan(m),
    rules: CHARTER, ledger: [], logbook: sampleLogbook(START_EQUITY), airborne: [],
    startEquity: START_EQUITY, selected: 'NVDAUSDT', watchOn: true, flying: false,
    guide: { open: true, auto: false, agentTried: false }, mirrored: 0,
  };
}

function load(): Deck {
  const base = fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Deck>;
    if (!Array.isArray(saved.rules) || !Array.isArray(saved.logbook) || typeof saved.id !== 'string') return base;
    return { ...base, ...saved, feed: 'recorded', flying: false, notice: undefined, filed: undefined, scenario: undefined, guide: { ...base.guide, ...saved.guide, auto: false, stopAt: undefined } };
  } catch {
    return base;
  }
}

function save(d: Deck): void {
  try {
    const { id, simNow, tab, plan, rules, ledger, logbook, airborne, startEquity, selected, watchOn, guide, mirrored } = d;
    localStorage.setItem(KEY, JSON.stringify({ id, simNow, tab, plan, rules, ledger, logbook, airborne, startEquity, selected, watchOn, guide, mirrored }));
  } catch {
    // storage is a convenience; the deck works without it
  }
}

function loadByok(): Byok | null {
  try { const raw = localStorage.getItem(KEY_BYOK); return raw ? (JSON.parse(raw) as Byok) : null; } catch { return null; }
}

export const equityOf = (d: Deck) => d.startEquity + sum(d.logbook.map((f) => f.pnl ?? 0));
export const ownFlights = (d: Deck) => d.logbook.filter((f) => f.venue !== 'sample' && f.venue !== 'import' && f.venue !== 'bitget-history');

const describePlan = (p: FlightPlan, base: string) => `${base} ${p.leverage}x ${p.side}, ${p.margin} USDT margin`;

/** Step every airborne flight through the bars that closed in (from, to], Night Watch included. */
function settle(d: Deck, m: MarketState, to: number): Deck {
  let { airborne, logbook, ledger } = d;
  for (const f of d.airborne) {
    const inst = m.instruments[f.symbol];
    if (!inst) continue;
    const balance = d.startEquity + sum(logbook.map((x) => x.pnl ?? 0));
    const out = tickFlight(f, m, to, balance);
    for (const e of out.events) {
      ledger = appendEntry(ledger, 'watch', `Night Watch on ${f.id}: ${e.action.replace(/-/g, ' ')} (${e.rule})`, { id: f.id, action: e.action, rule: e.rule, detail: e.detail, price: e.price, by: e.by }, e.at);
    }
    if (out.landed) {
      const bars = m.hourly[f.symbol] ?? [];
      const done = { ...out.flight, shadow: shadowOf(out.flight, bars, inst), unwatched: unwatchedOf(out.flight, bars, inst) };
      airborne = airborne.filter((x) => x.id !== f.id);
      logbook = [...logbook, done];
      ledger = appendEntry(ledger, 'landing', `${done.id} ${inst.base} ${done.outcome}, ${(done.pnl as number).toFixed(2)} USDT`,
        { id: done.id, outcome: done.outcome, exit: done.exit, pnl: done.pnl }, done.closedAt as number);
    } else {
      airborne = airborne.map((x) => (x.id === f.id ? out.flight : x));
    }
  }
  return { ...d, airborne, logbook, ledger };
}

/** File a canned order from a misbehaving agent and record the Tower's answer. */
function fileRogue(d: Deck, m: MarketState, now: number): Deck {
  const symbol = m.instruments.MSTRUSDT ? 'MSTRUSDT' : Object.keys(m.instruments)[0];
  const target = m.instruments[symbol];
  const equity = equityOf(d);
  const rogue: FlightPlan = {
    symbol, side: 'long', leverage: Math.min(25, target.maxLever), margin: 2000, entry: lastPrice(m, symbol),
    horizonH: 72, origin: 'agent', agentId: 'momentum-bot-7', thesis: 'BTC looks strong, max size on the proxy.',
  };
  const c = requestClearance(rogue, d.rules, { now, equity, instrument: target, logbook: d.logbook });
  const failed = c.findings.filter((f) => !f.ok);
  const offer = reroute(rogue, d.rules, m, now, equity, d.logbook);
  const line = offer.ok
    ? `Counter-offer sent back to the agent: ${target.base} ${offer.plan.leverage}x on ${offer.plan.margin} USDT with a stop at ${(offer.plan.stop as number).toFixed(target.pricePlace)}. It has to run preflight and refile that exact plan.`
    : offerLine(offer, target.base);
  const ledger = appendEntry(d.ledger, 'refusal', `Refused agent momentum-bot-7: ${describePlan(rogue, target.base)} (${failed.map((f) => f.ruleId).join(', ')})`,
    { plan: rogue, planHash: c.planHash, rulesHash: c.rulesHash, decision: c.decision, failed: failed.map((f) => f.title), feed: d.feed, counterOffer: offer.ok ? offer.plan : null }, now);
  return { ...d, tab: 'tower', filed: { clearance: c, plan: rogue, seq: ledger.length, offer: line }, ledger, guide: { ...d.guide, agentTried: true } };
}

export function useDeck() {
  const [deck, setDeck] = useState<Deck>(load);
  const [live, setLive] = useState<MarketState | null>(null);
  const [wall, setWall] = useState(() => Date.now());
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [modelBriefs, setModelBriefs] = useState<{ hash: string; briefs: Brief[]; model: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [byok, setByokState] = useState<Byok | null>(loadByok);
  const [crewAsking, setCrewAsking] = useState(false);
  const crewCache = useRef(new Map<string, { briefs: Brief[]; model: string }>());
  const deckRef = useRef(deck);
  deckRef.current = deck;

  useEffect(() => save(deck), [deck]);

  const pull = useCallback(async (): Promise<MarketState | null> => {
    try {
      const r = await fetch('api/market', { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const m = (await r.json()) as MarketState;
      return m && m.source === 'live' && m.hourly ? m : null;
    } catch {
      return null;
    }
  }, []);

  // Look for a server once. A static preview has none and stays on the recording.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const s = await fetch('api/status', { signal: AbortSignal.timeout(8000) });
        if (!s.ok || dead) return;
        const info = (await s.json()) as ServerInfo;
        if (typeof info?.trading !== 'string') return;
        setServer(info);
      } catch { return; }
      const m = await pull();
      if (!dead && m) setLive(m);
    })();
    return () => { dead = true; };
  }, [pull]);

  const isLive = deck.feed === 'live' && live !== null;
  const now = isLive ? wall : deck.simNow;
  const market = useMemo(() => (isLive ? (live as MarketState) : viewAsOf(snapshot(), deck.simNow)), [isLive, live, deck.simNow]);
  const equity = equityOf(deck);
  const inst = market.instruments[deck.plan.symbol] ?? Object.values(market.instruments)[0];
  const plan = market.instruments[deck.plan.symbol] ? deck.plan : defaultPlan(market, inst.symbol);

  const contacts = useMemo(() => scan(market, now), [market, now]);
  const report = useMemo(() => preflight(plan, market, now, equity), [plan, market, now, equity]);
  // What the Tower would clear instead of the plan on the desk, if anything.
  const route = useMemo(() => reroute(plan, deck.rules, market, now, equity, deck.logbook), [plan, deck.rules, market, now, equity, deck.logbook]);
  const briefs = useMemo(
    () => (modelBriefs && modelBriefs.hash === report.planHash ? modelBriefs.briefs : ruleBriefs(report, inst.base)),
    [modelBriefs, report, inst.base],
  );
  const post = useMemo(() => autopsy(deck.logbook, now), [deck.logbook, now]);
  const whatIf = useMemo(() => counterfactual(deck.logbook, deck.rules, market.instruments, deck.startEquity), [deck.logbook, deck.rules, market.instruments, deck.startEquity]);
  const openLeaks = useMemo(() => {
    const have = new Set(deck.rules.map((r) => r.id));
    return post.leaks.filter((l) => l.proposal && !have.has(l.proposal.id) && !covered(deck.rules, l.proposal));
  }, [post, deck.rules]);

  const patch = (p: Partial<Deck>) => setDeck((d) => ({ ...d, ...p }));
  const headers = () => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    try { const k = localStorage.getItem('flightdeck.operator'); if (k) h['x-operator-key'] = k; } catch { /* none */ }
    return h;
  };
  const pushFlight = (f: Flight) => {
    if (!server?.storage || deckRef.current.feed !== 'live') return;
    void fetch('api/flights', { method: 'POST', headers: headers(), body: JSON.stringify({ deck: deckRef.current.id, flight: f }) }).catch(() => undefined);
  };

  // Live feed: refresh the market every minute, settle flights, and pick up
  // whatever Night Watch did on the server while this tab was closed.
  useEffect(() => {
    if (deck.feed !== 'live') return;
    const round = async () => {
      setWall(Date.now());
      const m = await pull();
      if (!m) return;
      setLive(m);
      let remote: Flight[] = [];
      if (server?.storage) {
        try {
          const r = await fetch(`api/flights?deck=${deckRef.current.id}`);
          if (r.ok) remote = ((await r.json()) as { flights: Flight[] }).flights ?? [];
        } catch { /* the local deck carries on */ }
      }
      setDeck((d) => {
        // a server copy that has been checked more often than ours is the newer one
        const merged = d.airborne.map((f) => {
          const s = remote.find((x) => x.id === f.id);
          return s && (s.watchChecks ?? 0) > (f.watchChecks ?? 0) && s.closedAt === undefined ? { ...s, cursor: Math.max(s.cursor ?? 0, f.cursor ?? 0) } : f;
        });
        return settle({ ...d, airborne: merged }, m, Date.now());
      });
    };
    const id = setInterval(round, 60_000);
    return () => clearInterval(id);
  }, [deck.feed, pull, server?.storage]);

  // Publish new ledger entries to the server mirror, in order.
  useEffect(() => {
    if (!server?.storage || deck.ledger.length <= deck.mirrored) return;
    let dead = false;
    const entries = deck.ledger.slice(deck.mirrored, deck.mirrored + 100);
    (async () => {
      try {
        const r = await fetch('api/ledger', { method: 'POST', headers: headers(), body: JSON.stringify({ deck: deck.id, entries }) });
        const out = await r.json();
        if (dead) return;
        if (r.ok && out.ok) setDeck((d) => ({ ...d, mirrored: Math.max(d.mirrored, out.tail) }));
        else if (r.status === 401) setDeck((d) => ({ ...d, mirrored: d.ledger.length, notice: 'This server needs an operator key before it publishes a ledger. Decisions stay on this device.' }));
        else if (r.status === 409) setDeck((d) => ({ ...d, mirrored: d.ledger.length, notice: `The published ledger could not be extended: ${out.reason}` }));
      } catch { /* retried on the next change */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.storage, deck.ledger.length, deck.mirrored, deck.id]);

  // Time-lapse: one recorded hour per tick until every flight is down.
  const atEnd = !isLive && deck.simNow >= SNAPSHOT_END;
  useEffect(() => {
    if (!deck.flying) return;
    if (!deck.airborne.length || atEnd || isLive) { patch({ flying: false }); return; }
    const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const id = setTimeout(() => actions.advance(1), reduced ? 30 : 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.flying, deck.simNow, deck.airborne.length, atEnd, isLive]);

  // With a model configured, the crew argues every plan in its own words without
  // being asked: once the plan has been still for two seconds, and never while
  // the demo is playing itself. Each plan is asked about once.
  useEffect(() => {
    if (!server?.crew || deck.tab !== 'preflight' || deck.guide.auto) return;
    if (modelBriefs?.hash === report.planHash) return;
    const id = setTimeout(() => void actions.askCrew(true), 2000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.crew, deck.tab, deck.guide.auto, report.planHash, modelBriefs?.hash]);

  const actions = {
    go: (tab: Tab) => patch({ tab, notice: undefined }),
    dismiss: () => patch({ notice: undefined }),
    setGuide: (g: Partial<Deck['guide']>) => setDeck((d) => ({ ...d, guide: { ...d.guide, ...g } })),

    setFeed(feed: Deck['feed']) {
      if (feed === 'live' && !live) return patch({ notice: 'No live server answered. Deploy with the /api routes, or run npm run dev, to fly on live Bitget data.' });
      setWall(Date.now());
      setDeck((d) => {
        const m = feed === 'live' ? (live as MarketState) : viewAsOf(snapshot(), d.simNow);
        const symbol = m.instruments[d.plan.symbol] ? d.plan.symbol : Object.keys(m.instruments)[0];
        return { ...d, feed, flying: false, plan: { ...defaultPlan(m, symbol), side: d.plan.side }, filed: undefined, firstFiled: undefined, notice: undefined };
      });
    },

    select(symbol: string) { patch({ selected: symbol }); },

    /** Start a plan on an instrument at its current price. */
    fileFor(symbol: string, side: FlightPlan['side']) {
      const base = defaultPlan(market, symbol);
      const d = side === 'long' ? 1 : -1;
      const place = market.instruments[symbol].pricePlace;
      patch({
        plan: { ...base, side, leverage: plan.leverage, margin: plan.margin,
          stop: Number((base.entry * (1 - d * 0.025)).toFixed(place)), target: Number((base.entry * (1 + d * 0.06)).toFixed(place)) },
        tab: 'preflight', filed: undefined, firstFiled: undefined, notice: undefined, selected: symbol,
      });
    },

    setPlan(p: Partial<FlightPlan>) {
      setDeck((d) => {
        let next = { ...d.plan, ...p };
        if (p.symbol && p.symbol !== d.plan.symbol) next = { ...defaultPlan(market, p.symbol), side: d.plan.side, leverage: d.plan.leverage, margin: d.plan.margin, horizonH: d.plan.horizonH };
        if (p.side && p.side !== d.plan.side && !p.symbol) {
          // mirror the levels around the entry so they stay on the right side
          const mirror = (x?: number) => (x === undefined ? undefined : Number((2 * next.entry - x).toFixed(inst.pricePlace)));
          next.stop = mirror(d.plan.stop); next.target = mirror(d.plan.target);
        }
        const changed = Boolean((p.symbol && p.symbol !== d.plan.symbol) || (p.side && p.side !== d.plan.side));
        return { ...d, plan: next, filed: undefined, firstFiled: changed ? undefined : d.firstFiled };
      });
    },

    /** Read one typed line into the plan. Returns what was understood. */
    readThesis(text: string, andGo = false): string[] {
      const { plan: parsed, understood } = parseThesis(text, market, plan);
      const p = parsed.symbol !== plan.symbol
        ? (() => { const d = parsed.side === 'long' ? 1 : -1; const place = market.instruments[parsed.symbol].pricePlace;
            return { ...parsed, stop: parsed.stop ?? Number((parsed.entry * (1 - d * 0.025)).toFixed(place)), target: parsed.target ?? Number((parsed.entry * (1 + d * 0.06)).toFixed(place)) }; })()
        : parsed;
      setDeck((d) => ({ ...d, plan: p, filed: undefined, firstFiled: undefined, selected: p.symbol, tab: andGo ? 'preflight' : d.tab }));
      return understood;
    },

    /** Preflight to Tower: file the current plan and record the decision. */
    requestClearance() {
      setDeck((d) => {
        const c = requestClearance(plan, d.rules, { now, equity, instrument: inst, preflight: report, logbook: d.logbook });
        const failed = c.findings.filter((f) => !f.ok);
        const summary = c.decision === 'CLEARED'
          ? `Cleared: ${describePlan(plan, inst.base)}`
          : `Refused: ${describePlan(plan, inst.base)} (${failed.map((f) => f.ruleId).join(', ')})`;
        const ledger = appendEntry(d.ledger, c.decision === 'CLEARED' ? 'clearance' : 'refusal', summary,
          { plan, planHash: c.planHash, rulesHash: c.rulesHash, decision: c.decision, failed: failed.map((f) => f.title), feed: d.feed }, now);
        return { ...d, tab: 'tower', filed: { clearance: c, plan, seq: ledger.length }, notice: undefined, ledger };
      });
    },

    /** A canned order from a misbehaving agent, to show the gate holding. */
    rogueAgent() { setDeck((d) => fileRogue(d, market, now)); },

    /**
     * Turn a refusal into a clearance: take the largest version of the trade
     * that passes preflight and every Tower rule, put it on the desk and file it.
     */
    reroute(from?: FlightPlan) {
      setDeck((d) => {
        const src = from ?? plan;
        const target = market.instruments[src.symbol];
        const r = reroute(src, d.rules, market, now, equity, d.logbook);
        if (!r.ok) return { ...d, plan: src, filed: undefined, tab: 'preflight', notice: offerLine(r, target.base) };
        const ledger = appendEntry(d.ledger, 'clearance',
          `Cleared${r.changes.length ? ' after re-route' : ''}: ${describePlan(r.plan, target.base)}${r.changes.length ? ` (${r.changes.join(', ')})` : ''}`,
          { plan: r.plan, planHash: r.clearance.planHash, rulesHash: r.clearance.rulesHash, decision: 'CLEARED', failed: [], feed: d.feed, reroutedFrom: r.changes.length ? planHash(src) : undefined, changes: r.changes }, now);
        const sameTrade = d.firstFiled && d.firstFiled.symbol === src.symbol && d.firstFiled.side === src.side;
        return {
          ...d, plan: r.plan, selected: src.symbol, firstFiled: sameTrade ? d.firstFiled : r.changes.length ? src : undefined,
          filed: { clearance: r.clearance, plan: r.plan, seq: ledger.length }, tab: 'tower', ledger, notice: undefined,
        };
      });
    },

    /** Load an incident on a clean deck at the start of the recording and let the guide fly it. */
    scenario(id: ScenarioId) {
      const sc = scenarioById(id);
      if (!sc) return;
      if (deckRef.current.airborne.some((f) => f.venue?.startsWith('bitget'))) {
        return patch({ notice: 'A flight is open on Bitget from this deck. Land it before loading a scenario, because a scenario starts from a clean deck.' });
      }
      setModelBriefs(null);
      const base = fresh();
      const m = viewAsOf(snapshot(), base.simNow);
      const guide = { open: true, auto: true, agentTried: false, stopAt: sc.stopAt };
      if (!sc.plan) return setDeck({ ...fileRogue({ ...base, scenario: id }, m, base.simNow), guide: { ...guide, auto: false, agentTried: true } });
      const p = sc.plan(m);
      setDeck({ ...base, scenario: id, plan: p, selected: p.symbol, tab: 'preflight', guide });
    },

    endScenario() { setDeck((d) => ({ ...d, scenario: undefined, guide: { ...d.guide, auto: false, stopAt: undefined } })); },

    async takeOff() {
      const filed = deck.filed;
      if (!filed || filed.clearance.decision !== 'CLEARED' || filed.clearance.planHash !== planHash(plan)) {
        return patch({ notice: 'That clearance does not match the plan on the desk. Request clearance again.' });
      }
      let venue = 'paper';
      if (isLive) {
        setBusy('Contacting Bitget');
        try {
          const r = await fetch('api/order', {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ plan, learnedRules: deck.rules.filter((x) => x.source === 'blackbox'), logbook: deck.logbook.slice(-200), equity, byok: byok && byok.demo ? byok : undefined }),
          });
          const out = await r.json();
          if (!r.ok) { setBusy(null); return patch({ notice: out.message || 'The server could not place the order.' }); }
          if (out.clearance?.decision !== 'CLEARED') {
            setBusy(null);
            return patch({ filed: { clearance: out.clearance, plan, seq: filed.seq }, notice: 'The server Tower refused this plan on its own check.' });
          }
          venue = out.execution?.orderId ? `${out.execution.venue}:${out.execution.orderId}` : 'paper';
        } catch {
          venue = 'paper';
        }
        setBusy(null);
      }
      const first = deck.firstFiled;
      const amended = first && first.symbol === plan.symbol && first.side === plan.side && (first.leverage !== plan.leverage || first.margin !== plan.margin);
      const f: Flight = {
        ...takeoff(plan, inst, now, venue), watch: deck.watchOn, cursor: now,
        filed: amended ? { leverage: first.leverage, margin: first.margin, stop: first.stop, target: first.target } : undefined,
      };
      pushFlight(f);
      setDeck((d) => ({
        ...d, airborne: [...d.airborne, f], filed: undefined, firstFiled: undefined, tab: 'flights', notice: undefined,
        ledger: appendEntry(d.ledger, 'takeoff', `${f.id} airborne: ${describePlan(plan, inst.base)} at ${plan.entry}`,
          { id: f.id, planHash: planHash(plan), entry: f.entry, qty: f.qty, liq: f.liqPrice, venue, watch: f.watch }, now),
      }));
    },

    /** Recorded feed only: move the simulator clock forward and settle flights. */
    advance(hours: number) {
      setDeck((d) => {
        if (d.feed !== 'recorded') return d;
        const to = Math.min(SNAPSHOT_END, d.simNow + hours * HOUR);
        if (to === d.simNow) return { ...d, flying: false, notice: 'End of the recording. Land open flights, or reset the deck to fly it again.' };
        const settled = settle(d, { ...snapshot(), earnings: viewAsOf(snapshot(), d.simNow).earnings }, to);
        const m = viewAsOf(snapshot(), to);
        const symbol = settled.plan.symbol;
        // Move the plan with the market, keeping the pilot's stop and target the
        // same distance away, so a new preflight is judged at today's price.
        const entry = lastPrice(m, symbol);
        const k = entry / settled.plan.entry;
        const place = m.instruments[symbol].pricePlace;
        const shift = (x?: number) => (x === undefined ? undefined : Number((x * k).toFixed(place)));
        return { ...settled, simNow: to, flying: settled.airborne.length ? d.flying : false, plan: { ...settled.plan, entry, stop: shift(settled.plan.stop), target: shift(settled.plan.target) }, filed: undefined };
      });
    },

    fly(on: boolean) { patch({ flying: on, tab: on ? 'flights' : deck.tab }); },

    landNow(id: string) {
      setDeck((d) => {
        const f = d.airborne.find((x) => x.id === id);
        if (!f) return d;
        const fi = market.instruments[f.symbol];
        const hit = land(f, lastPrice(market, f.symbol), now, 'landed', fi, equityOf(d));
        const bars = market.hourly[f.symbol] ?? [];
        const done = { ...hit, shadow: shadowOf(hit, bars, fi), unwatched: unwatchedOf(hit, bars, fi) };
        pushFlight(done);
        return {
          ...d, airborne: d.airborne.filter((x) => x.id !== id), logbook: [...d.logbook, done],
          ledger: appendEntry(d.ledger, 'landing', `${done.id} ${fi.base} landed by the pilot, ${(done.pnl as number).toFixed(2)} USDT`,
            { id: done.id, outcome: done.outcome, exit: done.exit, pnl: done.pnl }, now),
        };
      });
    },

    toggleWatch(id?: string) {
      setDeck((d) => {
        if (!id) return { ...d, watchOn: !d.watchOn };
        const airborne = d.airborne.map((f) => (f.id === id ? { ...f, watch: !f.watch } : f));
        const f = airborne.find((x) => x.id === id);
        if (f) pushFlight(f);
        return { ...d, airborne };
      });
    },

    adoptRules(proposals: Rule[]) {
      setDeck((d) => {
        let ledger = d.ledger;
        const before = new Set(d.rules.map((r) => r.id));
        const rules = adopt(d.rules, proposals);
        for (const p of rules) if (!before.has(p.id)) ledger = appendEntry(ledger, 'rule', `Rule written from the logbook: ${p.title}`, { id: p.id, kind: p.kind, params: p.params, evidence: p.evidence }, now);
        return { ...d, rules, ledger, filed: undefined };
      });
    },

    removeRule(id: string) {
      setDeck((d) => {
        const r = d.rules.find((x) => x.id === id);
        if (!r || r.source !== 'blackbox') return d;
        return { ...d, rules: d.rules.filter((x) => x.id !== id), filed: undefined,
          ledger: appendEntry(d.ledger, 'rule', `Rule removed by the pilot: ${r.title}`, { id, removed: true }, now) };
      });
    },

    importLogbook(text: string): string {
      const res = importCsv(text);
      if (res.error) return res.error;
      if (!res.flights.length) return 'No usable rows found.';
      setDeck((d) => ({ ...d, logbook: [...ownFlights(d), ...res.flights] }));
      return `Imported ${res.flights.length} flights${res.skipped ? `, skipped ${res.skipped} rows` : ''}. The sample logbook was replaced.`;
    },

    clearSample() { setDeck((d) => ({ ...d, logbook: d.logbook.filter((f) => f.venue !== 'sample') })); },

    setByok(k: Byok | null, remember: boolean) {
      setByokState(k);
      try { if (k && remember) localStorage.setItem(KEY_BYOK, JSON.stringify(k)); else localStorage.removeItem(KEY_BYOK); } catch { /* memory only */ }
    },

    /** Pull the pilot's own closed positions from Bitget with their key. */
    async pullHistory(k: Byok): Promise<string> {
      setBusy('Reading your Bitget history');
      try {
        const r = await fetch('api/history', { method: 'POST', headers: headers(), body: JSON.stringify(k) });
        const out = await r.json();
        setBusy(null);
        if (!r.ok) return `Bitget did not accept that key: ${out.message ?? out.error}`;
        if (!out.flights?.length) return 'The key works, but there are no closed futures positions in the last 90 days.';
        setDeck((d) => ({ ...d, logbook: [...ownFlights(d), ...(out.flights as Flight[])], tab: 'blackbox' }));
        return `Read ${out.flights.length} closed positions from your account${out.leverageFromOrders ? '' : ' (leverage could not be read, so it shows as 1x)'}. The autopsy below is now yours.`;
      } catch {
        setBusy(null);
        return 'There is no server behind this page to sign the request. Run the app with its /api routes to use your key.';
      }
    },

    async askCrew(quiet = false) {
      const hash = report.planHash;
      const held = crewCache.current.get(hash);
      if (held) return setModelBriefs({ hash, ...held });
      if (!quiet) setBusy('Asking the crew');
      setCrewAsking(true);
      try {
        const r = await fetch('api/crew', { method: 'POST', headers: headers(), body: JSON.stringify({ report, base: inst.base }) });
        const out = await r.json();
        if (r.ok && out.briefs) {
          crewCache.current.set(hash, { briefs: out.briefs, model: out.model });
          setModelBriefs({ hash, briefs: out.briefs, model: out.model });
        } else if (!quiet) patch({ notice: 'The crew model did not answer. The briefs below are written from the preflight numbers.' });
      } catch {
        if (!quiet) patch({ notice: 'The crew model did not answer. The briefs below are written from the preflight numbers.' });
      }
      setCrewAsking(false);
      if (!quiet) setBusy(null);
    },

    reset() {
      try { localStorage.removeItem(KEY); } catch { /* fine */ }
      setModelBriefs(null);
      setDeck({ ...fresh(), tab: 'board' });
    },
  };

  return {
    deck, plan, market, now, equity, inst, contacts, report, route, briefs, post, whatIf, openLeaks, actions, busy, server, byok, crewAsking,
    isLive, liveAvailable: live !== null, crewModel: modelBriefs && modelBriefs.hash === report.planHash ? modelBriefs.model : null, atEnd,
  };
}

export type DeckApi = ReturnType<typeof useDeck>;
