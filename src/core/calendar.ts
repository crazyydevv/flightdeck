// US cash-equity session clock. Bitget stock perps trade around the clock, the
// shares they track do not: 09:30 to 16:00 New York time, Monday to Friday.
// Everything the Radar and Preflight say about "off-hours" comes from here.

import { HOUR } from './util';

const SLOT = HOUR / 2;

// NYSE full-day closures. Half days are treated as full sessions.
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export interface NyTime {
  date: string;
  weekday: string;
  minutes: number;
}

export function nyTime(t: number): NyTime {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isUsOpen(t: number): boolean {
  const ny = nyTime(t);
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return false;
  if (HOLIDAYS.has(ny.date)) return false;
  return ny.minutes >= 9 * 60 + 30 && ny.minutes < 16 * 60;
}

const floorSlot = (t: number) => Math.floor(t / SLOT) * SLOT;

/** The most recent closing bell at or before t. */
export function lastUsClose(t: number): number {
  let s = floorSlot(t);
  // while inside a session, walk back to before it opened
  for (let i = 0; i < 700 && isUsOpen(s); i++) s -= SLOT;
  // then walk back to the last open slot of the previous session
  for (let i = 0; i < 700 && !isUsOpen(s); i++) s -= SLOT;
  return s + SLOT;
}

/** The next opening bell strictly after t. */
export function nextUsOpen(t: number): number {
  let s = floorSlot(t) + SLOT;
  // an opening bell is an open slot that follows a closed one
  for (let i = 0; i < 700 && !(isUsOpen(s) && !isUsOpen(s - SLOT)); i++) s += SLOT;
  return s;
}

/** The opening bell of the session containing t (t must be inside a session). */
export function sessionOpen(t: number): number {
  let s = floorSlot(t);
  for (let i = 0; i < 20 && isUsOpen(s - SLOT); i++) s -= SLOT;
  return s;
}

/** How many opening bells fall inside (from, to]. Each one is a possible gap. */
export function opensBetween(from: number, to: number): number {
  let n = 0;
  let t = from;
  for (let i = 0; i < 60; i++) {
    const next = nextUsOpen(t);
    if (next > to) break;
    n++;
    t = next;
  }
  return n;
}

export type SessionPhase = 'regular' | 'pre-market' | 'after-hours' | 'overnight' | 'weekend' | 'holiday';

/**
 * Which part of the US day it is. Pre-market (04:00 to 09:30) and after-hours
 * (16:00 to 20:00) have some share trading behind the perp; overnight, weekends
 * and holidays have none, so the perp is pricing on its own.
 */
export function sessionPhase(t: number): SessionPhase {
  if (isUsOpen(t)) return 'regular';
  const ny = nyTime(t);
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return 'weekend';
  if (HOLIDAYS.has(ny.date)) return 'holiday';
  if (ny.minutes >= 4 * 60 && ny.minutes < 9 * 60 + 30) return 'pre-market';
  if (ny.minutes >= 16 * 60 && ny.minutes < 20 * 60) return 'after-hours';
  return 'overnight';
}

const PHASE_TEXT: Record<SessionPhase, string> = {
  regular: 'New York open', 'pre-market': 'Pre-market', 'after-hours': 'After hours',
  overnight: 'Overnight', weekend: 'Weekend', holiday: 'Market holiday',
};

export function sessionLabel(t: number): { open: boolean; text: string; until: number; phase: SessionPhase; phaseText: string } {
  const open = isUsOpen(t);
  const phase = sessionPhase(t);
  if (open) {
    let s = floorSlot(t);
    for (let i = 0; i < 20 && isUsOpen(s); i++) s += SLOT;
    return { open, text: 'New York open', until: s, phase, phaseText: PHASE_TEXT[phase] };
  }
  return { open, text: 'New York closed', until: nextUsOpen(t), phase, phaseText: PHASE_TEXT[phase] };
}

export function hoursMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
