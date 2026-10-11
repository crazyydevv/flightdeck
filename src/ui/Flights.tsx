import { PiAirplaneTiltFill, PiMoonStarsFill } from 'react-icons/pi';
import { hoursMinutes } from '../core/calendar';
import { unrealised } from '../core/flight';
import { lastPrice, snapshot } from '../core/market';
import { debrief } from '../core/nightwatch';
import { Flight, FlightPlan } from '../core/types';
import { fmtPct, fmtUsd, HOUR, sha256, zulu } from '../core/util';
import { Card, Level, Pass, PriceChart } from './bits';
import { DeckApi, ownFlights } from './store';

const asPlan = (f: Flight): FlightPlan => ({
  symbol: f.symbol, side: f.side, leverage: f.leverage, margin: f.margin, entry: f.entry,
  stop: f.stop, target: f.target, horizonH: f.horizonH, origin: f.origin,
});

const OUTCOME: Record<string, string> = {
  target: 'Reached the target', stopped: 'Stopped out', liquidated: 'Liquidated', landed: 'Brought down early', timeout: 'Hold time ran out',
};

function levelsOf(f: Flight): Level[] {
  const out: Level[] = [{ y: f.entry, label: 'ENTRY', kind: 'entry', pin: true }];
  if (f.target !== undefined) out.push({ y: f.target, label: 'TGT', kind: 'sel', pin: true });
  if (f.stop !== undefined) out.push({ y: f.stop, label: 'STOP', kind: 'sel', pin: true });
  out.push({ y: f.liqPrice, label: 'LIQ', kind: 'warn' });
  return out;
}

export function Flights({ api }: { api: DeckApi }) {
  const { deck, market, now, actions, isLive, atEnd } = api;
  const landed = ownFlights(deck).sort((a, b) => (b.closedAt as number) - (a.closedAt as number));

  return (
    <div className="view">
      <header className="view-head">
        <h1>In flight</h1>
        <p>Cleared trades fly here. The line is the price; the plane is where you are. On the recorded feed you can fly through real Bitget hours the engines never saw.</p>
      </header>

      {!deck.airborne.length && (
        <Card className="card-glass">
          <div className="empty">
            <p>{landed.length ? 'Every flight is down. The Black Box has the recording.' : 'Nothing airborne. A flight takes off once the Tower clears its plan.'}</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => actions.go('preflight')}>Plan a flight</button>
              {landed.length > 0 && <button type="button" className="btn" onClick={() => actions.go('blackbox')}>Open the Black Box</button>}
            </div>
          </div>
        </Card>
      )}

      {deck.airborne.map((f) => {
        const inst = market.instruments[f.symbol];
        const price = lastPrice(market, f.symbol);
        const pnl = unrealised(f, price) + (f.realised ?? 0);
        const cs = (market.hourly[f.symbol] ?? []).filter((c) => c.t >= f.openedAt - 12 * HOUR);
        const toLiq = Math.abs(price - f.liqPrice) / price;
        const left = f.openedAt + f.horizonH * HOUR - now;
        return (
          <Card key={f.id} className="card-glass flight" title={`${f.id} airborne`} aside={`${inst.base} ${f.leverage}x ${f.side}, ${f.venue?.startsWith('bitget') ? f.venue : 'paper book'}`} icon={<PiAirplaneTiltFill aria-hidden="true" />}>
            <div className="runway" aria-hidden="true"><PiAirplaneTiltFill /></div>
            <PriceChart candles={cs} levels={levelsOf(f)} sessions={inst.cls === 'rwa'} place={inst.pricePlace} height={220} mark={f.openedAt} plane />
            <dl className="readouts readouts-big">
              <div><dt>Result so far</dt><dd className={pnl >= 0 ? 'up' : 'down'}>{fmtUsd(pnl)} USDT</dd></div>
              <div><dt>Mark</dt><dd>{price.toFixed(inst.pricePlace)}</dd></div>
              <div><dt>To liquidation</dt><dd>{fmtPct(toLiq, 1, false)}</dd></div>
              <div><dt>Position open</dt><dd>{fmtPct(f.open ?? 1, 0, false)}</dd></div>
              <div><dt>Hold time left</dt><dd>{hoursMinutes(left)}</dd></div>
            </dl>
            <div className={`watchbar ${f.watch ? 'is-on' : ''}`}>
              <PiMoonStarsFill aria-hidden="true" />
              <p><b>Night Watch {f.watch ? 'on' : 'off'}.</b> {f.watch ? debrief(f, inst.base) : 'Nobody is minding this flight between your visits.'}</p>
              <button type="button" className="btn btn-small" aria-pressed={Boolean(f.watch)} onClick={() => actions.toggleWatch(f.id)}>{f.watch ? 'Turn off' : 'Turn on'}</button>
            </div>
            <div className="actions">
              {!isLive && (
                <>
                  <button type="button" className="btn btn-primary" disabled={deck.flying || atEnd} onClick={() => actions.fly(true)}>{deck.flying ? 'Flying the recording' : 'Fly the recording'}</button>
                  <button type="button" className="btn" disabled={deck.flying || atEnd} onClick={() => actions.advance(1)}>Advance one hour</button>
                </>
              )}
              <button type="button" className="btn" onClick={() => { actions.fly(false); actions.landNow(f.id); }}>Land now at {price.toFixed(inst.pricePlace)}</button>
            </div>
            {!isLive && <p className="fine">{atEnd ? 'The recording ends here. Land the flight to close it at the last recorded price.' : 'Recorded Bitget hours, replayed in order. Preflight and the Tower saw none of them when they judged the plan.'}</p>}
          </Card>
        );
      })}

      {landed.length > 0 && (
        <Card title="Landed" aside={`${landed.length} flown from this deck`}>
          <ul className="landed">
            {landed.slice(0, 6).map((f) => {
              const inst = market.instruments[f.symbol] ?? snapshot().instruments[f.symbol];
              return (
                <li key={f.id}>
                  {inst && <Pass plan={asPlan(f)} inst={inst} state="LANDED" hash={sha256(f.id)} at={f.closedAt} />}
                  <div className="landed-notes">
                    <p className="lead">
                      <b>{OUTCOME[f.outcome ?? 'landed']}</b> at {(f.exit as number).toFixed(inst?.pricePlace ?? 2)} after {hoursMinutes((f.closedAt as number) - f.openedAt)}:{' '}
                      <b className={(f.pnl as number) >= 0 ? 'up' : 'down'}>{fmtUsd(f.pnl as number)} USDT</b>.
                    </p>
                    {f.shadow && (
                      <p className="shadow">
                        As you first filed it, at {f.shadow.leverage}x, the same hours would have ended <b>{OUTCOME[f.shadow.outcome].toLowerCase()}</b> for{' '}
                        <b>{fmtUsd(f.shadow.pnl)} USDT</b>. Flying the cleared size instead was worth <b>{fmtUsd((f.pnl as number) - f.shadow.pnl)} USDT</b>.
                      </p>
                    )}
                    {f.unwatched && Math.abs((f.pnl as number) - f.unwatched.pnl) >= 0.01 && (
                      <p className="shadow shadow-watch">
                        With Night Watch off, the same flight over the same hours would have ended <b>{OUTCOME[f.unwatched.outcome].toLowerCase()}</b> for{' '}
                        <b>{fmtUsd(f.unwatched.pnl)} USDT</b>. Night Watch was worth <b>{fmtUsd((f.pnl as number) - f.unwatched.pnl)} USDT</b> on this one.
                      </p>
                    )}
                    {(f.watchChecks ?? 0) > 0 && inst && <p className="fine">{debrief(f, inst.base)}</p>}
                    <p className="fine">Opened {zulu(f.openedAt)}, landed {zulu(f.closedAt as number)}.</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
