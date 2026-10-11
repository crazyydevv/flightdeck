import { PiRobot } from 'react-icons/pi';
import { planHash } from '../core/preflight';
import { offerLine } from '../core/reroute';
import { describeRule, rulesHash } from '../core/tower';
import { zulu } from '../core/util';
import { Card, CopyButton, Pass, Status } from './bits';
import { DeckApi } from './store';

const MCP_SNIPPET = `{
  "mcpServers": {
    "flightdeck-tower": {
      "command": "node",
      "args": ["dist/mcp/tower.mjs"]
    }
  }
}`;

export function Tower({ api }: { api: DeckApi }) {
  const { deck, plan, route, market, actions, busy, isLive, server, byok } = api;
  const filed = deck.filed;
  const filedInst = filed ? market.instruments[filed.plan.symbol] : undefined;
  const failed = filed ? filed.clearance.findings.filter((f) => !f.ok) : [];
  const current = Boolean(filed && filed.clearance.planHash === planHash(plan) && filed.plan.origin === 'pilot');
  const learned = deck.rules.filter((r) => r.source === 'blackbox');
  const entry = filed ? deck.ledger[filed.seq - 1] : undefined;
  const willTrade = isLive && ((byok && byok.demo) || (server && server.trading !== 'paper'));

  return (
    <div className="view">
      <header className="view-head">
        <h1>Tower</h1>
        <p>The Tower is plain code. It reads the plan, the rules and the logbook, and answers cleared or refused. No model can talk it round, and every answer is chained into the ledger.</p>
      </header>

      {filed && filedInst ? (
        <div className="cols cols-tower" key={filed.seq}>
          <div className="stack">
            <Pass plan={filed.plan} inst={filedInst} state={filed.clearance.decision} hash={entry?.hash ?? filed.clearance.planHash} seq={filed.seq} at={filed.clearance.at}
              reasons={failed.length ? failed.map((f) => f.title) : undefined} />
            <div className="actions">
              {filed.clearance.decision === 'CLEARED' && current && (
                <button type="button" className="btn btn-primary btn-big" disabled={Boolean(busy)} onClick={actions.takeOff}>
                  {busy ?? (willTrade ? 'Take off on Bitget demo' : 'Take off')}
                </button>
              )}
              {filed.clearance.decision === 'REFUSED' && filed.plan.origin === 'pilot' && current && route.ok && (
                <button type="button" className="btn btn-deck btn-big" onClick={() => actions.reroute()}>Re-route to {route.plan.leverage}x and clear it</button>
              )}
              {filed.clearance.decision === 'REFUSED' && filed.plan.origin === 'pilot' && (
                <button type="button" className="btn" onClick={() => actions.go('preflight')}>Back to the plan</button>
              )}
              <button type="button" className="btn" onClick={() => actions.go('ledger')}>See it in the ledger</button>
            </div>
            {filed.clearance.decision === 'REFUSED' && filed.plan.origin === 'pilot' && current && (
              <div className={`reroute ${route.ok ? '' : 'is-blocked'}`}>
                <b>{route.ok ? 'Re-route' : 'No route'}</b>
                <p>{offerLine(route, filedInst.base)} {route.ok ? 'Same instrument, same side, same hold. One click files it and issues the pass.' : ''}</p>
              </div>
            )}
            {filed.clearance.decision === 'CLEARED' && current && deck.firstFiled && (deck.firstFiled.leverage !== filed.plan.leverage || deck.firstFiled.margin !== filed.plan.margin) && (
              <div className="reroute">
                <b>Re-routed</b>
                <p>
                  Planned at {deck.firstFiled.leverage}x on {deck.firstFiled.margin} USDT, which the Tower would not clear. Cleared at {filed.plan.leverage}x on {filed.plan.margin} USDT.
                  When it lands, the flight is compared with the size first filed over the same hours.
                </p>
              </div>
            )}
            {filed.offer && (
              <div className={`reroute ${filed.offer.startsWith('No size') ? 'is-blocked' : ''}`}>
                <b>{filed.offer.startsWith('No size') ? 'No counter-offer' : 'Counter-offer'}</b>
                <p>{filed.offer}</p>
              </div>
            )}
          </div>
          <Card title="Rule by rule" aside={zulu(filed.clearance.at)}>
            <ul className="findings">
              {filed.clearance.findings.map((f, i) => (
                <li key={f.ruleId} className={f.ok ? '' : 'is-broken'} style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
                  <Status status={f.ok ? 'pass' : 'fail'}>{f.ok ? 'Holds' : 'Broken'}</Status>
                  <div><b>{f.title}</b>{f.source === 'blackbox' && <span className="tag tag-deck">learned</span>}<p>{f.detail}</p></div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : (
        <Card className="card-glass">
          <div className="empty">
            <p>Nothing on the desk. File the current plan, or watch the Tower handle an agent that asks for too much.</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={actions.requestClearance}>Request clearance for the current plan</button>
              <button type="button" className="btn" onClick={actions.rogueAgent}><PiRobot aria-hidden="true" /> Send a reckless agent order</button>
            </div>
          </div>
        </Card>
      )}

      <div className="cols cols-even">
        <Card title="Agent door" aside="MCP" icon={<PiRobot aria-hidden="true" />}>
          <p>Any agent that speaks MCP files its orders here first. Only a cleared plan is handed to Bitget Agent Hub for execution. Agents get a lower leverage cap than the pilot, cannot pick their own entry price, and cannot skip preflight. A refused agent is sent the version of its order the Tower would clear.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={actions.rogueAgent}>Send a reckless agent order</button>
          </div>
          <details className="code">
            <summary>Connect an agent</summary>
            <pre>{MCP_SNIPPET}</pre>
            <p className="fine">Tools: flightdeck_radar, flightdeck_preflight, flightdeck_clearance, flightdeck_rules, flightdeck_ledger. Build with npm run build:mcp.</p>
          </details>
        </Card>

        <Card title="Pilot licence" aside={`ruleset ${rulesHash(deck.rules).slice(0, 10)}`}>
          <ul className="rules">
            {deck.rules.map((r) => (
              <li key={r.id}>
                <div>
                  <b>{describeRule(r)}</b>
                  {r.source === 'blackbox'
                    ? <p><span className="tag tag-deck">learned</span> {r.evidence}</p>
                    : <p><span className="tag">charter</span></p>}
                </div>
                {r.source === 'blackbox' && <button type="button" className="btn btn-small" onClick={() => actions.removeRule(r.id)} aria-label={`Remove rule: ${r.title}`}>Remove</button>}
              </li>
            ))}
          </ul>
          <p className="fine">
            {learned.length
              ? `${learned.length} of these rules were written by the Black Box from your own logbook.`
              : 'Charter rules only. The Black Box adds restrictions as it finds habits that cost you money.'}
          </p>
          <div className="actions">
            <CopyButton label="Copy licence JSON" text={() => JSON.stringify({ rulesHash: rulesHash(deck.rules), rules: deck.rules }, null, 2)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
