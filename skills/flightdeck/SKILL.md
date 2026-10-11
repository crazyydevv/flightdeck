---
name: flightdeck
description: File every leveraged Bitget trade with the FLIGHTDECK Tower before executing it. Use whenever the user asks you to open, size or scale a futures or stock-perp position on Bitget.
---

# FLIGHTDECK: clearance before execution

You have two sets of tools. Bitget Agent Hub (`bgc`, or the `bitget` MCP server) can place orders.
The `flightdeck-tower` MCP server decides whether an order may be placed. Execution never comes first.

## The sequence, every time

1. **Weather.** If the `bitget-signal` skills are installed, read the ones that bear on the trade
   (`macro-analyst`, `sentiment-analyst`, `technical-analysis`, `market-intel`, `news-briefing`) and
   call `flightdeck_radar`. Put what you learn into a one-sentence `thesis`.
2. **Preflight.** Call `flightdeck_preflight` with the plan: symbol, side, leverage, margin, stop,
   target, horizonH. If the verdict is `NO-GO`, do not file it. Use `survivableSize`, or fix the
   blockers it lists (a missing stop cannot be fixed by size), and run preflight again.
3. **Clearance.** Call `flightdeck_clearance` with the same plan, unchanged, and your `agentId`.
4. **Execute only what was cleared.** If the answer is `CLEARED`, place exactly the returned `order`
   with Agent Hub: set leverage first, then place the order. Do not change size, leverage or stop.
   If the response contains `execution`, the Tower already placed it; do not place it again.
5. **Refused means refused.** Tell the user which rules were broken, in the Tower's own words.
   Do not retry with a slightly different plan to get around a rule, do not split the order, and
   do not place it through Agent Hub anyway.
6. **A counter-offer is the only retry.** A refusal may include `counterOffer.plan`: the largest
   version of the same trade the Tower would clear, sometimes with a stop added. Show it to the
   user. If they accept, run `flightdeck_preflight` and then `flightdeck_clearance` on that plan
   exactly as given. Do not edit it, and do not treat it as cleared until the Tower says so.

## Things you must not do

- Do not invent a preflight result or a clearance. Both come only from the tools.
- Do not treat a refusal as an error to work around. It is the answer.
- Do not use more leverage than the cleared plan because the market "moved in your favour".

## Useful calls

- `flightdeck_rules` shows the rules in force, including ones learned from the user's own logbook.
- `flightdeck_ledger` verifies the hash chain of every decision the Tower has made.
