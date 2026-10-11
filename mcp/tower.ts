// FLIGHTDECK Tower as an MCP server (stdio, JSON-RPC 2.0, no dependencies).
//
// Any MCP-capable agent (Claude Code, Cursor, Codex) files its trades here
// before it touches Bitget Agent Hub. The Tower answers CLEARED or REFUSED and
// chains the answer into a ledger on disk. A refused plan is never executed.
//
//   npm run build:mcp && node dist/mcp/tower.mjs
//
// Environment:
//   FLIGHTDECK_HOME     where the ledger, licence and logbook live (default ~/.flightdeck)
//   FLIGHTDECK_FEED     "recorded" to use the bundled Bitget snapshot instead of live data
//   FLIGHTDECK_EQUITY   account size the risk rules are judged against (default 10000)
//   FLIGHTDECK_EXECUTE  "1" to let a cleared plan be sent to Bitget (needs BITGET_* keys;
//                       demo trading unless BITGET_TRADING_MODE=live)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { credentialsFromEnv, loadLiveMarket, orderPayload, placeOrder, tradingMode } from '../src/core/bitget';
import { SIM_START, lastPrice, snapshot, viewAsOf } from '../src/core/market';
import { preflight } from '../src/core/preflight';
import { offerLine, reroute } from '../src/core/reroute';
import { scan } from '../src/core/radar';
import { CHARTER, appendEntry, describeRule, requestClearance, rulesHash, squawk, verifyLedger } from '../src/core/tower';
import { Flight, FlightPlan, LedgerEntry, MarketState, PreflightReport, Rule } from '../src/core/types';

const HOME = process.env.FLIGHTDECK_HOME || join(homedir(), '.flightdeck');
const EQUITY = Number(process.env.FLIGHTDECK_EQUITY) || 10_000;
mkdirSync(HOME, { recursive: true });

function readJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(HOME, name), 'utf8')) as T; } catch { return fallback; }
}
const writeJson = (name: string, data: unknown) => writeFileSync(join(HOME, name), JSON.stringify(data, null, 2));

/** Charter rules always apply. Learned rules come from the licence the app exports. */
function loadRules(): Rule[] {
  const licence = readJson<{ rules?: Rule[] }>('licence.json', {});
  const learned = (licence.rules ?? []).filter((r) => r.source === 'blackbox' && r.enabled);
  return [...CHARTER, ...learned];
}

let cache: { at: number; market: MarketState; now: number; feed: string } | null = null;
async function getMarket() {
  if (process.env.FLIGHTDECK_FEED === 'recorded') {
    return { market: viewAsOf(snapshot(), SIM_START), now: SIM_START, feed: 'recorded Bitget snapshot (07 Oct 2026 13:00 UTC)' };
  }
  if (cache && Date.now() - cache.at < 30_000) return cache;
  try {
    cache = { at: Date.now(), market: await loadLiveMarket(), now: Date.now(), feed: 'live Bitget public API' };
  } catch (e) {
    cache = { at: Date.now(), market: viewAsOf(snapshot(), SIM_START), now: SIM_START, feed: `recorded snapshot, because Bitget was unreachable: ${(e as Error).message}` };
  }
  return cache;
}

const reports = new Map<string, PreflightReport>();

interface PlanArgs { symbol: string; side: 'long' | 'short'; leverage: number; margin: number; stop?: number; target?: number; horizonH?: number; agentId?: string; thesis?: string }

function toPlan(a: PlanArgs, m: MarketState): FlightPlan {
  const symbol = String(a.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const full = m.instruments[symbol] ? symbol : symbol + 'USDT';
  if (!m.instruments[full]) throw new Error(`Unknown instrument "${a.symbol}". Available: ${Object.keys(m.instruments).join(', ')}`);
  if (a.side !== 'long' && a.side !== 'short') throw new Error('side must be "long" or "short"');
  if (!(a.leverage >= 1) || !(a.margin > 0)) throw new Error('leverage must be at least 1 and margin above 0');
  return {
    symbol: full, side: a.side, leverage: Number(a.leverage), margin: Number(a.margin),
    // the agent does not get to pick its own entry price: it is the market
    entry: lastPrice(m, full),
    stop: a.stop === undefined ? undefined : Number(a.stop), target: a.target === undefined ? undefined : Number(a.target),
    horizonH: Number(a.horizonH) || 24, origin: 'agent', agentId: String(a.agentId ?? 'unnamed-agent').slice(0, 40), thesis: a.thesis?.slice(0, 400),
  };
}

const planSchema = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'Bitget USDT-M contract, e.g. NVDAUSDT, TSLAUSDT, BTCUSDT' },
    side: { type: 'string', enum: ['long', 'short'] },
    leverage: { type: 'number', minimum: 1 },
    margin: { type: 'number', description: 'Isolated margin in USDT' },
    stop: { type: 'number', description: 'Stop-loss price' },
    target: { type: 'number', description: 'Take-profit price' },
    horizonH: { type: 'number', description: 'Intended holding time in hours (default 24)' },
    agentId: { type: 'string', description: 'A stable name for the agent filing the plan' },
    thesis: { type: 'string', description: 'Why the agent wants this trade, in a sentence' },
  },
  required: ['symbol', 'side', 'leverage', 'margin'],
};

const TOOLS = [
  { name: 'flightdeck_radar', description: 'Rank Bitget stock perps and crypto by how unusually far they have moved while their home market was shut. Read-only.', inputSchema: { type: 'object', properties: {} } },
  { name: 'flightdeck_preflight', description: 'Stress-test a leveraged trade plan before filing it: liquidation runway, gap shock, replay through past windows, stop integrity, payoff, costs and account risk. Returns GO, CAUTION or NO-GO and the largest size that survives. Must be run before flightdeck_clearance.', inputSchema: planSchema },
  { name: 'flightdeck_clearance', description: 'File a trade plan with the Tower. Returns CLEARED or REFUSED with the rule-by-rule reasons and a ledger receipt. Only a CLEARED plan may be executed on Bitget; never place an order the Tower refused, and never alter a cleared plan before executing it.', inputSchema: planSchema },
  { name: 'flightdeck_rules', description: 'List the Tower rules currently in force, including rules learned from the pilot\'s logbook.', inputSchema: { type: 'object', properties: {} } },
  { name: 'flightdeck_ledger', description: 'Verify the hash-chained ledger of every clearance and refusal and return the most recent entries.', inputSchema: { type: 'object', properties: {} } },
];

async function call(name: string, args: PlanArgs): Promise<unknown> {
  const { market, now, feed } = await getMarket();
  switch (name) {
    case 'flightdeck_radar':
      return { feed, contacts: scan(market, now).map((c) => ({ symbol: c.symbol, last: c.last, session: c.session, driftPct: +(c.drift * 100).toFixed(2), sigma: +(c.zResid ?? c.z).toFixed(2), fundingPer8h: c.funding, note: c.note })) };

    case 'flightdeck_preflight': {
      const plan = toPlan(args, market);
      const r = preflight(plan, market, now, EQUITY);
      reports.set(r.planHash, r);
      return {
        feed, planHash: r.planHash, verdict: r.verdict, plan,
        checks: r.checks.map((c) => ({ check: c.label, status: c.status, finding: c.headline })),
        survivableSize: r.verdict === 'NO-GO' ? r.guidance : undefined,
        liquidationPrice: +r.numbers.liqPrice.toFixed(4), replay: r.replay, monteCarlo: r.monteCarlo,
        next: r.verdict === 'NO-GO' ? 'Do not file this plan. Reduce it to the survivable size, or fix the blockers, and run preflight again.' : 'File the same plan with flightdeck_clearance.',
      };
    }

    case 'flightdeck_clearance': {
      const plan = toPlan(args, market);
      const rules = loadRules();
      const inst = market.instruments[plan.symbol];
      const logbook = readJson<Flight[]>('logbook.json', []);
      const r = preflight(plan, market, now, EQUITY);
      // a preflight only counts if the agent actually ran it on this exact plan
      const onFile = reports.get(r.planHash);
      const c = requestClearance(plan, rules, { now, equity: EQUITY, instrument: inst, preflight: onFile, logbook });
      const failed = c.findings.filter((f) => !f.ok);
      let ledger = readJson<LedgerEntry[]>('ledger.json', []);
      ledger = appendEntry(ledger, c.decision === 'CLEARED' ? 'clearance' : 'refusal',
        `${c.decision === 'CLEARED' ? 'Cleared' : 'Refused'} agent ${plan.agentId}: ${inst.base} ${plan.leverage}x ${plan.side}, ${plan.margin} USDT margin`,
        { planHash: c.planHash, rulesHash: c.rulesHash, decision: c.decision, failed: failed.map((f) => f.ruleId), agentId: plan.agentId, thesis: plan.thesis }, Date.now());
      writeJson('ledger.json', ledger);
      const receipt = ledger[ledger.length - 1];
      const out: Record<string, unknown> = {
        feed, decision: c.decision, squawk: squawk(c.planHash), plan,
        brokenRules: failed.map((f) => ({ rule: f.title, why: f.detail, learned: f.source === 'blackbox' })),
        amendment: c.amendment, receipt: { seq: receipt.seq, hash: receipt.hash, prev: receipt.prev },
      };
      if (c.decision !== 'CLEARED') {
        // A refusal ends with an offer: the largest version of the same trade the Tower would clear.
        const offer = reroute(plan, rules, market, now, EQUITY, logbook);
        if (offer.ok) {
          out.counterOffer = { plan: offer.plan, changes: offer.changes, preflightVerdict: offer.report.verdict };
          out.next = `Do not place this order. Tell the user it was refused and why. ${offerLine(offer, inst.base)} To take the offer, run flightdeck_preflight and then flightdeck_clearance on counterOffer.plan exactly as given.`;
        } else {
          out.next = `Do not place this order. Tell the user it was refused and why. ${offerLine(offer, inst.base)}`;
        }
        return out;
      }
      const payload = orderPayload(plan, inst);
      const creds = credentialsFromEnv();
      if (process.env.FLIGHTDECK_EXECUTE === '1' && creds) {
        const placed = await placeOrder(plan, inst, creds);
        out.execution = { ...placed, mode: tradingMode() };
        out.next = 'The order was placed by the Tower. Do not place it again.';
      } else {
        out.order = payload;
        out.next = 'Cleared. Place exactly this order with Bitget Agent Hub (set-leverage, then place-order), with no changes to size, leverage or stop.';
      }
      return out;
    }

    case 'flightdeck_rules': {
      const rules = loadRules();
      return { rulesHash: rulesHash(rules), equity: EQUITY, rules: rules.map((r) => ({ id: r.id, rule: describeRule(r), source: r.source, evidence: r.evidence })) };
    }

    case 'flightdeck_ledger': {
      const ledger = readJson<LedgerEntry[]>('ledger.json', []);
      const broken = verifyLedger(ledger);
      return { entries: ledger.length, intact: broken === 0, brokenAt: broken || undefined, recent: ledger.slice(-10).map((e) => ({ seq: e.seq, at: new Date(e.at).toISOString(), kind: e.kind, summary: e.summary, hash: e.hash })) };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---- JSON-RPC over stdio --------------------------------------------------------

const reply = (id: unknown, result: unknown): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); };
const fail = (id: unknown, code: number, message: string): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); };

// Requests are answered in the order they arrive.
let queue: Promise<void> = Promise.resolve();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: PlanArgs; protocolVersion?: string } };
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    if (msg.id === undefined) return; // notifications need no answer
    try {
      switch (msg.method) {
        case 'initialize':
          return reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flightdeck-tower', version: '0.1.0' } });
        case 'ping':
          return reply(msg.id, {});
        case 'tools/list':
          return reply(msg.id, { tools: TOOLS });
        case 'tools/call': {
          try {
            const result = await call(String(msg.params?.name), (msg.params?.arguments ?? {}) as PlanArgs);
            return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
          } catch (e) {
            return reply(msg.id, { content: [{ type: 'text', text: (e as Error).message }], isError: true });
          }
        }
        default:
          return fail(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      fail(msg.id, -32603, (e as Error).message);
    }
  });
});
