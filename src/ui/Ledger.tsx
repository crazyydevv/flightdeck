import { useEffect, useState } from 'react';
import { verifyLedger } from '../core/tower';
import { FlightPlan, LedgerEntry } from '../core/types';
import { zulu } from '../core/util';
import { Card, CopyButton, Pass } from './bits';
import { instFor, isLiveTime, PUBLIC_DECK } from './public';
import { DeckApi } from './store';

type Decision = { plan?: FlightPlan; decision?: string; failed?: string[] };

export function passLink(deck: string, seq: number): string {
  const here = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  return `${here}?pass=${deck}.${seq}`;
}

export function shareText(e: LedgerEntry, base: string, link?: string): string {
  const b = e.body as Decision;
  const p = b.plan as FlightPlan;
  const head = b.decision === 'CLEARED'
    ? `Cleared for take-off: ${base} ${p.leverage}x ${p.side}.`
    : `Denied boarding: ${base} ${p.leverage}x ${p.side}. Broke ${b.failed?.length ?? 0} Tower rule${(b.failed?.length ?? 0) === 1 ? '' : 's'}.`;
  return `${head}\nFLIGHTDECK ledger entry ${e.seq}, hash ${e.hash.slice(0, 16)}${link ? `\nVerify: ${link}` : ''}\n#BitgetHackathon`;
}

export function Ledger({ api }: { api: DeckApi }) {
  const { deck, market, server } = api;
  const [check, setCheck] = useState<{ result: number; forged: boolean } | null>(null);
  const ledger = [...deck.ledger].reverse();
  const decisions = ledger.filter((e) => (e.kind === 'clearance' || e.kind === 'refusal') && (e.body as Decision).plan).slice(0, 6);
  const published = Boolean(server?.storage);

  const verify = (forge: boolean) => {
    // the forged copy edits one summary; the stored ledger is never touched
    const copy: LedgerEntry[] = forge && deck.ledger.length
      ? deck.ledger.map((e, i) => (i === 0 ? { ...e, summary: e.summary.replace(/Refused/, 'Cleared') + ' (edited)' } : e))
      : deck.ledger;
    setCheck({ result: verifyLedger(copy), forged: forge });
  };

  return (
    <div className="view">
      <header className="view-head">
        <h1>Ledger</h1>
        <p>Every clearance, refusal, take-off, landing, Night Watch action and new rule is one entry. Each entry's hash includes the one before it, so the record cannot be edited without the chain showing it.</p>
      </header>

      {!deck.ledger.length && <PublicLog own={deck.id} />}

      <Card title="Your deck" aside={`${deck.ledger.length} entries, SHA-256`} className="card-glass">
        {deck.ledger.length ? (
          <>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => verify(false)}>Verify the chain</button>
              <button type="button" className="btn" onClick={() => verify(true)}>Verify a forged copy</button>
              <CopyButton label="Copy ledger JSON" text={() => JSON.stringify(deck.ledger, null, 2)} />
            </div>
            {check && (
              <p className={`readback readback-${check.result === 0 ? 'ok' : 'no'}`} role="status">
                {check.result === 0
                  ? `Chain intact: all ${deck.ledger.length} entries recompute to their recorded hashes.`
                  : `Chain broken at entry ${check.result}. ${check.forged ? 'That is the copy with entry 1 edited; the real ledger is untouched.' : ''}`}
              </p>
            )}
            <div className="scroll-x tall">
              <table className="tbl">
                <thead><tr><th>#</th><th>Zulu</th><th>Entry</th><th>What happened</th><th>Hash</th></tr></thead>
                <tbody>
                  {ledger.map((e) => (
                    <tr key={e.seq}>
                      <td className="num">{e.seq}</td>
                      <td className="num">{zulu(e.at)}</td>
                      <td><span className={`tag tag-${e.kind}`}>{e.kind}</span> <Feed at={e.at} /></td>
                      <td className="wrap">{e.summary}</td>
                      <td className="mono">{e.hash.slice(0, 12)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fine">
              {published
                ? `Published: ${Math.min(deck.mirrored, deck.ledger.length)} of ${deck.ledger.length} entries are mirrored on the server, which accepts an entry only if it chains from the one before. Deck id ${deck.id}.`
                : 'This ledger lives in your browser. Deployed with storage, each entry is also mirrored on the server so anyone with a pass link can verify it.'}
            </p>
          </>
        ) : (
          <p className="empty">Your deck is empty. It belongs to this browser only, with no sign-up, so a new browser or a private window always starts here. The first clearance or refusal starts your chain. FLIGHTDECK's own trades are in the public deck above.</p>
        )}
      </Card>

      {decisions.length > 0 && (
        <Card title="Boarding passes" aside="one per Tower decision">
          <ul className="passes">
            {decisions.map((e) => {
              const b = e.body as Decision;
              const plan = b.plan as FlightPlan;
              const inst = instFor(plan.symbol, market.instruments);
              const link = published && e.seq <= deck.mirrored ? passLink(deck.id, e.seq) : undefined;
              return (
                <li key={e.seq}>
                  <Pass plan={plan} inst={inst} state={b.decision === 'CLEARED' ? 'CLEARED' : 'REFUSED'} hash={e.hash} seq={e.seq} at={e.at} reasons={b.failed?.slice(0, 3)} />
                  <div className="actions">
                    <CopyButton className="btn btn-small" label="Copy a post for X" text={() => shareText(e, inst.base, link)} />
                    {link && <CopyButton className="btn btn-small" label="Copy the verify link" text={() => link} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {deck.ledger.length > 0 && <PublicLog own={deck.id} />}
    </div>
  );
}

type Published = { entries: LedgerEntry[]; brokenAt: number | null };

/** Which feed an entry came from: recorded entries live inside the recording's clock. */
function Feed({ at }: { at: number }) {
  return isLiveTime(at) ? <span className="tag tag-live">live</span> : <span className="tag tag-recorded">recorded</span>;
}

/** FLIGHTDECK's own deck, read from the server mirror. Read-only for everyone. */
function PublicLog({ own }: { own: string }) {
  const [state, setState] = useState<Published | 'error' | null>(null);
  const [liveOnly, setLiveOnly] = useState(true);
  useEffect(() => {
    if (own === PUBLIC_DECK) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch(`api/ledger?deck=${PUBLIC_DECK}`);
        const j = r.ok ? ((await r.json()) as Published) : null;
        if (live) setState(j && Array.isArray(j.entries) ? j : 'error');
      } catch {
        if (live) setState('error');
      }
    })();
    return () => { live = false; };
  }, [own]);
  // on the team's own browser the deck above already is the public deck
  if (own === PUBLIC_DECK || state === null) return null;
  if (state === 'error' || !state.entries.length) {
    return (
      <Card title="FLIGHTDECK's public deck" aside="read-only">
        <p className="empty">The public deck could not be loaded right now. Every pass link we post still opens on its own.</p>
      </Card>
    );
  }
  const all = [...state.entries].reverse();
  const liveCount = all.filter((e) => isLiveTime(e.at)).length;
  const rows = liveOnly ? all.filter((e) => isLiveTime(e.at)) : all;
  const ok = state.brokenAt === 0;
  return (
    <Card title="FLIGHTDECK's public deck" aside={`read-only, ${state.entries.length} entries`} className="card-glass">
      <p className="fine">These are FLIGHTDECK's own decisions, read from the server, not from your browser. Nothing in it can be edited or removed, including by us: the server only accepts a new entry that chains onto the last one. Open any entry to see its pass, re-checked as it loads.</p>
      <p className={`readback readback-${ok ? 'ok' : state.brokenAt === null ? '' : 'no'}`} role="status">
        {ok
          ? `Verified on the server: all ${state.entries.length} entries recompute to their recorded hashes and chain from the first.`
          : state.brokenAt === null
            ? 'Showing the latest window of the chain. Each pass is verified when it opens.'
            : `Chain broken at entry ${state.brokenAt}.`}
      </p>
      <div className="actions">
        <div className="seg seg-small" role="group" aria-label="Which entries">
          <button type="button" aria-pressed={liveOnly} onClick={() => setLiveOnly(true)}>Live trades ({liveCount})</button>
          <button type="button" aria-pressed={!liveOnly} onClick={() => setLiveOnly(false)}>Everything ({all.length})</button>
        </div>
        <p className="fine">Live entries are real Bitget prices on the real clock. Recorded entries are the demo, flown on the 1 to 8 October recording.</p>
      </div>
      <div className="scroll-x tall">
        <table className="tbl">
          <thead><tr><th>#</th><th>Zulu</th><th>Entry</th><th>What happened</th><th>Pass</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.seq}>
                <td className="num">{e.seq}</td>
                <td className="num">{zulu(e.at)}</td>
                <td><span className={`tag tag-${e.kind}`}>{e.kind}</span> <Feed at={e.at} /></td>
                <td className="wrap">{e.summary}</td>
                <td className="mono"><a href={passLink(PUBLIC_DECK, e.seq)}>{e.hash.slice(0, 10)}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
