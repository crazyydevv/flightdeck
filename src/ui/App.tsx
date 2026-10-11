import { useEffect, useState } from 'react';
import {
  PiAirplaneInFlightFill, PiAirplaneTakeoffFill, PiAirplaneTiltFill, PiCassetteTapeFill, PiClipboardTextFill, PiCompassFill, PiLinkSimpleBold,
  PiLightningFill, PiMoonStarsFill, PiPauseFill, PiPlayFill, PiShieldCheckFill, PiX,
} from 'react-icons/pi';
import { hoursMinutes, sessionLabel } from '../core/calendar';
import { snapshot } from '../core/market';
import { FlightPlan, LedgerEntry } from '../core/types';
import { fmtUsd, zulu } from '../core/util';
import { BlackBox } from './BlackBox';
import { Pass } from './bits';
import { Board } from './Board';
import { Flights } from './Flights';
import { Gate } from './Gate';
import { nextStep, reachedStop, STEPS } from './guide';
import { Ledger } from './Ledger';
import { Preflight } from './Preflight';
import { scenarioById } from './scenarios';
import { DeckApi, Tab, useDeck } from './store';
import { Tower } from './Tower';
import { Watch } from './Watch';

const TABS: { id: Tab; name: string; short: string; icon: typeof PiAirplaneTiltFill }[] = [
  { id: 'board', name: 'Departures', short: 'Board', icon: PiAirplaneTakeoffFill },
  { id: 'preflight', name: 'Preflight', short: 'Plan', icon: PiClipboardTextFill },
  { id: 'tower', name: 'Tower', short: 'Tower', icon: PiShieldCheckFill },
  { id: 'flights', name: 'In flight', short: 'Flight', icon: PiAirplaneInFlightFill },
  { id: 'watch', name: 'Night Watch', short: 'Watch', icon: PiMoonStarsFill },
  { id: 'blackbox', name: 'Black Box', short: 'Box', icon: PiCassetteTapeFill },
  { id: 'ledger', name: 'Ledger', short: 'Ledger', icon: PiLinkSimpleBold },
];

/** The flight director: what to do next, one button to do it, or let it fly itself. */
function GuideBar({ api }: { api: DeckApi }) {
  const { deck, actions } = api;
  const step = nextStep(api);
  const auto = deck.guide.auto;

  const stop = reachedStop(api);
  useEffect(() => {
    if (!auto) return;
    if (stop) { actions.setGuide({ auto: false, stopAt: undefined }); return; }
    if (step.done || (!step.run && !step.wait)) { actions.setGuide({ auto: false }); return; }
    if (step.wait || !step.run) return;
    const run = step.run;
    const id = setTimeout(run, 2100);
    return () => clearTimeout(id);
    // the step text identifies the state the timer was armed for
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, step.text, step.wait, step.done, stop]);

  if (deck.tab === 'gate') return null;
  if (!deck.guide.open) {
    return <button type="button" className="guide-open" onClick={() => actions.setGuide({ open: true })}><PiCompassFill aria-hidden="true" /> Guide</button>;
  }
  return (
    <aside className={`guide ${auto ? 'is-auto' : ''}`} aria-label="Guide: what to do next">
      <div className="guide-dots" aria-hidden="true">{Array.from({ length: STEPS }, (_, i) => <i key={i} className={i + 1 < step.n ? 'done' : i + 1 === step.n ? 'now' : ''} />)}</div>
      <p key={step.text}><span>Step {step.n} of {STEPS}</span>{step.text}</p>
      <div className="guide-keys">
        {step.cta && step.run && <button type="button" className="btn btn-primary" onClick={step.run}>{step.cta}</button>}
        {!step.done && (
          <button type="button" className="btn" aria-pressed={auto} aria-label={auto ? 'Pause the demo' : 'Play it for me'} onClick={() => actions.setGuide({ auto: !auto })}>
            {auto ? <><PiPauseFill aria-hidden="true" /><span className="auto-label">Pause</span></> : <><PiPlayFill aria-hidden="true" /><span className="auto-label">Play it for me</span></>}
          </button>
        )}
        <button type="button" className="btn btn-icon" aria-label="Hide the guide" onClick={() => actions.setGuide({ open: false, auto: false })}><PiX aria-hidden="true" /></button>
      </div>
    </aside>
  );
}

type Proof = { entry: LedgerEntry; intact: boolean; of: number };

/** Opens when the page is loaded from a shared pass link. */
function PassViewer() {
  const [state, setState] = useState<{ proof?: Proof; error?: string } | null>(null);
  useEffect(() => {
    const raw = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('pass') : null;
    const m = raw?.match(/^([a-z0-9]{6,24})\.(\d{1,6})$/);
    if (!m) return;
    (async () => {
      try {
        const r = await fetch(`api/pass?deck=${m[1]}&seq=${m[2]}`);
        if (!r.ok) return setState({ error: r.status === 404 ? 'No published entry matches that link.' : 'The published ledger could not be read.' });
        setState({ proof: (await r.json()) as Proof });
      } catch {
        setState({ error: 'The published ledger could not be reached.' });
      }
    })();
  }, []);
  if (!state) return null;
  const body = state.proof?.entry.body as { plan?: FlightPlan; decision?: string; failed?: string[] } | undefined;
  const inst = body?.plan ? snapshot().instruments[body.plan.symbol] : undefined;
  return (
    <div className="overlay" role="dialog" aria-label="Shared boarding pass">
      <div className="overlay-box">
        {state.error && <p className="lead">{state.error}</p>}
        {state.proof && body?.plan && inst && (
          <>
            <Pass plan={body.plan} inst={inst} state={body.decision === 'CLEARED' ? 'CLEARED' : 'REFUSED'} hash={state.proof.entry.hash} seq={state.proof.entry.seq} at={state.proof.entry.at} reasons={body.failed?.slice(0, 3)} />
            <p className={`readback readback-${state.proof.intact ? 'ok' : 'no'}`}>
              {state.proof.intact
                ? `Verified. Entry ${state.proof.entry.seq} of ${state.proof.of} recomputes to its recorded hash and chains from the entry before it.`
                : `Not verified. Entry ${state.proof.entry.seq} does not match its recorded hash.`}
            </p>
          </>
        )}
        <button type="button" className="btn btn-primary" onClick={() => setState(null)}>Open FLIGHTDECK</button>
      </div>
    </div>
  );
}

export function App() {
  const api = useDeck();
  const { deck, now, report, contacts, actions, equity, isLive, liveAvailable, atEnd, openLeaks } = api;
  const [confirmReset, setConfirmReset] = useState(false);
  const session = sessionLabel(now);
  const top = contacts[0];
  const scen = scenarioById(deck.scenario);

  // Each station starts at its top: a button at the foot of one page must not
  // open the next page halfway down.
  useEffect(() => { try { window.scrollTo(0, 0); } catch { /* not a browser */ } }, [deck.tab]);

  const badge: Partial<Record<Tab, { text: string; tone: string }>> = {
    board: top ? { text: `${api.market.instruments[top.symbol].base} ${Math.abs(top.zResid ?? top.z).toFixed(1)}σ`, tone: top.score >= 2 ? 'caution' : 'idle' } : undefined,
    preflight: { text: report.verdict, tone: report.verdict === 'GO' ? 'pass' : report.verdict === 'CAUTION' ? 'caution' : 'fail' },
    tower: deck.filed ? { text: deck.filed.clearance.decision === 'CLEARED' ? 'cleared' : 'refused', tone: deck.filed.clearance.decision === 'CLEARED' ? 'pass' : 'fail' } : { text: `${deck.rules.length} rules`, tone: 'idle' },
    flights: deck.airborne.length ? { text: `${deck.airborne.length} up`, tone: 'pass' } : undefined,
    watch: { text: deck.watchOn ? 'on' : 'off', tone: deck.watchOn ? 'pass' : 'idle' },
    blackbox: openLeaks.length ? { text: `${openLeaks.length} leaks`, tone: 'caution' } : undefined,
    ledger: deck.ledger.length ? { text: String(deck.ledger.length), tone: 'idle' } : undefined,
  };

  return (
    <div className={`deck ${deck.tab === 'gate' ? 'on-gate' : ''}`}>
      <div className="glow" aria-hidden="true" />
      <header className="top">
        <button type="button" className="brand" onClick={() => actions.go('gate')} aria-label="FLIGHTDECK home">
          <span className="brand-mark"><PiAirplaneTiltFill aria-hidden="true" /></span>
          <span className="brand-word">FLIGHTDECK</span>
        </button>
        <div className="top-facts">
          <div className="fact"><b className="num">{zulu(now)}</b><span>{isLive ? 'live clock' : 'simulator clock'}</span></div>
          <div className={`fact ${session.open ? 'fact-go' : 'fact-amber'}`}><b>{session.open ? session.text : `${session.phaseText}, New York closed`}</b><span>{session.open ? 'closes' : 'opens'} in {hoursMinutes(session.until - now)}</span></div>
          <div className="fact"><b className="num">{fmtUsd(equity)}</b><span>USDT paper account</span></div>
        </div>
        <button type="button" className="btn btn-small top-scen" onClick={() => { actions.go('gate'); setTimeout(() => document.getElementById('scenarios')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }}>
          <PiLightningFill aria-hidden="true" /> Scenarios
        </button>
        <div className="seg seg-small" role="group" aria-label="Data feed">
          <button type="button" aria-pressed={!isLive} onClick={() => actions.setFeed('recorded')}>Recorded</button>
          <button type="button" aria-pressed={isLive} onClick={() => actions.setFeed('live')} title={liveAvailable ? 'Live Bitget data' : 'Needs the server routes'}>Live</button>
        </div>
      </header>

      <nav className="tabs" aria-label="Stations">
        {TABS.map((t) => {
          const b = badge[t.id];
          return (
            <button key={t.id} type="button" className="tab" aria-current={deck.tab === t.id ? 'page' : undefined} aria-label={t.name} onClick={() => actions.go(t.id)}>
              <t.icon aria-hidden="true" />
              <span className="tab-long">{t.name}</span>
              <span className="tab-short" aria-hidden="true">{t.short}</span>
              {b && <em className={`tone-${b.tone}`}>{b.text}</em>}
            </button>
          );
        })}
      </nav>

      <main key={deck.tab}>
        {deck.notice && (
          <p className="notice" role="status">
            {deck.notice} <button type="button" className="btn btn-small" onClick={actions.dismiss}>Dismiss</button>
          </p>
        )}
        {scen && deck.tab !== 'gate' && (
          <aside className="scen-strip" aria-label="Scenario">
            <span className="scen-kicker"><PiLightningFill aria-hidden="true" /> Scenario</span>
            <p><b>{scen.title}.</b> {scen.watchFor}</p>
            <button type="button" className="btn btn-small" onClick={actions.endScenario}>End scenario</button>
          </aside>
        )}
        {deck.tab === 'gate' && <Gate api={api} />}
        {deck.tab === 'board' && <Board api={api} />}
        {deck.tab === 'preflight' && <Preflight api={api} />}
        {deck.tab === 'tower' && <Tower api={api} />}
        {deck.tab === 'flights' && <Flights api={api} />}
        {deck.tab === 'watch' && <Watch api={api} />}
        {deck.tab === 'blackbox' && <BlackBox api={api} />}
        {deck.tab === 'ledger' && <Ledger api={api} />}
      </main>

      <footer className="foot">
        <p>
          {isLive ? 'Live Bitget data.' : `Recorded Bitget candles, 1 to 8 October 2026${atEnd ? '; the simulator clock has reached the end of the recording' : ''}.`}{' '}
          FLIGHTDECK judges position size and survival; it does not predict price, and it is not advice.
        </p>
        <div className="actions">
          {confirmReset
            ? (
              <>
                <span>Erase the ledger, logbook and learned rules on this device?</span>
                <button type="button" className="btn btn-small" onClick={() => { actions.reset(); setConfirmReset(false); }}>Erase and reset</button>
                <button type="button" className="btn btn-small" onClick={() => setConfirmReset(false)}>Keep them</button>
              </>
            )
            : <button type="button" className="btn btn-small" onClick={() => setConfirmReset(true)}>Reset the deck</button>}
        </div>
      </footer>

      <GuideBar api={api} />
      <PassViewer />
    </div>
  );
}
