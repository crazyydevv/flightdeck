import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PiAirplaneTiltFill } from 'react-icons/pi';
import { isUsOpen } from '../core/calendar';
import { squawk } from '../core/tower';
import { Candle, CheckStatus, FlightPlan, Instrument } from '../core/types';
import { HOUR, zulu } from '../core/util';

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

const WORD: Record<CheckStatus, string> = { pass: 'Pass', caution: 'Caution', fail: 'Fail' };

/** Status is always a word next to the colour, never the colour alone. */
export function Status({ status, children }: { status: CheckStatus; children?: ReactNode }) {
  return <span className={`status status-${status}`}><i aria-hidden="true" />{children ?? WORD[status]}</span>;
}

export function Card({ title, aside, children, className = '', icon }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <h2>{icon}{title}</h2>
          {aside && <span className="card-aside">{aside}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Split-flap text, as on a station departure board. Each character sits on its
 * own tile and flips when it changes.
 */
export function Flap({ text, tone = 'amber', pad = 0, delay = 0 }: { text: string; tone?: 'amber' | 'ivory' | 'go' | 'stop'; pad?: number; delay?: number }) {
  const chars = text.toUpperCase().padEnd(pad, ' ').split('');
  return (
    <span className={`flap flap-${tone}`} aria-label={text}>
      {chars.map((ch, i) => (
        <span key={`${i}-${ch}`} className="flap-cell" aria-hidden="true" style={{ animationDelay: `${delay + i * 35}ms` }}>{ch === ' ' ? ' ' : ch}</span>
      ))}
    </span>
  );
}

/** A barcode drawn from a hash: every bar's width comes from one hex digit. */
export function Barcode({ hash, height = 34 }: { hash: string; height?: number }) {
  const digits = (hash.replace(/[^0-9a-f]/gi, '') || '0').slice(0, 40).split('').map((d) => parseInt(d, 16));
  let x = 0;
  const bars = digits.map((d, i) => {
    const w = 1 + (d % 4);
    const gap = 1 + (d >> 2);
    const bar = <rect key={i} x={x} y={0} width={w} height={height} />;
    x += w + gap;
    return bar;
  });
  return <svg className="barcode" viewBox={`0 0 ${x} ${height}`} preserveAspectRatio="none" role="img" aria-label="Barcode of the decision hash">{bars}</svg>;
}

export type PassState = 'CLEARED' | 'REFUSED' | 'AIRBORNE' | 'LANDED';
const BAND: Record<PassState, string> = { CLEARED: 'Cleared for take-off', REFUSED: 'Denied boarding', AIRBORNE: 'Airborne', LANDED: 'Landed' };

/**
 * The boarding pass: one per Tower decision. The barcode and squawk are derived
 * from the decision's hash, so two passes are never the same.
 */
export function Pass({ plan, inst, state, hash, seq, at, reasons, children }: {
  plan: FlightPlan; inst: Instrument; state: PassState; hash?: string; seq?: number; at?: number; reasons?: string[]; children?: ReactNode;
}) {
  const px = (x?: number) => (x === undefined ? 'none' : x.toFixed(inst.pricePlace));
  const code = `${inst.base}${Math.round(plan.leverage)}${plan.side === 'long' ? 'L' : 'S'}`;
  return (
    <article className={`pass pass-${state.toLowerCase()}`}>
      <header className="pass-band">
        <span>FLIGHTDECK pass</span>
        <b>{BAND[state]}</b>
      </header>
      <div className="pass-body">
        <div className="pass-main">
          <div className="pass-route">
            <div><span>Entry</span><b>{px(plan.entry)}</b></div>
            <div className="pass-line" aria-hidden="true"><i /><PiAirplaneTiltFill /><i /></div>
            <div><span>Target</span><b>{px(plan.target)}</b></div>
          </div>
          <dl className="pass-grid">
            <div><dt>Flight</dt><dd>{code}</dd></div>
            <div><dt>{plan.origin === 'agent' ? 'Agent' : 'Filed by'}</dt><dd>{plan.origin === 'agent' ? plan.agentId : 'Pilot'}</dd></div>
            <div><dt>Leverage</dt><dd>{plan.leverage}x</dd></div>
            <div><dt>Margin, USDT</dt><dd>{plan.margin}</dd></div>
            <div><dt>Stop</dt><dd>{px(plan.stop)}</dd></div>
            <div><dt>Hold</dt><dd>{plan.horizonH}h</dd></div>
          </dl>
        </div>
        <div className="pass-stub">
          <div><span>Squawk</span><b>{hash && /^[0-9a-f]{6}/i.test(hash) ? squawk(hash) : '----'}</b></div>
          {hash && <Barcode hash={hash} />}
          <span className="pass-hash">{hash ? hash.slice(0, 16) : 'not filed'}</span>
          <span className="pass-when">{at ? zulu(at) : ''}{seq ? ` · entry ${seq}` : ''}</span>
        </div>
      </div>
      {reasons && reasons.length > 0 && <p className="pass-why">Broke: {reasons.join(' · ')}</p>}
      {children}
    </article>
  );
}

export interface Level { y: number; label: string; kind: 'entry' | 'sel' | 'warn'; /** keep on the scale however far it is */ pin?: boolean }

/**
 * One price series over time. Session hours are shaded so the contrast between
 * a shut market and an open one is visible. Hover or drag for exact values.
 * With `plane`, the newest point is drawn as an aircraft on its heading.
 */
export function PriceChart({ candles, levels = [], sessions = false, height = 180, place = 2, mark, plane = false }: {
  candles: Candle[]; levels?: Level[]; sessions?: boolean; height?: number; place?: number; mark?: number; plane?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (candles.length < 2) return <div ref={ref} className="chart chart-empty" style={{ height }}>Waiting for the first closed hour.</div>;

  const longest = Math.max(8, ...levels.map((l) => l.label.length + 1 + l.y.toFixed(place).length));
  const padL = 8, padR = Math.round(longest * 6.4) + 12, padT = 14, padB = 22;
  const w = Math.max(240, width), h = height;
  const t0 = candles[0].t, t1 = candles[candles.length - 1].t + HOUR;
  const lo0 = Math.min(...candles.map((c) => c.l)), hi0 = Math.max(...candles.map((c) => c.h));
  // levels far off the data (a distant liquidation price) must not flatten the line
  const span = hi0 - lo0 || hi0 * 0.01;
  const inRange = levels.filter((l) => l.pin || (l.y > lo0 - span * 1.5 && l.y < hi0 + span * 1.5));
  const lo = Math.min(lo0, ...inRange.map((l) => l.y)), hi = Math.max(hi0, ...inRange.map((l) => l.y));
  const pad = (hi - lo) * 0.08 || hi * 0.005;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (w - padL - padR);
  const y = (p: number) => padT + (1 - (p - (lo - pad)) / (hi - lo + 2 * pad)) * (h - padT - padB);
  const pts = candles.map((c) => [x(c.t + HOUR), y(c.c)] as const);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${h - padB}L${pts[0][0].toFixed(1)},${h - padB}Z`;

  const bands: { a: number; b: number }[] = [];
  if (sessions) {
    let start: number | null = null;
    for (const c of candles) {
      const open = isUsOpen(c.t + HOUR / 2);
      if (open && start === null) start = c.t;
      if (!open && start !== null) { bands.push({ a: start, b: c.t }); start = null; }
    }
    if (start !== null) bands.push({ a: start, b: t1 });
  }

  // keep level labels from sitting on top of each other
  const labels = inRange.map((l) => ({ ...l, ly: y(l.y) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labels.length; i++) if (labels[i].ly - labels[i - 1].ly < 13) labels[i].ly = labels[i - 1].ly + 13;
  const off = levels.filter((l) => !inRange.includes(l));

  const pick = (clientX: number, target: Element) => {
    const r = target.getBoundingClientRect();
    const t = t0 + ((clientX - r.left - padL) / (w - padL - padR)) * (t1 - t0);
    setHover(Math.max(0, Math.min(candles.length - 1, Math.floor((t - t0) / HOUR))));
  };
  const hc = hover !== null ? candles[hover] : null;
  const last = candles[candles.length - 1];
  const end = pts[pts.length - 1], prev = pts[Math.max(0, pts.length - 3)];
  const heading = (Math.atan2(end[1] - prev[1], end[0] - prev[0]) * 180) / Math.PI;

  return (
    <div ref={ref} className="chart">
      <svg width={w} height={h} role="img" aria-label={`Hourly price, ${candles.length} hours, last ${last.c.toFixed(place)}`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)} onPointerDown={(e) => pick(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="chart-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="chart-fade-a" />
            <stop offset="1" className="chart-fade-b" />
          </linearGradient>
        </defs>
        {bands.map((b, i) => <rect key={i} className="chart-session" x={x(b.a)} y={padT} width={Math.max(1, x(b.b) - x(b.a))} height={h - padT - padB} />)}
        {mark !== undefined && mark >= t0 && <line className="chart-mark" x1={x(mark)} x2={x(mark)} y1={padT} y2={h - padB} />}
        {inRange.map((l, i) => <line key={i} className={`chart-level level-${l.kind}`} x1={padL} x2={w - padR} y1={y(l.y)} y2={y(l.y)} />)}
        <path d={area} fill="url(#chart-fade)" />
        <path className="chart-line" d={line} fill="none" />
        {plane
          ? <g className="chart-plane" transform={`translate(${end[0]},${end[1]}) rotate(${heading})`}><path d="M12 0 L-8 -7 L-4 0 L-8 7 Z" /></g>
          : <circle className="chart-end" cx={end[0]} cy={end[1]} r="3.5" />}
        {labels.map((l, i) => <text key={i} className={`chart-tag level-${l.kind}`} x={w - padR + 6} y={l.ly + 3.5}>{l.label} {l.y.toFixed(place)}</text>)}
        {!labels.length && <text className="chart-tag level-entry" x={w - padR + 6} y={end[1] + 3.5}>{last.c.toFixed(place)}</text>}
        <text className="chart-axis" x={padL} y={h - 6}>{zulu(t0)}</text>
        <text className="chart-axis" x={w - padR} y={h - 6} textAnchor="end">{zulu(t1)}</text>
        {hc && <line className="chart-cross" x1={x(hc.t + HOUR)} x2={x(hc.t + HOUR)} y1={padT} y2={h - padB} />}
        {hc && <circle className="chart-dot" cx={x(hc.t + HOUR)} cy={y(hc.c)} r="4" />}
      </svg>
      <div className="chart-read" aria-live="off">
        {hc
          ? <>{zulu(hc.t + HOUR)} <b>{hc.c.toFixed(place)}</b> <span>high {hc.h.toFixed(place)}, low {hc.l.toFixed(place)}{sessions ? `, New York ${isUsOpen(hc.t + HOUR / 2) ? 'open' : 'closed'}` : ''}</span></>
          : <span>{sessions ? 'Shaded: New York session hours. ' : ''}{off.length ? `Off the scale: ${off.map((l) => `${l.label.toLowerCase()} ${l.y.toFixed(place)}`).join(', ')}. ` : ''}Point at the line for values.</span>}
      </div>
    </div>
  );
}

export function Num({ value, onChange, min, max, step, id, label, hint, suffix }: {
  value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; id: string; label: string; hint?: string; suffix?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // follow outside changes (an amendment, a new instrument) without fighting the typist
  useEffect(() => {
    setText((t) => ((value === undefined ? t.trim() === '' : Number(t) === value) ? t : value === undefined ? '' : String(value)));
  }, [value]);
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}{hint && <em>{hint}</em>}</span>
      <span className="field-box">
        <input id={id} type="number" inputMode="decimal" value={text} min={min} max={max} step={step ?? 'any'}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim() === '') return onChange(undefined);
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }} />
        {suffix && <span className="field-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

export function CopyButton({ text, label, className = 'btn' }: { text: () => string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'manual'>('idle');
  const area = useRef<HTMLTextAreaElement | null>(null);
  return (
    <>
      <button type="button" className={className} onClick={async () => {
        try { await navigator.clipboard.writeText(text()); setState('done'); setTimeout(() => setState('idle'), 1800); }
        catch { setState('manual'); setTimeout(() => area.current?.select(), 30); }
      }}>{state === 'done' ? 'Copied' : label}</button>
      {state === 'manual' && <textarea ref={area} className="copy-fallback" readOnly rows={5} defaultValue={text()} aria-label="Select and copy this text" />}
    </>
  );
}
