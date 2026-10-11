import { useMemo, useState } from 'react';
import { PiAirplaneTakeoffFill, PiArrowRight, PiCalendarX, PiCassetteTape, PiClipboardText, PiMoonStars, PiPlayFill, PiRobot, PiShieldCheck } from 'react-icons/pi';
import { parseThesis } from '../core/parse';
import { planHash, preflight } from '../core/preflight';
import { offerLine, reroute } from '../core/reroute';
import { requestClearance } from '../core/tower';
import { Pass, useReducedMotion } from './bits';
import STUDY from '../../research/headline.json';
import { SCENARIOS, ScenarioId } from './scenarios';
import { DeckApi } from './store';

const SCEN_ICON: Record<ScenarioId, typeof PiRobot> = { overnight: PiAirplaneTakeoffFill, watch: PiMoonStars, earnings: PiCalendarX, agent: PiRobot };

const n0 = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 0 });
const p1 = (x: number) => (x * 100).toFixed(1) + '%';
const p0 = (x: number) => Math.round(x * 100) + '%';

const EXAMPLES = ['20x long NVDA, $400, over the weekend', '100x long TSLA, $500, 24h', '3x short MSTR, $300, 2 days'];

const ROUTES = [
  { id: 'r1', d: 'M30,262 Q320,-30 610,246', dur: 13, label: 'NVDA 5x', tone: 'go', denied: false },
  { id: 'r2', d: 'M96,270 Q300,70 528,262', dur: 9, label: 'MSTR 25x', tone: 'stop', denied: true },
  { id: 'r3', d: 'M170,276 Q340,140 470,270', dur: 10.5, label: 'AAPL 3x', tone: 'go', denied: false },
];
const STARS = Array.from({ length: 46 }, (_, i) => ({ x: (i * 137.5) % 640, y: ((i * 61) % 190) + 6, r: i % 7 === 0 ? 1.4 : 0.8, o: 0.25 + ((i * 29) % 50) / 100 }));

/** Trades as flights: cleared ones cross the sky, the 25x one is turned back. */
function Sky() {
  const reduced = useReducedMotion();
  return (
    <svg className="sky" viewBox="0 0 640 300" role="img" aria-label="Animated routes: cleared trades fly their course, a 25x trade is turned back by the tower.">
      <defs>
        <radialGradient id="sky-horizon" cx="50%" cy="100%" r="75%">
          <stop offset="0" className="sky-h0" /><stop offset="0.5" className="sky-h1" /><stop offset="1" className="sky-h2" />
        </radialGradient>
      </defs>
      <rect width="640" height="300" fill="url(#sky-horizon)" />
      {STARS.map((s, i) => <circle key={i} className="sky-star" cx={s.x} cy={s.y} r={s.r} opacity={s.o} />)}
      <path className="sky-earth" d="M-40,300 Q320,236 680,300" />
      {ROUTES.map((r) => (
        <g key={r.id} className={`sky-route sky-${r.tone}`}>
          <path id={r.id} d={r.d} className="sky-path" />
          <circle className="sky-port" cx={r.d.match(/M(\d+)/)![1]} cy={r.d.match(/M\d+,(\d+)/)![1]} r="3" />
          {!r.denied && <circle className="sky-port" cx={r.d.split(' ').pop()!.split(',')[0]} cy={r.d.split(',').pop()} r="3" />}
          <g className="sky-plane">
            <path d="M15 0 L-10 -9 L-6 0 L-10 9 Z" />
            {reduced
              ? <animateMotion dur="0.001s" fill="freeze" rotate="auto" keyPoints={r.denied ? '0.44;0.44' : '0.55;0.55'} keyTimes="0;1" calcMode="linear"><mpath href={`#${r.id}`} /></animateMotion>
              : r.denied
                ? <animateMotion dur={`${r.dur}s`} repeatCount="indefinite" rotate="auto" keyPoints="0;0.44;0.44;0" keyTimes="0;0.42;0.72;1" calcMode="linear"><mpath href={`#${r.id}`} /></animateMotion>
                : <animateMotion dur={`${r.dur}s`} repeatCount="indefinite" rotate="auto"><mpath href={`#${r.id}`} /></animateMotion>}
          </g>
          <g className="sky-tag">
            <rect x="14" y="-30" width={r.label.length * 7.6 + 18} height="22" rx="11" />
            <text x="23" y="-15">{r.label}</text>
            {reduced
              ? <animateMotion dur="0.001s" fill="freeze" keyPoints={r.denied ? '0.44;0.44' : '0.55;0.55'} keyTimes="0;1" calcMode="linear"><mpath href={`#${r.id}`} /></animateMotion>
              : r.denied
                ? <animateMotion dur={`${r.dur}s`} repeatCount="indefinite" keyPoints="0;0.44;0.44;0" keyTimes="0;0.42;0.72;1" calcMode="linear"><mpath href={`#${r.id}`} /></animateMotion>
                : <animateMotion dur={`${r.dur}s`} repeatCount="indefinite"><mpath href={`#${r.id}`} /></animateMotion>}
          </g>
        </g>
      ))}
      <g className="sky-denied" transform="translate(292,168)" opacity={reduced ? 1 : 0}>
        <circle r="15" />
        <text y="34" textAnchor="middle">DENIED: 25x, no stop</text>
        {!reduced && <animate attributeName="opacity" dur="9s" repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="0;0.4;0.44;0.7;0.76;1" />}
      </g>
    </svg>
  );
}

const STATIONS = [
  { tab: 'board', icon: PiAirplaneTakeoffFill, name: 'Departures', text: 'Every stock perp, how far it drifted while New York was shut, and the leverage the Tower will clear right now.' },
  { tab: 'preflight', icon: PiClipboardText, name: 'Preflight', text: 'Eight checks on your trade. If it fails, you get the size that survives.' },
  { tab: 'tower', icon: PiShieldCheck, name: 'Tower', text: 'Clears or refuses, for you and for any AI agent. A refusal comes with the size it will clear, one click away.' },
  { tab: 'watch', icon: PiMoonStars, name: 'Night Watch', text: 'Minds the flight while you sleep. It can only reduce risk, never add it.' },
  { tab: 'blackbox', icon: PiCassetteTape, name: 'Black Box', text: 'Reads your history for habits that lose money and turns each into a new Tower rule.' },
] as const;

export function Gate({ api }: { api: DeckApi }) {
  const { market, now, equity, deck, actions, plan } = api;
  const [text, setText] = useState(EXAMPLES[0]);

  // A preview only: nothing here is filed or written to the ledger.
  const quick = useMemo(() => {
    const base = { ...plan, stop: undefined, target: undefined };
    const { plan: parsed, understood } = parseThesis(text, market, base);
    const inst = market.instruments[parsed.symbol];
    const d = parsed.side === 'long' ? 1 : -1;
    const p = {
      ...parsed, leverage: Math.min(parsed.leverage, inst.maxLever),
      stop: parsed.stop ?? Number((parsed.entry * (1 - d * 0.025)).toFixed(inst.pricePlace)),
      target: parsed.target ?? Number((parsed.entry * (1 + d * 0.06)).toFixed(inst.pricePlace)),
    };
    const report = preflight(p, market, now, equity);
    const c = requestClearance(p, deck.rules, { now, equity, instrument: inst, preflight: report, logbook: deck.logbook });
    return { p, inst, report, c, understood, offer: reroute(p, deck.rules, market, now, equity, deck.logbook) };
  }, [text, market, now, equity, deck.rules, deck.logbook, plan]);

  const failed = quick.report.checks.filter((c) => c.status === 'fail').length;
  const refused = quick.c.findings.filter((f) => !f.ok).map((f) => f.title);
  const cleared = quick.c.decision === 'CLEARED';

  return (
    <div className="gate">
      <section className="hero">
        <div className="hero-copy">
          <p className="hero-kicker">Built on Bitget stock perps and Agent Hub</p>
          <h1>Every trade needs clearance.</h1>
          <p className="hero-sub">
            Bitget lists NVIDIA, Tesla, Apple and Microsoft at up to 100x, open all night while Nasdaq sleeps.
            FLIGHTDECK finds the size your trade survives at, refuses anything bigger, and keeps watch while you sleep.
          </p>
          <div className="hero-cta">
            <button type="button" className="btn btn-primary btn-big" onClick={() => actions.scenario('overnight')}>
              <PiPlayFill aria-hidden="true" /> Play the demo flight
            </button>
            <button type="button" className="btn btn-big" onClick={() => actions.go('board')}>Open the deck <PiArrowRight aria-hidden="true" /></button>
          </div>
          <p className="hero-note">The demo plays itself in about 25 seconds on recorded Bitget candles. No sign-up, no key.</p>
        </div>
        <div className="hero-sky"><Sky /></div>
      </section>

      <section className="scen" id="scenarios" aria-labelledby="scen-h">
        <div className="scen-head">
          <h2 id="scen-h">Four incidents. One click each.</h2>
          <p>Each one starts from a clean deck on the same recorded moment, 07 October 2026 at 13:00 UTC, and plays itself on the Bitget hours that actually followed.</p>
        </div>
        <ul>
          {SCENARIOS.map((sc) => {
            const Icon = SCEN_ICON[sc.id];
            return (
              <li key={sc.id}>
                <button type="button" className="scen-card" onClick={() => actions.scenario(sc.id)}>
                  <span className="scen-icon"><Icon aria-hidden="true" /></span>
                  <span className="scen-kick">{sc.kicker}</span>
                  <b>{sc.title}</b>
                  <span className="scen-blurb">{sc.blurb}</span>
                  <span className="scen-go"><PiPlayFill aria-hidden="true" /> Play</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="try">
        <div className="try-form">
          <h2>Type a trade. See if it boards.</h2>
          <label htmlFor="try-input" className="sr">Describe a trade</label>
          <input id="try-input" type="text" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} placeholder="10x long NVDA, $400, stop 231, 2 days" />
          <div className="chips">
            {EXAMPLES.map((ex) => <button key={ex} type="button" className={`chip-btn ${ex === text ? 'is-on' : ''}`} onClick={() => setText(ex)}>{ex}</button>)}
          </div>
          <p className={`try-verdict ${cleared ? 'is-go' : 'is-stop'}`}>
            {cleared
              ? `Cleared. ${quick.inst.base} at ${quick.p.leverage}x passes preflight and every Tower rule right now.`
              : `Denied. ${failed ? `${failed} of 8 preflight checks fail` : 'Preflight passes'}${refused.length ? `, and the Tower refuses it on ${refused.length} rule${refused.length > 1 ? 's' : ''}` : ''}. ${offerLine(quick.offer, quick.inst.base)}`}
          </p>
          <div className="actions">
{!cleared && quick.offer.ok && (
              <button type="button" className="btn btn-primary" onClick={() => actions.reroute(quick.p)}>Re-route to {quick.offer.plan.leverage}x and clear it</button>
            )}
            <button type="button" className={`btn ${!cleared && quick.offer.ok ? '' : 'btn-primary'}`} onClick={() => actions.readThesis(text, true)}>Take this plan into Preflight</button>
            <span className="fine">Read as: {quick.understood.join(', ') || 'nothing yet'}. Stop and target default to 2.5% and 6%.</span>
          </div>
        </div>
        <Pass key={planHash(quick.p) + quick.c.decision} plan={quick.p} inst={quick.inst} state={cleared ? 'CLEARED' : 'REFUSED'} hash={quick.c.planHash} at={now} reasons={cleared ? undefined : refused.slice(0, 3)} />
      </section>

      <section className="pitch">
        <p>A liquidated trader pays fees once. A trader who survives keeps trading.</p>
        <span>FLIGHTDECK does not stop the trade. It resizes it, so the account is still there for the next one.</span>
      </section>

      <section className="proof" aria-labelledby="proof-h">
        <div className="proof-head">
          <p className="hero-kicker">The study</p>
          <h2 id="proof-h">Tested on every hour, not on one good story.</h2>
          <p>
            {n0(STUDY.plans)} plans: every entry hour across {STUDY.days} days of Bitget candles, {STUDY.contracts} contracts, long and short, at 10x, 20x and 50x,
            with the app's default stop and target. Each was judged using only candles that had already closed, then flown through the day that followed.
          </p>
        </div>
        <dl>
          <div><dt>{p1(STUDY.liquidated50)}</dt><dd>of 50x plans were liquidated within a day. Preflight's average forecast before entry: {p1(STUDY.forecast50)}.</dd></div>
          <div><dt>{n0(Math.round(STUDY.liquidatedRerouted * STUDY.plans))}</dt><dd>liquidations in {n0(STUDY.plans)} re-routed flights, at an average cleared leverage of {STUDY.meanReroutedLeverage.toFixed(1)}x.</dd></div>
          <div><dt>{STUDY.monthLiquidations50.toFixed(1)}</dt><dd>liquidations in a month of the 50x habit, ending {n0(STUDY.monthEnd50)} USDT on a 10,000 account. Re-routed: {n0(STUDY.monthEndRerouted)}.</dd></div>
          <div><dt>{p0(STUDY.gainKept)} / {p0(STUDY.lossKept)}</dt><dd>of the gains and of the losses kept after the re-route. Smaller, not smarter: it does not predict.</dd></div>
        </dl>
        {STUDY.forward.plans > 0 && (
          <div className="proof-live">
            <b>Still being tested</b>
            <p>
              The study is frozen at 08 October 2026. Since then, on {n0(STUDY.forward.entryHours)} new hours of Bitget candles ({n0(STUDY.forward.plans)} plans, through {new Date(STUDY.forward.through).toISOString().slice(0, 10)}),
              50x plans were liquidated {p1(STUDY.forward.liquidated50)} of the time as filed against a forecast of {p1(STUDY.forward.forecast50)}, and {p1(STUDY.forward.liquidatedRerouted)} of re-routed flights were liquidated.
              The engines are unchanged, a weekly job adds each new week and rewrites this line, and the first weeks are a small sample.{' '}
              <a href="https://github.com/crazyydevv/flightdeck/blob/HEAD/research/FORWARD.md" target="_blank" rel="noreferrer">The running score <PiArrowRight aria-hidden="true" /></a>
            </p>
          </div>
        )}
        <p className="proof-note">
          What it did not show: any edge on direction, or any advantage over a flat {STUDY.flatCap}x cap on the average result. The forecast is a base rate, not a timing signal.
          FLIGHTDECK's job is to put that number in front of you before the trade and hold you and your agents to the size.{' '}
          <a href="https://github.com/crazyydevv/flightdeck/blob/HEAD/docs/STUDY.md" target="_blank" rel="noreferrer">Read the study <PiArrowRight aria-hidden="true" /></a>
        </p>
      </section>

      <section className="route">
        <h2>One loop, five stations</h2>
        <ol>
          {STATIONS.map((s) => (
            <li key={s.tab}>
              <button type="button" onClick={() => actions.go(s.tab)}>
                <span className="route-dot"><s.icon aria-hidden="true" /></span>
                <b>{s.name}</b>
                <span>{s.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="facts">
        <div><b>Real candles</b><span>Recorded from Bitget's public API, 1 to 8 October 2026. Switch to Live for current data.</span></div>
        <div><b>Math decides</b><span>Verdicts and clearances are plain code. A model may argue; it cannot overrule.</span></div>
        <div><b>Your key stays yours</b><span>Bring a Bitget key to read your own history or place demo orders. It is never stored on the server.</span></div>
        <div><b>Open to agents</b><span>The Tower is an MCP server. Agents file here before Bitget Agent Hub executes.</span></div>
      </section>
    </div>
  );
}
