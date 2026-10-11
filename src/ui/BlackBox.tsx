import { useState } from 'react';
import { PiKey } from 'react-icons/pi';
import { covered } from '../core/blackbox';
import { logbookCsv } from '../core/flight';
import { describeRule } from '../core/tower';
import { fmtPct, fmtUsd, zulu } from '../core/util';
import { Card, CopyButton } from './bits';
import { DeckApi } from './store';

function OwnKey({ api }: { api: DeckApi }) {
  const { byok, actions, busy, server } = api;
  const [key, setKey] = useState(byok?.key ?? '');
  const [secret, setSecret] = useState(byok?.secret ?? '');
  const [pass, setPass] = useState(byok?.passphrase ?? '');
  const [demo, setDemo] = useState(byok?.demo ?? false);
  const [remember, setRemember] = useState(Boolean(byok));
  const [msg, setMsg] = useState<string | null>(null);
  const ready = key.trim() && secret.trim() && pass.trim();
  const k = { key: key.trim(), secret: secret.trim(), passphrase: pass.trim(), demo };

  return (
    <Card title="Bring your own Bitget key" icon={<PiKey aria-hidden="true" />} aside={byok ? 'key loaded' : 'optional'}>
      <p>
        Paste a Bitget API key and the Black Box reads your real closed futures positions from the last 90 days, then runs the autopsy on them.
        A read-only key is enough. Tick demo if it is a Demo Trading key; a demo key can also place the cleared order when the feed is Live.
      </p>
      <form className="keyform" onSubmit={async (e) => { e.preventDefault(); actions.setByok(k, remember); setMsg(await actions.pullHistory(k)); }}>
        <label className="field" htmlFor="k-key"><span className="field-label">API key</span><span className="field-box"><input id="k-key" type="text" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} /></span></label>
        <label className="field" htmlFor="k-secret"><span className="field-label">Secret</span><span className="field-box"><input id="k-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" /></span></label>
        <label className="field" htmlFor="k-pass"><span className="field-label">Passphrase</span><span className="field-box"><input id="k-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" /></span></label>
        <div className="ticks">
          <label htmlFor="k-demo"><input id="k-demo" type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /> This is a Demo Trading key</label>
          <label htmlFor="k-rem"><input id="k-rem" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember it in this browser</label>
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={!ready || Boolean(busy)}>{busy ?? 'Read my history'}</button>
          {byok && <button type="button" className="btn" onClick={() => { actions.setByok(null, false); setKey(''); setSecret(''); setPass(''); setMsg('Key forgotten on this device.'); }}>Forget the key</button>}
        </div>
        {msg && <p className="readback" role="status">{msg}</p>}
      </form>
      <p className="fine">
        The key is sent to this app's server for one request, used to sign two read calls to Bitget, and dropped. The server does not store or log it.
        {server ? ' Visitor keys can only place demo orders, never real-money ones.' : ' This page has no server behind it, so the key cannot be used here; run the deployed app.'}
      </p>
    </Card>
  );
}

export function BlackBox({ api }: { api: DeckApi }) {
  const { deck, post, whatIf, actions, market, openLeaks } = api;
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const have = new Set(deck.rules.map((r) => r.id));
  const sampleCount = deck.logbook.filter((f) => f.venue === 'sample').length;
  const real = deck.logbook.filter((f) => f.venue === 'bitget-history').length;
  const rows = [...deck.logbook].sort((a, b) => b.openedAt - a.openedAt);
  const base = (s: string) => market.instruments[s]?.base ?? s.replace(/USDT$/, '');

  return (
    <div className="view">
      <header className="view-head">
        <h1>Black Box</h1>
        <p>The Black Box reads the logbook for habits that cost money. Each one it finds becomes a rule the Tower enforces on the next flight, so the deck gets stricter exactly where you leak.</p>
      </header>

      {sampleCount > 0 && (
        <p className="banner">
          This is a sample logbook: {sampleCount} invented flights with bad habits planted in it, so there is something to read on first launch.
          Bring your Bitget key or paste a CSV below to replace it with your own.
        </p>
      )}
      {real > 0 && <p className="banner banner-go">Reading {real} closed positions from your own Bitget account.</p>}

      <Card title="Autopsy" aside={`${post.flights} flights`} className="card-glass">
        <dl className="readouts readouts-big">
          <div><dt>Net result</dt><dd className={post.net >= 0 ? 'up' : 'down'}>{fmtUsd(post.net)} USDT</dd></div>
          <div><dt>Flights won</dt><dd>{fmtPct(post.winRate, 0, false)}</dd></div>
          <div><dt>Refused by today's Tower</dt><dd>{whatIf.refused.length} of {post.flights}</dd></div>
          <div><dt>Result without them</dt><dd className={whatIf.keptNet >= 0 ? 'up' : 'down'}>{fmtUsd(whatIf.keptNet)} USDT</dd></div>
        </dl>
        <p className="fine">The last two figures re-fly the logbook through the Tower as it stands now and drop every flight it would refuse. That assumes a refused flight is simply not flown, which flatters the result.</p>

        <ul className="leaks">
          {post.leaks.map((l, i) => {
            const adopted = l.proposal && have.has(l.proposal.id);
            const dup = l.proposal && !adopted && covered(deck.rules, l.proposal);
            return (
              <li key={l.id} className={l.proposal ? 'is-leak' : ''} style={{ animationDelay: `${i * 70}ms` }}>
                <div className="leak-head">
                  <b>{l.title}</b>
                  <span className={`num ${l.cost < 0 ? 'down' : ''}`}>{l.count ? `${fmtUsd(l.cost)} USDT` : 'none found'}</span>
                </div>
                <p>{l.summary}</p>
                {l.proposal
                  ? (
                    <div className="actions">
                      {adopted ? <span className="tag tag-deck">in the Tower</span>
                        : dup ? <span className="tag">already a Tower rule</span>
                        : <button type="button" className="btn btn-deck" onClick={() => actions.adoptRules([l.proposal!])}>Write this into the Tower</button>}
                      <span className="fine">Rule: {describeRule(l.proposal)}.</span>
                    </div>
                  )
                  : l.count > 0 && <p className="fine">Not enough evidence for a rule: it needs at least three flights that lost money together.</p>}
              </li>
            );
          })}
        </ul>
        {openLeaks.length > 1 && (
          <div className="actions">
            <button type="button" className="btn btn-deck btn-big" onClick={() => actions.adoptRules(openLeaks.map((l) => l.proposal!))}>Write all {openLeaks.length} rules into the Tower</button>
          </div>
        )}
      </Card>

      <OwnKey api={api} />

      <Card title="Logbook" aside={`${rows.length} flights, newest first`}>
        <div className="scroll-x tall">
          <table className="tbl">
            <thead><tr><th>Flight</th><th>Opened, Zulu</th><th>Pair</th><th>Side</th><th>Lev</th><th>Margin</th><th>Result</th><th>How it ended</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td className="mono">{f.id}</td>
                  <td className="num">{zulu(f.openedAt)}</td>
                  <td>{base(f.symbol)}</td>
                  <td>{f.side}</td>
                  <td className="num">{f.leverage}x</td>
                  <td className="num">{fmtUsd(f.margin, 0)}</td>
                  <td className={`num ${(f.pnl ?? 0) >= 0 ? 'up' : 'down'}`}>{fmtUsd(f.pnl ?? 0)}</td>
                  <td>{f.outcome}{f.venue === 'sample' ? ', sample' : f.venue === 'bitget-history' ? ', your account' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <CopyButton label="Copy the trading log as CSV" text={() => logbookCsv(deck.logbook, deck.startEquity)} />
          {sampleCount > 0 && <button type="button" className="btn" onClick={actions.clearSample}>Remove the sample flights</button>}
        </div>

        <form className="import" onSubmit={(e) => { e.preventDefault(); setMsg(actions.importLogbook(csv)); }}>
          <label htmlFor="csv">Or paste a CSV</label>
          <p className="fine">A header row, then one closed trade per row with time, symbol, side, entry price, quantity and pnl. Leverage, margin, exit and stop are read if present.</p>
          <textarea id="csv" rows={3} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} placeholder="time,symbol,side,price,quantity,leverage,pnl" />
          <div className="actions">
            <button type="submit" className="btn" disabled={!csv.trim()}>Import and run the autopsy</button>
            <input id="csv-file" type="file" accept=".csv,text/csv,text/plain" aria-label="Choose a CSV file"
              onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
          </div>
          {msg && <p className="readback" role="status">{msg}</p>}
        </form>
      </Card>
    </div>
  );
}
