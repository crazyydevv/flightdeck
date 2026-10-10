// Server-side storage. Two jobs: a public mirror of each deck's ledger, so a
// clearance can be verified by anyone with the link, and the list of flights
// Night Watch is minding while the pilot's browser is closed.
//
// Backed by Cloudflare D1 over its REST API (the same three env variables
// Lunaris uses), or by memory for local runs. Tables are prefixed fd_ so the
// database can be shared with another app.

import { Flight, LedgerEntry } from './types';

export interface Store {
  kind: 'd1' | 'memory';
  ledgerTail(deck: string): Promise<LedgerEntry | null>;
  ledgerGet(deck: string, seq: number): Promise<LedgerEntry | null>;
  ledgerList(deck: string, limit: number): Promise<LedgerEntry[]>;
  ledgerAppend(deck: string, e: LedgerEntry): Promise<void>;
  flightPut(deck: string, f: Flight): Promise<void>;
  flightsOf(deck: string): Promise<Flight[]>;
  /** every airborne flight with Night Watch on, across decks */
  watched(): Promise<{ deck: string; flight: Flight }[]>;
}

export class MemoryStore implements Store {
  kind = 'memory' as const;
  private ledger = new Map<string, LedgerEntry[]>();
  private flights = new Map<string, Map<string, Flight>>();
  async ledgerTail(deck: string) { const l = this.ledger.get(deck) ?? []; return l[l.length - 1] ?? null; }
  async ledgerGet(deck: string, seq: number) { return (this.ledger.get(deck) ?? []).find((e) => e.seq === seq) ?? null; }
  async ledgerList(deck: string, limit: number) { return (this.ledger.get(deck) ?? []).slice(-limit); }
  async ledgerAppend(deck: string, e: LedgerEntry) { this.ledger.set(deck, [...(this.ledger.get(deck) ?? []), e]); }
  async flightPut(deck: string, f: Flight) { if (!this.flights.has(deck)) this.flights.set(deck, new Map()); this.flights.get(deck)!.set(f.id, f); }
  async flightsOf(deck: string) { return [...(this.flights.get(deck)?.values() ?? [])]; }
  async watched() {
    const out: { deck: string; flight: Flight }[] = [];
    for (const [deck, m] of this.flights) for (const flight of m.values()) if (flight.closedAt === undefined && flight.watch) out.push({ deck, flight });
    return out;
  }
}

interface D1Config { accountId: string; databaseId: string; token: string; base?: string }

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS fd_ledger (deck TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (deck, seq))',
  'CREATE TABLE IF NOT EXISTS fd_flights (deck TEXT NOT NULL, id TEXT NOT NULL, airborne INTEGER NOT NULL, watch INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (deck, id))',
];

type LedgerRow = { seq: number; at: number; kind: string; summary: string; body: string; prev: string; hash: string };
const toEntry = (r: LedgerRow): LedgerEntry => ({ seq: r.seq, at: r.at, kind: r.kind as LedgerEntry['kind'], summary: r.summary, body: JSON.parse(r.body), prev: r.prev, hash: r.hash });

export class D1Store implements Store {
  kind = 'd1' as const;
  private ready: Promise<void> | null = null;
  constructor(private cfg: D1Config) {}

  private async raw<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const url = `${this.cfg.base ?? 'https://api.cloudflare.com'}/client/v4/accounts/${this.cfg.accountId}/d1/database/${this.cfg.databaseId}/query`;
    const res = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json()) as { success: boolean; errors?: unknown; result?: { results?: T[] }[] };
    if (!res.ok || !json.success) throw new Error(`D1 ${res.status}: ${JSON.stringify(json.errors ?? '')}`);
    return json.result?.[0]?.results ?? [];
  }

  private async q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.ready ??= (async () => { for (const s of SCHEMA) await this.raw(s); })();
    await this.ready;
    return this.raw<T>(sql, params);
  }

  async ledgerTail(deck: string) { const r = await this.q<LedgerRow>('SELECT * FROM fd_ledger WHERE deck = ? ORDER BY seq DESC LIMIT 1', [deck]); return r[0] ? toEntry(r[0]) : null; }
  async ledgerGet(deck: string, seq: number) { const r = await this.q<LedgerRow>('SELECT * FROM fd_ledger WHERE deck = ? AND seq = ?', [deck, seq]); return r[0] ? toEntry(r[0]) : null; }
  async ledgerList(deck: string, limit: number) { const r = await this.q<LedgerRow>('SELECT * FROM fd_ledger WHERE deck = ? ORDER BY seq DESC LIMIT ?', [deck, limit]); return r.map(toEntry).reverse(); }
  async ledgerAppend(deck: string, e: LedgerEntry) {
    // the primary key makes a second writer for the same sequence number fail
    await this.q('INSERT INTO fd_ledger (deck, seq, at, kind, summary, body, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [deck, e.seq, e.at, e.kind, e.summary, JSON.stringify(e.body ?? null), e.prev, e.hash]);
  }
  async flightPut(deck: string, f: Flight) {
    await this.q('INSERT INTO fd_flights (deck, id, airborne, watch, data, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (deck, id) DO UPDATE SET airborne = excluded.airborne, watch = excluded.watch, data = excluded.data, updated = excluded.updated',
      [deck, f.id, f.closedAt === undefined ? 1 : 0, f.watch ? 1 : 0, JSON.stringify(f), Date.now()]);
  }
  async flightsOf(deck: string) { const r = await this.q<{ data: string }>('SELECT data FROM fd_flights WHERE deck = ? ORDER BY updated DESC LIMIT 50', [deck]); return r.map((x) => JSON.parse(x.data) as Flight); }
  async watched() { const r = await this.q<{ deck: string; data: string }>('SELECT deck, data FROM fd_flights WHERE airborne = 1 AND watch = 1 LIMIT 100'); return r.map((x) => ({ deck: x.deck, flight: JSON.parse(x.data) as Flight })); }
}

/** D1 when its three variables are set, memory when asked for, otherwise none. */
export function storeFromEnv(): Store | null {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_D1_DATABASE_ID: databaseId, CLOUDFLARE_API_TOKEN: token } = process.env;
  const g = globalThis as { __fdStore?: Store };
  if (g.__fdStore) return g.__fdStore;
  if (accountId && databaseId && token) return (g.__fdStore = new D1Store({ accountId, databaseId, token, base: process.env.CLOUDFLARE_API_BASE }));
  if (process.env.FLIGHTDECK_STORE === 'memory') return (g.__fdStore = new MemoryStore());
  return null;
}
