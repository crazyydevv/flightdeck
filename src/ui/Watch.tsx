import { PiMoonStarsFill } from 'react-icons/pi';
import { debrief, WATCH_RULES } from '../core/nightwatch';
import { zulu } from '../core/util';
import { Card } from './bits';
import { DeckApi, ownFlights } from './store';

export function Watch({ api }: { api: DeckApi }) {
  const { deck, market, actions, server, isLive } = api;
  const events = deck.ledger.filter((e) => e.kind === 'watch').reverse();
  const minded = deck.airborne.filter((f) => f.watch);
  const past = ownFlights(deck).filter((f) => (f.watchChecks ?? 0) > 0).slice(-4).reverse();

  return (
    <div className="view">
      <header className="view-head">
        <h1>Night Watch</h1>
        <p>Stock perps move while you sleep. Night Watch checks every airborne flight after each hourly candle and acts for you, inside one hard limit: it can only reduce risk.</p>
      </header>

      <Card className="card-glass watch-hero">
        <div className={`moon ${deck.watchOn ? 'is-on' : ''}`} aria-hidden="true"><PiMoonStarsFill /></div>
        <div>
          <h2>{deck.watchOn ? 'New flights take off with Night Watch on.' : 'Night Watch is off for new flights.'}</h2>
          <p>
            {minded.length
              ? `Minding ${minded.length} flight${minded.length > 1 ? 's' : ''} now: ${minded.map((f) => f.id).join(', ')}.`
              : 'Nothing airborne to mind right now.'}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary" aria-pressed={deck.watchOn} onClick={() => actions.toggleWatch()}>{deck.watchOn ? 'Turn off for new flights' : 'Turn on for new flights'}</button>
            {!deck.airborne.length && <button type="button" className="btn" onClick={() => actions.go('preflight')}>Plan a flight</button>}
          </div>
        </div>
      </Card>

      <div className="cols cols-even">
        <Card title="What it may do" aside="in order of urgency">
          <ul className="watch-rules">
            {WATCH_RULES.map((r) => <li key={r.id}><b>{r.title}</b><p>{r.does}</p></li>)}
          </ul>
        </Card>
        <Card title="What it can never do">
          <ul className="never">
            <li><b>Add size.</b> Exposure only goes down.</li>
            <li><b>Widen a stop.</b> A stop only moves toward the price.</li>
            <li><b>Remove a stop.</b></li>
          </ul>
          <p>
            A model can be put in charge of choosing among the allowed actions. Its answer passes through the same guard as the built-in rules,
            so a wrong answer can cost opportunity but cannot add exposure. A test flies 300 random flights against random proposals and checks the limit after every one.
          </p>
          <p className="fine">
            {server?.storage
              ? `This deployment can keep watch with the tab closed: flights are stored in ${server.storage === 'd1' ? 'Cloudflare D1' : 'server memory'} and checked by a scheduled round${isLive ? '' : ' when the feed is Live'}.`
              : 'On this page Night Watch runs while the tab is open. Deployed with storage and a schedule, it keeps watch with the tab closed.'}
          </p>
        </Card>
      </div>

      <Card title="Watch log" aside={`${events.length} actions`}>
        {minded.map((f) => <p key={f.id} className="lead">{debrief(f, market.instruments[f.symbol]?.base ?? f.symbol)}</p>)}
        {past.map((f) => <p key={f.id} className="fine">{debrief(f, market.instruments[f.symbol]?.base ?? f.symbol)}</p>)}
        {events.length ? (
          <ul className="watch-log">
            {events.map((e) => {
              const b = e.body as { detail?: string; by?: string };
              return <li key={e.seq}><span className="num">{zulu(e.at)}</span><div><b>{e.summary}</b><p>{b.detail}</p></div><span className="tag">{b.by === 'model' ? 'model' : 'rules'}</span></li>;
            })}
          </ul>
        ) : (
          !minded.length && !past.length && <p className="empty">No actions yet. Night Watch writes here each time it tightens a stop, cuts a position or lands a flight.</p>
        )}
      </Card>
    </div>
  );
}
