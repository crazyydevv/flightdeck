# Forward test

The study in docs/STUDY.md was frozen on candles up to 8 October 2026 19:00 UTC. This file is what
happened next: the same plans, judged by the same engines with no threshold changed, on hours
that did not exist when the study was written. A scheduled job
(`.github/workflows/forward-test.yml`) pulls the new Bitget candles every week, reruns this and
commits the result. Nothing here is tuned on what it finds; it only keeps score.

Plans are the study's Day test: the app's default stop and target (2.5% and 6%), 400 USDT of
margin, long and short, 10x, 20x and 50x, held at most 24 hours, entered at every hour.

Candles on file through 2026-10-19 07:00 UTC. Entries from 2026-10-07 20:00 to 2026-10-18 07:00 UTC.

| Period | Entry hours | Plans | 50x liquidated as filed | Preflight forecast for 50x | Liquidated as filed, all | Liquidated re-routed | Mean as filed | Mean re-routed | Worst 5% as filed | Worst 5% re-routed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All forward hours | 252 | 10,584 | 29.3% | 24.2% | 7.0% | 0.0% | -20.23 | -4.33 | -400.00 | -91.88 |
| Week of 2026-10-05 | 100 | 4,200 | 22.4% | 24.1% | 5.3% | 0.0% | -22.74 | -5.33 | -400.00 | -84.64 |
| Week of 2026-10-12 | 152 | 6,384 | 33.8% | 24.3% | 8.1% | 0.0% | -18.57 | -3.67 | -400.00 | -96.22 |

For comparison, the frozen study's Day test: 50x liquidated 24.2% as filed against a forecast of
25.3%; 5.8% of all plans liquidated as filed and none re-routed; mean -18.35 as filed and -3.60
re-routed.

A week is a small sample: one bad or quiet week will move these figures a long way. The row to
watch is the first one, as it grows.
