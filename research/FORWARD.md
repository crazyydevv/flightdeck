# Forward test

The study in docs/STUDY.md was frozen on candles up to 8 October 2026 19:00 UTC. This file is what
happened next: the same plans, judged by the same engines with no threshold changed, on hours
that did not exist when the study was written. A scheduled job
(`.github/workflows/forward-test.yml`) pulls the new Bitget candles every week, reruns this and
commits the result. Nothing here is tuned on what it finds; it only keeps score.

Plans are the study's Day test: the app's default stop and target (2.5% and 6%), 400 USDT of
margin, long and short, 10x, 20x and 50x, held at most 24 hours, entered at every hour.

Candles on file through 2026-11-09 07:00 UTC. Entries from 2026-10-07 20:00 to 2026-11-08 07:00 UTC.

| Period | Entry hours | Plans | 50x liquidated as filed | Preflight forecast for 50x | Liquidated as filed, all | Liquidated re-routed | Mean as filed | Mean re-routed | Worst 5% as filed | Worst 5% re-routed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All forward hours | 756 | 31,752 | 31.9% | 28.5% | 7.6% | 0.0% | -14.82 | -3.35 | -400.00 | -102.91 |
| Week of 2026-10-05 | 100 | 4,200 | 22.4% | 24.1% | 5.3% | 0.0% | -22.74 | -5.33 | -400.00 | -84.64 |
| Week of 2026-10-12 | 168 | 7,056 | 33.9% | 24.5% | 8.1% | 0.0% | -18.70 | -3.90 | -400.00 | -94.17 |
| Week of 2026-10-19 | 168 | 7,056 | 29.3% | 27.4% | 7.0% | 0.0% | -20.40 | -4.62 | -400.00 | -95.00 |
| Week of 2026-10-26 | 168 | 7,056 | 27.5% | 29.7% | 6.5% | 0.0% | -13.14 | -3.48 | -400.00 | -94.78 |
| Week of 2026-11-02 | 152 | 6,384 | 43.8% | 35.7% | 10.4% | 0.0% | -0.99 | 0.11 | -400.00 | -114.44 |

For comparison, the frozen study's Day test: 50x liquidated 24.2% as filed against a forecast of
25.3%; 5.8% of all plans liquidated as filed and none re-routed; mean -18.35 as filed and -3.60
re-routed.

A week is a small sample: one bad or quiet week will move these figures a long way. The row to
watch is the first one, as it grows.
