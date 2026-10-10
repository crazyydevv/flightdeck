// The server's two duties, written against the Store interface so they can be
// tested without a network: mirroring a deck's ledger, and running Night Watch
// on flights whose pilot is asleep.

import { stepFlight } from './flight';
import { Proposal, watchTick } from './nightwatch';
import { Store } from './store';
import { GENESIS } from './tower';
import { Flight, LedgerEntry, MarketState, WatchEvent } from './types';
import { canonical, HOUR, sha256 } from './util';

const hashEntry = (prev: string, e: LedgerEntry) => sha256(prev + canonical({ seq: e.seq, at: e.at, kind: e.kind, summary: e.summary, body: e.body }));

export type MirrorResult = { ok: true; added: number; tail: number } | { ok: false; reason: string; tail: number };

/**
 * Append entries to a deck's public ledger. The server recomputes every hash
 * and accepts an entry only as the direct successor of the one it already
 * holds, so the mirror can be extended but never rewritten.
 */
export async function mirror(store: Store, deck: string, entries: LedgerEntry[]): Promise<MirrorResult> {
  let tail = await store.ledgerTail(deck);
  let added = 0;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const tailSeq = tail?.seq ?? 0;
    if (e.seq <= tailSeq) {
      const held = e.seq === tailSeq ? tail : await store.ledgerGet(deck, e.seq);
      // same hash is not enough: the resent content must still produce that hash
      if (!held || held.hash !== e.hash || hashEntry(e.prev, e) !== e.hash) return { ok: false, reason: `Entry ${e.seq} differs from the one already published. A published ledger cannot be rewritten.`, tail: tailSeq };
      continue;
    }
    const prev = tail?.hash ?? GENESIS;
    if (e.seq !== tailSeq + 1) return { ok: false, reason: `Expected entry ${tailSeq + 1}, got ${e.seq}.`, tail: tailSeq };
    if (e.prev !== prev || hashEntry(prev, e) !== e.hash) return { ok: false, reason: `Entry ${e.seq} does not chain from entry ${tailSeq}.`, tail: tailSeq };
    await store.ledgerAppend(deck, e);
    tail = e;
    added++;
  }
  return { ok: true, added, tail: tail?.seq ?? 0 };
}

/** One published entry, re-verified against its neighbour at read time. */
export async function proof(store: Store, deck: string, seq: number) {
  const entry = await store.ledgerGet(deck, seq);
  if (!entry) return null;
  const before = seq > 1 ? await store.ledgerGet(deck, seq - 1) : null;
  const prev = seq > 1 ? before?.hash : GENESIS;
  const tail = await store.ledgerTail(deck);
  return { entry, intact: prev !== undefined && entry.prev === prev && hashEntry(entry.prev, entry) === entry.hash, of: tail?.seq ?? seq };
}

export interface Watched { flight: Flight; events: WatchEvent[]; landed: boolean }

/**
 * Bring one flight up to date: step it through every hourly bar that has closed
 * since it was last looked at, and let Night Watch act after each one.
 * `model` supplies an optional proposal for the newest bar only.
 */
export function tickFlight(f: Flight, m: MarketState, now: number, balance: number, model?: Proposal): Watched {
  const inst = m.instruments[f.symbol];
  const bars = m.hourly[f.symbol] ?? [];
  const from = f.cursor ?? f.openedAt;
  const fresh = bars.filter((c) => c.t >= from && c.t >= f.openedAt && c.t + HOUR <= now);
  const events: WatchEvent[] = [];
  let flight = f;
  for (let i = 0; i < fresh.length; i++) {
    const bar = fresh[i];
    const hit = stepFlight(flight, bar, inst, balance);
    if (hit) return { flight: { ...hit, cursor: bar.t + HOUR }, events, landed: true };
    flight = { ...flight, cursor: bar.t + HOUR };
    if (!flight.watch) continue;
    const t = watchTick(flight, bars, inst, bar.t + HOUR, balance, m.earnings?.[f.symbol]?.at, i === fresh.length - 1 ? model : undefined);
    if (t.event) events.push(t.event);
    flight = t.flight;
    if (t.landed) return { flight, events, landed: true };
  }
  return { flight, events, landed: false };
}
