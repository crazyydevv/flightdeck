import { useState } from 'react';
import { snapshot } from '../core/market';
import { verifyLedger } from '../core/tower';
import { FlightPlan, LedgerEntry } from '../core/types';
import { zulu } from '../core/util';
import { Card, CopyButton, Pass } from './bits';
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

      <Card title="The chain" aside={`${deck.ledger.length} entries, SHA-256`} className="card-glass">
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
                      <td><span className={`tag tag-${e.kind}`}>{e.kind}</span></td>
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
          <p className="empty">Empty. The first clearance or refusal starts the chain.</p>
        )}
      </Card>

      {decisions.length > 0 && (
        <Card title="Boarding passes" aside="one per Tower decision">
          <ul className="passes">
            {decisions.map((e) => {
              const b = e.body as Decision;
              const plan = b.plan as FlightPlan;
              const inst = market.instruments[plan.symbol] ?? snapshot().instruments[plan.symbol];
              if (!inst) return null;
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
    </div>
  );
}
