import { useState } from 'react';
import { PiAirplaneTakeoffFill } from 'react-icons/pi';
import { hoursMinutes, sessionLabel } from '../core/calendar';
import { leverageCap } from '../core/tower';
import { Contact, Instrument } from '../core/types';
import { DAY, fmtPct, zulu } from '../core/util';
import { Card, Flap, PriceChart } from './bits';
import { DeckApi } from './store';

function weather(c: Contact, earningsIn: number | null): { word: string; tone: 'go' | 'amber' | 'stop' } {
  if (earningsIn !== null && earningsIn <= 3 * DAY) return { word: 'EARNINGS', tone: 'stop' };
  const z = Math.abs(c.zResid ?? c.z);
  if (z >= 2) return { word: 'TURBULENCE', tone: 'stop' };
  if (z >= 1) return { word: 'BUMPY', tone: 'amber' };
  return { word: 'CALM', tone: 'go' };
}

type Group = 'all' | 'stock' | 'index' | 'crypto';
const groupOf = (i: Instrument): Exclude<Group, 'all'> => (i.cls === 'crypto' ? 'crypto' : i.etf ? 'index' : 'stock');
const GROUPS: { id: Group; name: string }[] = [
  { id: 'all', name: 'All' }, { id: 'stock', name: 'Stock perps' }, { id: 'index', name: 'Index' }, { id: 'crypto', name: 'Crypto' },
];

export function Board({ api }: { api: DeckApi }) {
  const { contacts, market, deck, actions, now } = api;
  const session = sessionLabel(now);
  const [group, setGroup] = useState<Group>('all');
  const rows = group === 'all' ? contacts : contacts.filter((c) => groupOf(market.instruments[c.symbol]) === group);
  const count = (g: Group) => (g === 'all' ? contacts.length : contacts.filter((c) => groupOf(market.instruments[c.symbol]) === g).length);
  const sel = rows.find((c) => c.symbol === deck.selected) ?? rows[0] ?? contacts[0];
  const bench = market.instruments[market.instruments[sel.symbol].proxyOf ?? '']?.base;
  const inst = market.instruments[sel.symbol];
  const cs = (market.hourly[sel.symbol] ?? []).slice(-96);
  const earn = market.earnings?.[sel.symbol];
  const cap = leverageCap(deck.rules, inst, now);

  return (
    <div className="view">
      <header className="view-head">
        <h1>Departures</h1>
        <p>Stock perps trade all night; the shares trade six and a half hours a day. This board ranks each contract by how far it has moved while its home market was shut, and shows the leverage the Tower will clear right now.</p>
      </header>

      <section className="board" aria-label="Departures board">
        <header className="board-top">
          <span className="board-title"><PiAirplaneTakeoffFill aria-hidden="true" /> Departures</span>
          <Flap text={session.open ? 'NEW YORK OPEN' : session.phaseText.toUpperCase()} tone={session.open ? 'go' : 'amber'} />
          <span className="board-bell">{session.open ? 'closing bell' : 'opening bell'} in {hoursMinutes(session.until - now)}</span>
          <span className="board-clock">{zulu(now)}</span>
        </header>
        <div className="board-filter">
          <div className="seg seg-small" role="group" aria-label="Show">
            {GROUPS.filter((g) => g.id === 'all' || count(g.id) > 0).map((g) => (
              <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>{g.name} <i>{count(g.id)}</i></button>
            ))}
          </div>
          <span>{session.open ? 'Shares are trading; the perp has a market behind it.' : session.phase === 'pre-market' || session.phase === 'after-hours' ? 'Extended hours: thin share trading behind the perp.' : 'No share trading at all behind the perp right now.'}</span>
        </div>
        <div className="board-cols" aria-hidden="true">
          <span>Flight</span><span className="c-last">Last</span><span>Off-hours drift</span><span className="c-sig">Sigma</span>
          <span className="c-ex">Bitget max</span><span>Tower clears</span><span className="c-earn">Earnings</span><span>Conditions</span>
        </div>
        <ul>
          {rows.map((c, i) => {
            const ci = market.instruments[c.symbol];
            const e = market.earnings?.[c.symbol];
            const w = weather(c, e ? e.at - now : null);
            const z = Math.abs(c.zResid ?? c.z);
            return (
              <li key={c.symbol}>
                <button type="button" className={`board-row ${c.symbol === sel.symbol ? 'is-on' : ''}`} aria-pressed={c.symbol === sel.symbol} onClick={() => actions.select(c.symbol)}
                  aria-label={`${ci.base}: ${fmtPct(c.drift, 2)} drift, ${z.toFixed(1)} sigma, Tower clears ${leverageCap(deck.rules, ci, now)}x, ${w.word.toLowerCase()}`}>
                  <Flap text={ci.base} pad={4} tone="ivory" delay={i * 60} />
                  <span className="c-last num">{c.last.toFixed(ci.pricePlace)}</span>
                  <span className={`num ${c.drift >= 0 ? 'up' : 'down'}`}>{fmtPct(c.drift, 2)}</span>
                  <span className="c-sig num">{z.toFixed(1)}σ</span>
                  <span className="c-ex num dim">{ci.maxLever}x</span>
                  <Flap text={`${leverageCap(deck.rules, ci, now)}X`} pad={3} delay={i * 60 + 120} />
                  <span className="c-earn num dim">{e ? zulu(e.at).slice(0, 6) : ci.cls === 'crypto' || ci.etf ? 'none' : 'no date'}</span>
                  <Flap text={w.word} pad={10} tone={w.tone} delay={i * 60 + 200} />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="board-foot">Sigma compares the move with what is normal for that many shut hours, after removing what the benchmark explains: BTC for MSTR and COIN, the Nasdaq 100 (QQQ perp) for the other stocks. What is left is the contract's own move.</p>
      </section>

      <Card title={`${inst.base} ${inst.name}`} aside={sel.session === 'always' ? '24h market' : `${sel.session === 'open' ? 'New York open' : 'New York closed'}, ${hoursMinutes(now - sel.refTime)} since the bell`} className="card-glass">
        <p className="lead">{sel.note}</p>
        <PriceChart candles={cs} sessions={inst.cls === 'rwa'} place={inst.pricePlace} height={190} mark={sel.refTime} />
        <dl className="readouts">
          <div><dt>Bitget allows</dt><dd>{inst.maxLever}x</dd></div>
          <div><dt>Tower clears now</dt><dd className="amber">{cap}x</dd></div>
          <div><dt>Funding per 8h</dt><dd>{sel.funding === undefined ? 'n/a' : fmtPct(sel.funding, 4)}</dd></div>
          {inst.cls === 'rwa' && <div><dt>Hourly move, open vs shut</dt><dd>{fmtPct(sel.volOpen, 2, false)} vs {fmtPct(sel.volClosed, 2, false)}</dd></div>}
          {inst.cls === 'rwa' && !inst.etf && <div><dt>Next earnings</dt><dd>{earn ? `${zulu(earn.at)}${earn.announced ? '' : ' est.'}` : 'no date on file'}</dd></div>}
          {sel.beta !== undefined && <div><dt>Beta to {bench}</dt><dd>{sel.beta.toFixed(2)}</dd></div>}
          {sel.resid !== undefined && <div><dt>Move {bench} does not explain</dt><dd className={Math.abs(sel.zResid ?? 0) >= 1.5 ? 'amber' : ''}>{fmtPct(sel.resid, 2)}</dd></div>}
          {sel.basis !== undefined && <div><dt>Last vs index</dt><dd>{fmtPct(sel.basis, 2)}</dd></div>}
        </dl>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => actions.fileFor(sel.symbol, 'long')}>Plan a long on {inst.base}</button>
          <button type="button" className="btn" onClick={() => actions.fileFor(sel.symbol, 'short')}>Plan a short on {inst.base}</button>
        </div>
      </Card>
    </div>
  );
}
