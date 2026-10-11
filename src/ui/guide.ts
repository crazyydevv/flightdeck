// The flight director: reads the deck's state and says what to do next, with
// one button that does it. "Play it for me" presses that button on a timer.

import { DeckApi, ownFlights } from './store';

export interface Step {
  n: number;
  text: string;
  cta?: string;
  run?: () => void;
  /** something is in progress; autoplay waits */
  wait?: boolean;
  /** the loop is complete; autoplay stops here */
  done?: boolean;
}

export const STEPS = 7;

export function nextStep(api: DeckApi): Step {
  const { deck, plan, report, route, inst, actions, isLive, atEnd, openLeaks, market } = api;
  const g = report.guidance;
  const flown = ownFlights(deck);

  if (deck.airborne.length) {
    const f = deck.airborne[0];
    if (deck.flying) return { n: 5, text: `Flying ${f.id} through the recorded hours. Night Watch checks it after every one.`, wait: true };
    if (isLive) return { n: 5, text: `${f.id} is airborne on live prices${f.watch ? ', with Night Watch minding it' : ''}. Land it whenever you like.`, wait: true };
    if (atEnd) return { n: 5, text: 'The recording ends here. Bring the flight down.', cta: 'Land now', run: () => actions.landNow(f.id) };
    return { n: 5, text: `${f.id} is airborne. Fly it through hours the engines never saw.`, cta: 'Fly the recording', run: () => actions.fly(true) };
  }

  if (deck.filed && deck.filed.plan.origin === 'pilot') {
    const c = deck.filed.clearance;
    if (c.decision === 'CLEARED') return { n: 4, text: `Cleared at ${deck.filed.plan.leverage}x. Your boarding pass is issued.`, cta: 'Take off', run: () => void actions.takeOff() };
    const why = c.findings.filter((f) => !f.ok).map((f) => f.title);
    if (route.ok) return { n: 3, text: `Refused at ${deck.filed.plan.leverage}x on ${why.length} rule${why.length > 1 ? 's' : ''}. The Tower will clear the same trade at ${route.plan.leverage}x${route.plan.margin !== plan.margin ? ` on ${route.plan.margin} USDT` : ''}.`, cta: `Re-route to ${route.plan.leverage}x`, run: () => actions.reroute() };
    return { n: 3, text: `The Tower refused this plan and no size fixes it: ${route.blockers.join('; ').toLowerCase()}.`, cta: 'Back to the plan', run: () => actions.go('preflight') };
  }

  if (deck.filed?.plan.origin === 'agent' && !flown.length) {
    const broken = deck.filed.clearance.findings.filter((f) => !f.ok).length;
    return { n: 7, text: `The agent was refused on ${broken} rules and sent a counter-offer. The refusal is hashed into the ledger. Now fly one yourself.`, cta: 'Play the whole loop', run: () => actions.scenario('overnight'), done: true };
  }

  if (flown.length) {
    if (openLeaks.length) {
      if (deck.tab !== 'blackbox') return { n: 6, text: 'Landed. The Black Box has read the logbook and found habits that cost money.', cta: 'Open the Black Box', run: () => actions.go('blackbox') };
      return { n: 6, text: `${openLeaks.length} leaks found. Turn each one into a rule the Tower enforces.`, cta: `Write ${openLeaks.length} rules into the Tower`, run: () => actions.adoptRules(openLeaks.map((l) => l.proposal!)) };
    }
    if (!deck.guide.agentTried) return { n: 7, text: 'Last test. An AI agent asks for 25x on MSTR with no stop.', cta: 'Send the agent order', run: actions.rogueAgent };
    return { n: 7, text: 'That is the whole loop: plan, clearance, flight, recording, stricter rules. Now fly your own.', cta: 'Plan another flight', run: () => actions.go('preflight'), done: true };
  }

  if (deck.tab !== 'preflight' && deck.tab !== 'tower' && !deck.ledger.length) {
    const sym = market.instruments[deck.selected] ? deck.selected : inst.symbol;
    const base = market.instruments[sym].base;
    return { n: 1, text: `Pick a contract from the board. ${base} is listed at ${market.instruments[sym].maxLever}x on Bitget.`, cta: `Plan a 20x long on ${base}`, run: () => actions.fileFor(sym, 'long') };
  }
  if (report.verdict === 'NO-GO') {
    const fails = report.checks.filter((c) => c.status === 'fail').length;
    if (g.fixable) return { n: 2, text: `Preflight says NO-GO at ${plan.leverage}x: ${fails} of 8 checks fail. File it anyway and see what the Tower does.`, cta: `Request clearance at ${plan.leverage}x`, run: actions.requestClearance };
    return { n: 2, text: `No position size fixes this plan: ${g.blockers.join(', ').toLowerCase()}. Edit the plan.`, cta: deck.tab === 'preflight' ? undefined : 'Open the plan', run: deck.tab === 'preflight' ? undefined : () => actions.go('preflight') };
  }
  return { n: 3, text: `No failed check at ${plan.leverage}x. Now ask the Tower.`, cta: 'Request clearance', run: actions.requestClearance };
}

/** Has autoplay reached the point where this scenario hands the controls back? */
export function reachedStop(api: DeckApi): boolean {
  const { deck } = api;
  const at = deck.guide.stopAt;
  if (at === 'cleared') return deck.filed?.clearance.decision === 'CLEARED';
  if (at === 'landed') return ownFlights(deck).length > 0 && !deck.airborne.length;
  return false;
}
