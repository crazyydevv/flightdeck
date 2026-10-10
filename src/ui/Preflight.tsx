import { useState } from 'react';
import { Instrument, PreflightReport } from '../core/types';
import { fmtPct, fmtUsd } from '../core/util';
import { offerLine } from '../core/reroute';
import { Card, Num, Status } from './bits';
import { DeckApi } from './store';

/**
 * The price tape, like the altitude tape on a flight display: a vertical scale
 * with markers. Ivory is the market, blue is what the pilot chose, pink is what
 * the deck computed, red is where the flight ends.
 */
function Tape({ r, inst }: { r: PreflightReport; inst: Instrument }) {
  const p = r.plan, n = r.numbers;
  const d = p.side === 'long' ? 1 : -1;
  const W = 250, H = 330, top = 14, bot = H - 14, axis = 78;
  const shockPx = p.entry * (1 - d * n.shock);
  const sig = p.entry * n.sigmaHorizon;
  const core = [p.entry + sig, p.entry - sig, shockPx, p.stop, p.target].filter((x): x is number => x !== undefined && x > 0);
  let lo = Math.min(...core), hi = Math.max(...core);
  // bring liquidation onto the tape only when it is near enough to matter
  const liqNear = Math.abs(n.liqPrice - p.entry) <= (hi - lo) * 1.6;
  if (liqNear) { lo = Math.min(lo, n.liqPrice); hi = Math.max(hi, n.liqPrice); }
  const pad = (hi - lo) * 0.09;
  lo -= pad; hi += pad;
  const y = (px: number) => top + (1 - (px - lo) / (hi - lo)) * (bot - top);
  const clampY = (px: number) => Math.max(top, Math.min(bot, y(px)));

  const step = niceStep((hi - lo) / 6);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);

  type Bug = { px: number; text: string; cls: string };
  const bugs: Bug[] = [{ px: p.entry, text: 'ENTRY', cls: 'bug-entry' }];
  if (p.target !== undefined) bugs.push({ px: p.target, text: 'TARGET', cls: 'bug-sel' });
  if (p.stop !== undefined) bugs.push({ px: p.stop, text: 'STOP', cls: 'bug-sel' });
  bugs.push({ px: shockPx, text: 'SHOCK', cls: 'bug-caution' });
  if (liqNear) bugs.push({ px: n.liqPrice, text: 'LIQ', cls: 'bug-warn' });
  const guided = r.verdict === 'NO-GO' && r.guidance.fixable && r.guidance.leverage !== p.leverage;
  const gLiq = guided ? p.entry * (1 - d * (1 / r.guidance.leverage - inst.mmr)) : 0;
  if (guided && gLiq > lo && gLiq < hi) bugs.push({ px: gLiq, text: `LIQ ${r.guidance.leverage}x`, cls: 'bug-deck' });

  const placed = bugs.map((b) => ({ ...b, y: y(b.px), ly: y(b.px) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < placed.length; i++) if (placed[i].ly - placed[i - 1].ly < 15) placed[i].ly = placed[i - 1].ly + 15;
  for (let i = placed.length - 1; i > 0; i--) if (placed[i].ly > bot) { placed[i].ly = bot; if (placed[i].ly - placed[i - 1].ly < 15) placed[i - 1].ly = placed[i].ly - 15; }

  const liqY = clampY(n.liqPrice);
  const dead = d === 1 ? { y: liqY, h: bot - liqY } : { y: top, h: liqY - top };

  return (
    <svg className="tape" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Price tape. Entry ${p.entry}, stop ${p.stop ?? 'none'}, target ${p.target ?? 'none'}, liquidation ${n.liqPrice.toFixed(inst.pricePlace)}, shock level ${shockPx.toFixed(inst.pricePlace)}.`}>
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="tape-hatch" />
        </pattern>
      </defs>
      <rect x={axis - 30} y={top} width="30" height={bot - top} rx="4" className="tape-body" />
      {liqNear && dead.h > 0 && <rect x={axis - 30} y={dead.y} width="30" height={dead.h} fill="url(#hatch)" />}
      <rect x={axis - 30} y={y(p.entry + sig)} width="30" height={y(p.entry - sig) - y(p.entry + sig)} className="tape-noise" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={axis - 8} x2={axis} y1={y(t)} y2={y(t)} className="tape-tick" />
          <text x={axis - 36} y={y(t) + 3.5} textAnchor="end" className="tape-num">{t.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0)}</text>
        </g>
      ))}
      <line x1={axis} x2={axis} y1={top} y2={bot} className="tape-axis" />
      {placed.map((b) => (
        <g key={b.text} className={b.cls}>
          <line x1={axis - 30} x2={axis + 8} y1={b.y} y2={b.y} className="bug-line" />
          <polyline points={`${axis + 8},${b.y} ${axis + 20},${b.ly} ${axis + 26},${b.ly}`} className="bug-lead" fill="none" />
          <text x={axis + 30} y={b.ly + 3.5} className="bug-text">{b.text} {b.px.toFixed(inst.pricePlace)}</text>
        </g>
      ))}
    </svg>
  );
}

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

const HORIZONS = [[4, '4 hours'], [12, '12 hours'], [18, 'Overnight, 18h'], [24, '1 day'], [48, '2 days'], [72, 'A weekend, 72h'], [120, '5 days'], [504, '3 weeks']] as const;

export function Preflight({ api }: { api: DeckApi }) {
  const { plan, report: r, route, inst, market, actions, briefs, equity, server, crewModel, crewAsking } = api;
  const [thesis, setThesis] = useState(plan.thesis ?? '');
  const [heard, setHeard] = useState<string[] | null>(null);
  const g = r.guidance;
  const fails = r.checks.filter((c) => c.status === 'fail');
  const cautions = r.checks.filter((c) => c.status === 'caution');
  const horizons = HORIZONS.some(([h]) => h === plan.horizonH) ? HORIZONS : [...HORIZONS, [plan.horizonH, `${plan.horizonH} hours`] as const];
  const tone = r.verdict === 'GO' ? 'pass' : r.verdict === 'CAUTION' ? 'caution' : 'fail';
  // the plan on the desk would not clear as filed
  const needsRoute = !route.ok || route.changes.length > 0;

  return (
    <div className="view">
      <header className="view-head">
        <h1>Preflight</h1>
        <p>Eight checks try to kill the trade before the market does. Change anything and they run again. None of this calls a model.</p>
      </header>

      <div className="cols cols-pre">
        <Card title="Flight plan" aside={`account ${fmtUsd(equity)} USDT`}>
          <form className="thesis" onSubmit={(e) => { e.preventDefault(); setHeard(actions.readThesis(thesis)); }}>
            <label htmlFor="thesis">Say it in one line</label>
            <div className="thesis-row">
              <input id="thesis" type="text" value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="10x long NVDA, $400, stop 231 target 252, over the weekend" autoComplete="off" />
              <button type="submit" className="btn">Read back</button>
            </div>
            {heard && <p className="readback">{heard.length ? `Read back: ${heard.join(', ')}.` : 'Nothing in that line matched a plan field. Try naming the instrument, side and leverage.'}</p>}
          </form>

          <div className="fields">
            <label className="field" htmlFor="f-sym">
              <span className="field-label">Instrument</span>
              <span className="field-box">
                <select id="f-sym" value={plan.symbol} onChange={(e) => actions.setPlan({ symbol: e.target.value })}>
                  {Object.values(market.instruments).map((i) => <option key={i.symbol} value={i.symbol}>{i.base} {i.name}{i.cls === 'rwa' ? ' (stock perp)' : ''}</option>)}
                </select>
              </span>
            </label>
            <div className="field">
              <span className="field-label" id="side-label">Side</span>
              <div className="seg" role="group" aria-labelledby="side-label">
                <button type="button" aria-pressed={plan.side === 'long'} onClick={() => actions.setPlan({ side: 'long' })}>Long</button>
                <button type="button" aria-pressed={plan.side === 'short'} onClick={() => actions.setPlan({ side: 'short' })}>Short</button>
              </div>
            </div>
            <Num id="f-lev" label="Leverage" hint={`Bitget allows ${inst.maxLever}x`} value={plan.leverage} min={1} max={inst.maxLever} step={1} suffix="x"
              onChange={(v) => actions.setPlan({ leverage: Math.max(1, Math.min(inst.maxLever, Math.round(v ?? 1))) })} />
            <Num id="f-margin" label="Margin" value={plan.margin} min={5} step={10} suffix="USDT" onChange={(v) => actions.setPlan({ margin: Math.max(5, v ?? 5) })} />
            <Num id="f-stop" label="Stop" value={plan.stop} step={0.01} onChange={(v) => actions.setPlan({ stop: v })} />
            <Num id="f-target" label="Target" value={plan.target} step={0.01} onChange={(v) => actions.setPlan({ target: v })} />
            <label className="field" htmlFor="f-hold">
              <span className="field-label">Hold for</span>
              <span className="field-box">
                <select id="f-hold" value={plan.horizonH} onChange={(e) => actions.setPlan({ horizonH: Number(e.target.value) })}>
                  {horizons.map(([h, text]) => <option key={h} value={h}>{text}</option>)}
                </select>
              </span>
            </label>
            <div className="field">
              <span className="field-label">Entry at market</span>
              <span className="field-fixed">{plan.entry.toFixed(inst.pricePlace)}</span>
            </div>
          </div>
          <p className="fine">Position {fmtUsd(r.numbers.notional, 0)} USDT, {r.numbers.qty.toFixed(inst.sizePlace)} {inst.base}.</p>
        </Card>

        <Card className={`card-glass verdict-card tone-${tone}`}>
          <div className={`verdict verdict-${tone}`} key={r.verdict}>
            <strong>{r.verdict}</strong>
            <p>
              {r.verdict === 'NO-GO' && `${fails.length} of 8 checks failed. `}
              {r.verdict === 'CAUTION' && `No check failed, ${cautions.length} raised a caution. `}
              {r.verdict === 'GO' && 'All eight checks passed. '}
              {r.verdict === 'NO-GO' && (g.fixable
                ? <>The same trade survives at <b className="calc">{g.leverage}x{g.margin !== plan.margin ? ` on ${g.margin} USDT` : ''}</b>.</>
                : <>No position size fixes this: {g.blockers.join(', ').toLowerCase()}.</>)}
            </p>
          </div>
          <div className="pre-grid">
            <Tape r={r} inst={inst} />
            <ul className="checks">
              {r.checks.map((c) => (
                <li key={c.id} className={`check check-${c.status}`}>
                  <details>
                    <summary>
                      <Status status={c.status} />
                      <b>{c.label}</b>
                      <span className="check-read num">{c.readout}</span>
                    </summary>
                    <p>{c.headline}</p>
                    <p className="fine">{c.detail}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
          {needsRoute && (
            <div className={`reroute ${route.ok ? '' : 'is-blocked'}`}>
              <b>{route.ok ? 'Re-route' : 'No route'}</b>
              <p>{offerLine(route, inst.base)}{route.ok && r.verdict !== 'NO-GO' ? ' Preflight passes at the size you filed; a Tower rule is what stops it.' : ''}</p>
            </div>
          )}
          <div className="actions">
            {needsRoute && route.ok && (
              <button type="button" className="btn btn-deck btn-big" onClick={() => actions.reroute()}>Re-route to {route.plan.leverage}x and clear it</button>
            )}
            <button type="button" className={`btn ${needsRoute ? '' : 'btn-primary'}`} onClick={actions.requestClearance}>{needsRoute ? `Request clearance at ${plan.leverage}x anyway` : 'Request clearance'}</button>
          </div>
          <p className="fine">
            Replay: {r.replay.windows} past {r.replay.basis} windows, {r.replay.target} reached target, {r.replay.stopped} stopped out, {r.replay.liquidated} liquidated.
            Reshuffled paths: {fmtPct(r.monteCarlo.paths ? r.monteCarlo.liquidated / r.monteCarlo.paths : 0, 0, false)} liquidated,{' '}
            {fmtPct(r.monteCarlo.paths ? r.monteCarlo.stopped / r.monteCarlo.paths : 0, 0, false)} stopped. Past windows are not a forecast.
          </p>
        </Card>
      </div>

      <Card title="The crew argues against you" aside={crewModel ? `in the words of ${crewModel}` : crewAsking ? `${server?.model ?? 'the model'} is writing` : 'on duty, briefed from the eight checks'}>
        <div className="crew">
          {briefs.map((b) => (
            <article key={b.seat}>
              <h3>{b.seat}<span>{b.role}</span></h3>
              <p>{b.text}</p>
            </article>
          ))}
        </div>
        <p className="fine">
          {crewModel
            ? `${crewModel} was handed the eight checks and nothing else. It argues; it cannot change the verdict.`
            : server?.crew
              ? `The crew briefs every plan from the eight checks straight away. ${server.model} rewrites them in its own words once the plan has been still for two seconds.`
              : 'The crew briefs every plan from the eight checks, with no waiting and no key. Where a model is connected it argues in its own words; either way the verdict stays with the math.'}
        </p>
      </Card>
    </div>
  );
}
