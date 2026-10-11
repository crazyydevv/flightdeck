# FLIGHTDECK: the study

**95,886 trade plans on 40 days of real Bitget candles, every decision made without seeing the
future, and every result re-derived a second way.**

The demo shows two trades. Two trades prove nothing: they could have been picked. This study
replaces them with every trade the recorded data allows, and reports what FLIGHTDECK got right,
what it got wrong, and what the data cannot say either way.

Every figure here is copied from [research/RESULTS.md](../research/RESULTS.md) or
[research/AUDIT.md](../research/AUDIT.md), which `npm run study` prints. The commit that adds
this study changes no engine file in `src/core/`; the only change there is two corrected rows of
recorded data, described in section 2.

---

## The short version

| Question | Answer | Section |
|---|---|---|
| How often is a 50x plan with the app's default stop liquidated? | **24.2%** of the time within a day, **50.7%** within three days | [4.1](#41-ruin) |
| What did Preflight say beforehand? | 25.3% on average for the day. It had the rate right. It could not say which days or contracts would be worse | [4.2](#42-were-the-forecasts-right) |
| What about the plan the app opens with (20x, three days, stop 2.5%)? | Never liquidated as filed. But 37.9% of those trades lost more than 2% of the account each | [4.1](#41-ruin) |
| Was any re-routed flight liquidated? | None in any of the three tests. That is the lower leverage at work, in a sample with no large gap | [4.1](#41-ruin) |
| Do the runway thresholds line up with what happened? | For plans with no stop: 94% of liquidations were in plans the check fails, 6% in plans it cautions, none in plans it passes | [4.3](#43-do-the-thresholds-line-up-with-what-happened) |
| What does a month of the 50x habit cost? | 7.8 liquidations and a median loss of 1,478 USDT on a 10,000 account. Re-routed: none, and 114 USDT | [4.4](#44-a-month-of-the-habit) |
| What does the smaller size cost? | It keeps 28% to 29% of the gains and 26% to 27% of the losses. It makes a trade smaller, not better | [4.5](#45-what-the-smaller-size-costs) |
| Is the re-route better than "never more than 6x"? | Same average result in all three tests. Better worst cases when the plan had no stop, worse when it had a fixed one | [4.6](#46-is-it-more-than-use-less-leverage) |
| Does Night Watch earn its keep? | Not on the average, which is slightly negative once its own exits are charged slippage. It trims the worst outcomes of the flights it touches and costs some winners | [4.7](#47-night-watch) |

**What this adds up to.** FLIGHTDECK told the trader the right odds, sized the trade so that
nothing it cleared was liquidated, and charged a price for that which is now measured. It has no
edge on direction and claims none. Its forecast is a base rate for the kind of plan, not a
signal about timing. A flat leverage cap would have matched its average result. What FLIGHTDECK
adds to a flat cap is the odds in front of you before the trade, a stop where you forgot one,
and a gate that holds you and your agents to the size.

---

## 1. The question

FLIGHTDECK makes one claim: **a leveraged trade should be flown at the largest size that
survives, and that size can be worked out before the trade.** That breaks into four things that
can be measured:

1. When Preflight says a plan has an X% chance of liquidation, is it liquidated about X% of the
   time?
2. Do the verdicts and thresholds line up with which plans blow up?
3. What does the trader give up by taking the smaller size?
4. Is any of this better than the bluntest rule available, a flat leverage cap?

A tool that predicts price would be judged on returns. This one sizes trades, so it is judged on
whether its statements about risk are true.

## 2. The data

| | |
|---|---|
| Source | Bitget public market API, `GET /api/v2/mix/market/history-candles`, USDT-M futures, last-traded prices |
| Contracts | NVDA, TSLA, AAPL, MSFT, MSTR, COIN (stock perps), QQQ (index perp), BTC |
| Hourly bars | 968 per contract, 29 August 2026 11:00 UTC to 8 October 2026 19:00 UTC (40 days) |
| Daily bars | 130 per contract, 31 May to 8 October 2026 |
| Entry hours | 777 per contract for 24-hour holds, 5 September to 7 October (33 calendar days); 729 for 72-hour holds. The first 7 days of candles are history only |
| Files | `research/history-hourly.ts`, `research/history-daily.ts`, plus the app's own `src/core/snapshot-*.ts` |

**Verification.** A miscopied price would quietly corrupt everything after it, so the bars are
checked against each other, and the checks run as tests:

- When recorded, every hourly bar opened exactly at the previous bar's close (the perp never
  stops trading, so Bitget's bars have no gaps between them). The files therefore store high, low
  and close. Every bar's range contains its open and close: 0 failures in 7,744 hourly and 720
  daily bars.
- Daily bars rebuilt from 24 hourly bars equal the daily bars Bitget printed, on open, high, low
  and close, for all 302 days that were recorded independently both ways. The two recordings came
  from separate API calls, so a copying error in either would show up here.
- The app's stored daily bars equal a fresh pull of the same days: 411 of 411.

The second check caught two bars in the app's snapshot that had been recorded before they closed
(MSTR 6 October, BTC 20 September), and a BTC daily series that stopped 17 days early. They were
corrected from the final Bitget values on 9 October. No demo figure changed.

## 3. The method

### 3.1 The plans

At every entry hour, on every contract, a plan is filed long and short at 10x, 20x and 50x
(50x is skipped on MSTR, COIN and QQQ, which Bitget caps at 20x or 25x). Nothing about direction
or timing is chosen: every hour and both sides are in. Each plan commits 400 USDT of margin from
a 10,000 USDT account.

| Test | Plan | Plans |
|---|---|---:|
| **Day** | The stop and target the app fills in by default (2.5% and 6%), held at most 24 hours | 32,634 |
| **Swing** | The same, held at most 72 hours. At 20x this is exactly the plan the app opens with | 30,618 |
| **Naked** | No stop and no target, 24 hours: the plan most blown-up accounts actually filed | 32,634 |
| | | **95,886** |

**The three tests overlap.** They use the same hours and contracts. At 50x a stop 2.5% away lies
beyond the liquidation price and can never fill, so a 50x plan is the same position in the Day
and the Naked test. Results are therefore given per test and not added together: the 8,332
as-filed liquidations across the three tests are 4,671 distinct positions.

### 3.2 No look-ahead

At entry time `t` the engines receive the hourly and daily bars that had **closed** by `t`: up
to 500 hourly and 90 daily bars, which is what the live app requests from Bitget. Entries start
once 168 hourly bars exist, so for the first 332 of 777 entry hours the engines had between 168
and 499 hourly bars behind them. Preflight, the Tower and the re-route see nothing later. The
entry price is the last close before `t`. The flight is then stepped through the following bars
one at a time.

Funding rates are left out of both the checks and the results: the only rates on file were
printed on 8 October, and applying them to September would be reading the future.

Two tests enforce this. One asserts that no bar handed to an engine closes after the entry. The
other rewrites every bar after the entry time, on every contract, to nonsense, and checks that
Preflight and the re-route return exactly what they returned before: if an engine read a later
bar, however indirectly, its answer would change.

### 3.3 Three versions of every plan

| Version | What flies |
|---|---|
| **As filed** | The plan exactly as written |
| **Re-routed** | What `reroute()` returns: the largest version that passes all eight Preflight checks and every Tower rule at that hour. It may lower leverage or margin and add a stop; it never raises anything |
| **Re-routed + Night Watch** | The same, with Night Watch acting after every hourly bar |

A fourth, the **control**, is flown for comparison: the plan as filed with leverage capped at a
flat number (every cap from 2x to 20x is recorded).

The rules in force are the charter the app ships with. Rules the Black Box learns from a
trader's history are not used, and the account-level rules (cooldown, daily loss limit) do not
come into play because each plan is judged on a clean logbook.

### 3.4 How a flight is scored

The same code the app uses (`src/core/flight.ts`): on each hourly bar the stop is tested first
and fills at the stop less slippage (0.2% on stock perps, 0.1% on BTC); then liquidation at the
isolated-margin price; then the target; then the hold time. Taker fees are charged on both
sides. A loss never exceeds the margin.

A second implementation of this, thirty lines that share no code with the first, reproduces the
as-filed result of all 95,886 plans to the cent (`research/audit.ts`, section 1).

### 3.5 Statistics

Trades entered an hour apart overlap and are not independent, and all eight contracts share one
market. Intervals are therefore computed by resampling **whole entry days** (1,000 draws): every
trade entered on a given day, on any contract, stays together. There are 33 such days. The
intervals are approximate: an independent check resampling in two- and three-day blocks gave
19% to 30% for the 50x liquidation rate, against the 19.9% to 28.2% reported here.

"Mean of worst 5%" is the average of the worst twentieth of results (expected shortfall).

---

## 4. Results

Figures are for the **Day** test unless stated. All three tests are in full in
`research/RESULTS.md`.

### 4.1 Ruin

| Filed leverage | Plans | Liquidated as filed | Liquidated re-routed | Mean as filed | Mean re-routed | Worst 5% as filed | Worst 5% re-routed |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10x | 12,432 | 0.0% | 0.0% | -6.43 | -3.66 | -113.03 | -82.61 |
| 20x | 12,432 | 0.0% | 0.0% | -12.85 | -3.63 | -226.07 | -86.74 |
| 50x | 7,770 | **24.2%** | 0.0% | -46.22 | -3.45 | -400.00 | -101.47 |
| All | 32,634 | 5.8% | 0.0% | -18.35 | -3.60 | -400.00 | -89.00 |

Results in USDT per plan. Average re-routed leverage: 6.2x. 5.3% of plans cleared exactly as
filed, 94.7% were re-routed, none was refused at every size.

- **At 50x the plan is liquidated about one day in four** (95% interval 19.9% to 28.2%), and one
  time in two over three days (50.7%; 47.7% to 53.6%). Its stop sits 2.5% away and its
  liquidation price 1.5% away, so the stop can never fill. Preflight's stop check fails every one
  of these plans for exactly that reason.
- **At 10x and 20x, with a working stop, none of 24,864 plans was liquidated inside a day.** What
  grows with leverage there is the size of an ordinary stop-out: 113 USDT at 10x, 226 USDT at
  20x, on 400 USDT of margin. Held three days at 20x (the plan the app opens with), 37.9% of
  trades lost more than 2% of the account. One caveat: hourly bars do not say whether the stop or
  the liquidation price was reached first inside an hour, and the model assumes the stop. In 147
  of the 2,012 stop-outs at 20x the same bar also reached the liquidation price, so the true
  20x liquidation rate lies between 0% and 1.2% (1.9% over three days). At 10x there were no
  such bars.
- **No re-routed flight was liquidated in any test**, against 1,881, 3,693 and 2,758 as filed.
  This is the least surprising number here, and it is the leverage that does it, not the
  checks: flown at the re-routed leverage with no stop at all, the Naked plans would also have
  had no liquidations. No hour in these 40 days moved far enough to reach a liquidation price at
  12x or less. It is a statement about this sample, not a guarantee.

Averages are negative in every row. Across both sides and all hours there is no edge to
harvest, so the mean result is roughly the fees, and fees scale with position size. Per 1,000 USDT
of exposure the mean was -1.97 as filed and -1.45 re-routed, against -1.20 for fees alone. The
as-filed figure is worse because a liquidated position cannot recover.

### 4.2 Were the forecasts right?

Before each entry Preflight estimates the chance the plan is liquidated, from 1,000 paths built
by reshuffling past bars. The app shows this number to the trader, so it matters whether it is
true.

**On the rate, yes.**

| Plans as filed | Preflight's average forecast | What happened | 95% interval of what happened |
|---|---:|---:|---:|
| 50x, default stop, one day | 25.3% | 24.2% | 19.9% to 28.2% |
| 50x, default stop, three days | 57.6% | 50.7% | 47.7% to 53.6% |
| 20x, no stop, one day | 7.2% | 6.3% | |
| 10x, no stop, one day | 0.9% | 0.8% | |

For one-day holds the forecast was within about a point of the outcome at every leverage. For
three-day holds, which are replayed on daily bars, it was seven points too high. Split in half,
the period gives 26.1% forecast against 22.8% measured for 50x over a day, then 24.6% against
25.6%.

Grouped by what Preflight said, for plans with no stop at any leverage:

| Preflight said | Plans | Average forecast | Actually liquidated |
|---|---:|---:|---:|
| 0% | 11,416 | 0.0% | 0.1% |
| 0 to 1% | 4,981 | 0.4% | 0.7% |
| 1 to 5% | 3,225 | 2.7% | 2.9% |
| 5 to 20% | 5,698 | 12.7% | 13.5% |
| 20 to 50% | 7,296 | 29.3% | 25.3% |
| over 50% | 18 | 51.6% | 0.0% |

**On which plans, no.** The table above looks better than it is, because the bands mostly sort
plans by leverage and contract. Holding the leverage fixed and asking whether the forecast knew
*which* plans would go (`research/AUDIT.md`, section 7):

| Plans as filed | Skill over one constant number | Skill over one number per contract | Correlation with outcomes, by entry day |
|---|---:|---:|---:|
| 50x, default stop, one day | -4% | -6% | -0.43 |
| 50x, default stop, three days | -1% | -4% | -0.16 |
| 20x, no stop | +11% | -6% | -0.25 |
| 10x, no stop | +1% | -2% | -0.09 |

"Skill" is the improvement in Brier score over simply quoting the group's own average to every
plan; zero or below means the forecast added nothing to that average. Across entry days the
forecast barely moved (23% to 31% for 50x) while the share actually liquidated ran from 0% to
43%, and the two were negatively correlated. By contract and side the forecast missed by between
-10 and +7 points. At 20x without a stop the forecast does tell the dangerous contracts (MSTR,
COIN) from the calm ones, but a fixed number per contract would have done that as well.

So the honest description is this: **Preflight's forecast is a base rate.** It says how often
this kind of plan, at this leverage, on a market behaving as it recently has, ends in
liquidation, and that rate was right. It does not know which day is the bad one, and nothing in
the product claims it does. One more caution: the forecast is built from the trailing bars of
the same 40 days the outcomes come from, so agreement on the average is the easy kind of
agreement. It shows volatility stayed stable through the sample as much as it shows the model is
good.

For the commoner event, the default plan ending at its stop or at liquidation, the forecast rose
with the outcome across five bands (1.7% forecast, 4.1% measured; 7.8%, 11.8%; 14.3%, 11.1%;
26.5%, 27.5%; 43.3%, 36.1%).

### 4.3 Do the thresholds line up with what happened?

Preflight's first check measures the distance to liquidation in "normal moves" for the hold
(standard deviations). It **fails** a plan under 2 and **cautions** under 3.5. Liquidations
among plans flown with no stop:

| Runway, in normal moves to liquidation | Runway check | Plans | Liquidated |
|---|---|---:|---:|
| under 1 | fail | 9,460 | **23.9%** |
| 1 to 1.5 | fail | 1,418 | **22.4%** |
| 1.5 to 2 | fail | 1,814 | 1.4% |
| 2 to 2.5 | caution | 8,328 | 1.9% |
| 2.5 to 3.5 | caution | 1,898 | 0.0% |
| 3.5 to 6 | pass | 8,162 | 0.0% |
| over 6 | pass | 1,554 | 0.0% |

Of the 2,758 liquidations, 94.3% were in plans the check fails, 5.7% in plans it cautions, and
none in plans it passes. The sharp drop in this sample is at 1.5, not at the fail line of 2, and
the rate is flat from 1.5 to 2.5: the line at 2 is on the cautious side of where the risk
changed, not exactly on it. Two limits on reading more into this: the runway is set by the
contract, the leverage and recent volatility, so the bands are largely labels for leverage and
contract; and nearly all the liquidations below 50x were on MSTR and COIN (all 95 at 10x, 696 of
782 at 20x), whose maintenance margin is an assumed 1%. At 0.5% the 20x rate on the
assumed-margin contracts would be 12.2% instead of 14.9%.

**The verdict as a whole** (default stop, flown exactly as filed, grouped by what was said
beforehand):

| Said beforehand | Plans | Liquidated | Mean | Worst 5% |
|---|---:|---:|---:|---:|
| GO | 384 | 0.0% | -0.81 | -60.96 |
| CAUTION | 7,016 | 0.0% | -5.40 | -120.57 |
| NO-GO | 25,234 | 7.5% | -22.22 | -400.00 |
| Tower would clear as filed | 1,725 | 0.0% | -2.34 | -110.71 |
| Tower refuses as filed | 30,909 | 6.1% | -19.24 | -400.00 |

Every liquidation was in a plan marked NO-GO, but that is close to automatic: every 50x plan
fails the stop check, and 77% of all plans are NO-GO. The verdict is strict about size, and
bigger positions lose more when they lose. This table shows the verdict is not backwards. It
does not show it is finely tuned.

### 4.4 A month of the habit

One trade says little about what a habit does to an account. Here the same plan is re-entered
every 24 hours with no overlap, for every contract, side and starting hour: 32 trades in a row.

| Habit | Sequences | Liquidations per sequence | Sequences with a liquidation | Median end result | 5th percentile end result | Median drawdown |
|---|---:|---:|---:|---:|---:|---:|
| 20x, default stop, as filed | 384 | 0.00 | 0.0% | -445.94 | -1,159.38 | 892.17 |
| 20x, default stop, re-routed | 384 | 0.00 | 0.0% | -127.35 | -338.32 | 258.26 |
| 50x, default stop, as filed | 240 | **7.84** | **100.0%** | **-1,478.02** | -3,222.50 | 2,363.97 |
| 50x, default stop, re-routed | 240 | 0.00 | 0.0% | -113.61 | -334.14 | 233.89 |
| 20x, no stop, as filed | 384 | 2.04 | 41.4% | -521.64 | -1,224.59 | 879.20 |
| 20x, no stop, re-routed | 384 | 0.00 | 0.0% | -111.80 | -311.91 | 259.94 |

A trader who filed the 50x plan once a day lost a median 14.8% of the account in a month and was
liquidated eight times. Re-routed, the same trader lost 1.1%. Neither made money, because there
was none to be made by trading every hour in both directions. The difference is whether the
account is still there.

The sequences are not independent. The 240 at 50x are five contracts, two sides and 24 starting
hours over the same 33 days, so they amount to about ten separate experiences, not 240.

### 4.5 What the smaller size costs

| Plans that, as filed | Plans | Mean as filed | Mean re-routed | Re-routed keeps |
|---|---:|---:|---:|---:|
| made money | 13,766 | +108.59 | +31.40 | 28.9% of the gain |
| lost money | 18,868 | -110.97 | -29.14 | 26.3% of the loss |

In the other two tests: 28.3% and 26.6% (Swing), 28.2% and 25.7% (Naked).

This is the price, stated plainly. The re-route keeps about the same share of the wins as of the
losses, because it changes the size of the trade and nothing else. A trader with a real edge
gives up roughly 70% of it by flying at 6x instead of 20x or 50x, and should weigh that against
the liquidation rates above. FLIGHTDECK's answer is that an edge is only worth something to an
account that survives long enough to use it, but that is the trader's call, and the Tower's
limits can be changed.

### 4.6 Is it more than "use less leverage"?

The fair objection to everything above: of course a smaller position loses less. So the re-route
is compared with the bluntest rule there is, **never more than 6x on anything, at any hour**,
with margin scaled so both rules carry exactly the same total exposure.

| Test | Rule | Liquidated | Mean | Worst 5% | Worst |
|---|---|---:|---:|---:|---:|
| Day (stop at 2.5%) | Re-route | 0.0% | -3.60 | -89.00 | -130.44 |
| | Flat 6x | 0.0% | -3.88 | **-70.02** | -70.09 |
| Swing (stop at 2.5%) | Re-route | 0.0% | -5.08 | -113.69 | -130.44 |
| | Flat 6x | 0.0% | -5.65 | **-69.69** | -69.74 |
| Naked (no stop) | Re-route | 0.0% | -3.40 | **-92.80** | -107.09 |
| | Flat 6x | 0.1% | -2.98 | -125.72 | -412.99 |

| Difference, re-route minus flat rule | Mean | 95% interval | Worst 5% | 95% interval |
|---|---:|---:|---:|---:|
| Day | +0.27 | -0.18 to +0.71 | -18.99 | -27.04 to -10.49 |
| Swing | +0.56 | -0.47 to +1.70 | -44.01 | -48.52 to -39.55 |
| Naked | -0.43 | -2.17 to +1.39 | +32.92 | +7.52 to +60.87 |

**On the average, there is no difference** in any of the three tests. Every interval includes
zero.

**On the worst cases, it depends on the stop.**

- When the plan arrives **with no stop**, the re-route adds one a normal move from entry. Its
  worst outcomes are 33 USDT better than the flat rule's, and the flat rule still suffers a few
  liquidations. Here the re-route does something a leverage cap cannot.
- When the plan arrives **with a fixed 2.5% stop**, the flat rule has the better worst cases.
  The reason is mechanical: with the same stop distance on every contract, a stop-out costs
  leverage times 2.5%, so the rule that gives everything the same leverage has the smallest
  worst case. The re-route gives BTC up to 12x and stock perps up to 10x while New York is
  open, and those are the flights that fill its tail.

We also checked whether the re-route cuts harder where the following hours turned out rougher,
by flying every plan at the same 5x and grouping by the leverage the re-route had given it. The
spread of results was 35.1 USDT where it gave 5x or less and 31.6 where it gave 10x or more: the
right direction, and small.

**What to take from this.** The charter's leverage limits are sensible caps, not an optimal
allocation, and this study does not show that they beat a single flat number. What FLIGHTDECK
adds to a flat cap is the odds shown before the trade (4.2), the stop when you left one out, the
same gate applied to an AI agent, and a record of every decision. A trader who prefers one flat
cap can set exactly that in the Tower: `max_leverage` across all perps is one of its rule kinds.

### 4.7 Night Watch

Night Watch acted on 21.8% of re-routed flights in the Day test, 55.5% in Swing and 26.6% in
Naked. What it did was almost entirely three things: move a stop to entry once a flight was 1R
ahead, cut half after a run of closes against the position, and trail a stop. On the flights it
touched:

| Test | Mean, watch off | Mean, watch on | Difference | 95% interval | With slippage on its exits | Worst 5%, off | Worst 5%, on | Median, off | Median, on |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Day | 12.10 | 11.95 | -0.15 | -1.62 to +1.22 | -1.06 | -107.86 | -93.21 | 11.38 | -6.40 |
| Swing | 10.36 | 10.04 | -0.32 | -2.34 to +1.63 | -1.23 | -114.70 | -95.69 | 9.26 | -6.40 |
| Naked | 10.82 | 11.36 | +0.54 | -0.74 to +1.89 | -0.46 | -96.20 | -82.97 | 10.13 | -6.40 |

**It does not improve the average.** As modelled the difference is indistinguishable from zero.
The model is kind to it, though: Night Watch's cuts are filled at the close of the bar it has
just seen with no slippage, while a stop pays 0.2%. Charged the same on its own exits, it costs
about one USDT per flight it touches, on a 400 USDT position.

**It does thin the tail**, by 13 to 19 USDT on the mean of the worst twentieth, and it pays for
that from the middle: the median flight it touches goes from a small gain to a scratch, because
moving a stop to entry at 1R turns some winners into break-evens.

That is what a rule that can only reduce risk should look like: a thinner tail, paid for with
some upside. Its two emergency rules, the runway alarm and landing before earnings, never fired
in this sample, so the study says nothing about the nights Night Watch exists for. The
stop-to-entry rule is the first thing we would test changing.

### 4.8 By session and side

| Group | Plans | Liquidated as filed | Mean as filed | Mean re-routed | Worst 5% as filed | Worst 5% re-routed | Avg re-routed leverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| Stock perps, New York open at entry | 4,752 | 6.3% | -21.38 | -5.24 | -400.00 | -101.97 | 8.2x |
| Stock perps, New York closed at entry | 23,220 | 4.8% | -18.12 | -3.16 | -394.58 | -56.52 | 5.0x |
| BTC | 4,662 | 10.1% | -16.43 | -4.13 | -400.00 | -125.31 | 10.1x |
| Long | 16,317 | 4.9% | -6.59 | -0.58 | -397.59 | -90.21 | 6.4x |
| Short | 16,317 | 6.6% | -30.11 | -6.62 | -400.00 | -87.79 | 6.0x |

- **Both sides are in.** Prices rose over the period, so shorts lost more than longs. The
  liquidation rates and the effect of the re-route are similar on each side, so the result is
  not a story about one direction.
- **The session rule deserves a second look.** Plans entered while New York was open were
  liquidated slightly more often than plans entered while it was closed, and the charter allows
  them twice the leverage (10x against 5x). A 24-hour hold entered at the opening bell still sits
  through the following night. The rule keys on the session at entry; the data suggests it
  should key on whether the hold crosses a close. That change has not been made, because it
  would be tuning the product on its own test.

---

## 5. How the results hold up when the assumptions change

Every result above rests on modelling choices. `research/audit.ts` changes them one at a time
and prints [research/AUDIT.md](../research/AUDIT.md).

| Assumption | Changed to | Effect |
|---|---|---|
| The flight model is right | A second, independent implementation | Identical on all 95,886 plans |
| Inside an hour, the stop fills before liquidation | Every ambiguous bar counted as a liquidation | 20x with a stop: 0% becomes at most 1.2% (one day), 1.9% (three days). 10x unchanged |
| The liquidation price ignores the closing fee | Fee included | 50x: 24.2% becomes 25.6% (forecast 25.3%); 50.7% becomes 52.0% |
| Maintenance margin of 1% on MSTR, COIN, QQQ | 0.5% | 20x with no stop on those contracts: 14.9% becomes 12.2% |
| Night Watch exits fill with no slippage | Same slippage as a stop | Its average effect goes from about zero to about -1 USDT per flight |
| The re-route's stop prevents liquidation | Stop removed, leverage kept | Still no liquidations: it is the leverage |
| The gap check prevents liquidation | Count what it failed | It failed 49.8% of 10x and 90.7% of 20x plans, none of which was liquidated |
| The three tests are separate evidence | Count distinct positions | 8,332 liquidations are 4,671 positions |

None of these changes the conclusions. Several of them narrow what the conclusions can be taken
to mean, and those are carried into the next section.

## 6. What this study does not show

- **No edge.** Nothing here says FLIGHTDECK improves a trade's expected return per dollar. It
  does not, and it does not try to.
- **Not better than a flat cap on average.** See 4.6.
- **No timing.** The forecast is a base rate (4.2). Within a leverage it did no better than
  quoting the average.
- **Nothing about the gap check.** Preflight fails any plan that would be liquidated by the
  instrument's worst recent day. That check failed half the 10x plans and nine in ten of the 20x
  plans, and none of them was liquidated: the 2.5% stop caught every adverse move in these 40
  days. So the sample shows what the gap check costs (lower cleared leverage) and contains no
  event that would show what it saves.
- **Nothing about gaps at all.** Bitget's hourly bars open where the last one closed, so a stop
  is always assumed to fill at its price less 0.2%, however fast the hour moved. A stock perp
  jumping past a stop at a Monday open or on earnings is the case the product is built around,
  and none is in the data.
- **Nothing about earnings.** No results date falls inside the period.
- **Last price, not mark price.** The candles are last-traded prices. Exchanges liquidate on a
  mark price that is smoother, so a spike that printed but did not move the mark would count as
  a liquidation here and not on the exchange. This would overstate as-filed liquidations, most at
  50x. We did not record mark-price candles.
- **The same model on both sides of the comparison.** The forecast and the outcome are both
  produced by this flight model. Their agreement shows the forecast is consistent with the model
  and that volatility was stable; it does not show the model matches Bitget's liquidation engine.
- **Forty days.** One stretch of one market: a rising one, with no crash. The split-half table
  shows the figures are stable inside the period. It cannot show they hold outside it.
- **Eight contracts** that share one market. The intervals resample whole days to respect that,
  and there are only 33 of them.
- **Tier-1 maintenance margin**, assumed at 1% for three contracts, and **funding ignored**.
- **Contract terms as of 8 October** (maximum leverage, fees) are applied back to September.
- **The Black Box is not tested here.** Its rules are learned from a trader's own history; the
  sample logbook in the app is synthetic and labelled as such.

## 7. What changed because of it

**In the data:** two partially recorded daily bars and a truncated BTC series, found by the
cross-check in section 2 and corrected.

**In the engines:** nothing. Changing a threshold after reading these tables and then quoting
the tables would be marking our own homework. The findings that point to a change are recorded
here as the next work, to be tested on data that did not suggest them:

1. Key the off-hours leverage cap on whether the hold crosses a close, not on the session at
   entry (4.8).
2. Offer a risk-based re-route that equalises the cost of a stop-out across contracts, which is
   what gave the flat cap its better worst cases (4.6).
3. Test a later trigger for Night Watch's stop-to-entry rule, and charge its exits slippage
   (4.7).
4. Replace the daily-bar replay for long holds, which overstated the risk by seven points (4.2).
5. Include the closing fee in the liquidation price, and record maintenance margin for every
   contract.
6. Record mark-price candles and a longer history that covers an earnings season and a falling
   market. The forward test in section 8 starts on the second half of that: Tesla reports on
   21 October.

## 8. The forward test

A study is one look at one stretch of history, and the surest test of any of it is data that did
not exist when it was written. So the study is frozen and a second, running test starts where it
ends.

Every Monday a scheduled job (`.github/workflows/forward-test.yml`) pulls the hourly candles
Bitget has printed since 8 October 2026 19:00 UTC, appends them to
`research/forward-hourly.json`, flies the Day test's plans through them with the engines exactly
as they are in this repository, and commits the score to
[research/FORWARD.md](../research/FORWARD.md): the 50x liquidation rate against Preflight's
forecast, liquidations as filed against re-routed, and the average and worst results, for each
week and for all forward hours together.

Two rules keep it honest:

- **It keeps score; it does not tune.** Nothing in the engines reads the forward results. A
  system that adjusts its own thresholds to fit its own test always looks good and proves
  nothing. When one of the changes in section 7 is made, it will be made from the frozen study
  and judged on forward weeks it has never seen.
- **It only appends what joins.** A new bar is kept only if it has closed, follows the last one
  held hour by hour, and opens where that one closed. If any contract fails that, the run writes
  nothing.

The job needs no keys, since it reads public market data. Its fetching and scoring are tested
against a stand-in for Bitget's endpoint (`tests/forward.test.ts`), and it first ran on GitHub
on 9 October 2026. The running total is also written to `research/headline.json`, which the
app's landing page reads, so the site shows the latest forward score beside the frozen study's
figures and updates itself after every run.

The first run covered 19 entry hours and 798 plans, all inside the sell-off of 7 to 8 October:
50x plans were liquidated 46.8% of the time as filed, against a forecast of 23.6%, and no
re-routed flight was liquidated. That is what section 4.2 says to expect of a base rate on a
bad day: the forecast did not see it coming, and the smaller size still held. It is also less
than one day of data. The figure to watch is the total as the weeks accumulate.

## 9. Reproduce it

```bash
npm install
npm test            # includes the data checks and the no-look-ahead check
npm run study       # about 90 minutes on one core
npm run forward     # fetch the candles since the freeze and update research/FORWARD.md
```

`npm run study` flies all three tests, then rewrites `research/RESULTS.md`, `research/AUDIT.md`
(with machine-readable copies beside them) and `research/headline.json` (the figures on the
app's landing page, which are read from that file so the page cannot drift from the study). The
run is deterministic: the same candles give the same tables, down to the confidence intervals,
which use a seeded generator. To split the work across cores, run
`npx tsx research/run.ts day NVDAUSDT TSLAUSDT ...` once per group of contracts and finish with
`npm run study:report` and `npm run study:audit`.

| File | What it is |
|---|---|
| `research/run.ts` | Files and flies every plan. Calls `preflight`, `requestClearance`, `reroute` and `tickFlight` from `src/core/` unchanged |
| `research/report.ts` | Reads the flights and prints the tables in `RESULTS.md` |
| `research/audit.ts` | The second implementation and the changed-assumption checks in `AUDIT.md` |
| `research/forward-fetch.ts`, `research/forward.ts` | The forward test: fetch the hours since the freeze, fly the plans, write `FORWARD.md` |
| `research/lib.ts` | The 40-day market, the "as the app saw it at that hour" view, the statistics |
| `research/history-hourly.ts`, `history-daily.ts` | The recorded candles |
| `tests/study.test.ts`, `tests/forward.test.ts` | Data integrity, the join to the app's snapshot, no look-ahead, determinism; the forward test's fetching and scoring |

The per-plan output (`research/out/`, about 50 MB) is not committed; `npm run study` regenerates
it.
