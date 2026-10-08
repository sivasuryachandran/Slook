# Real-time simulation report
*Generated 2026-10-08T08:43:25.819Z from `reports/load-*.json` by `scripts/make-sim-report.js`. Every number below was measured; nothing is estimated.*

## What was and was not simulated
- **Simulated:** virtual shoppers (k6 for volume, Playwright for 5 real browsers) driving the real API, the real deterministic capture gate, the real ledger and the real WebSocket stream.
- **Mock:** PayPal. All simulation runs use `MOCK_SIMULATION`, an in-process adapter that mimics PayPal response shapes. **No simulation run touches real PayPal Sandbox**, whatever `LIVE_PAYPAL` says (enforced in code and covered by tests). The AI proposal is the deterministic replay path (plus a deliberate malformed-output scenario), not live model calls.
- **Honest claim:** *"We simulated N concurrent commerce runs against a PayPal-compatible mock harness, and validated the critical lifecycle separately against real PayPal Sandbox."* Not: "N real PayPal shoppers."

## Results by profile
Latency columns are p50 / p95 / p99 in ms. "HTTP" is the k6-observed latency of `POST /api/simulation/runs`; "gate" is the time inside the deterministic gate; "end-to-end" is run creation → final decision.

| Profile | Peak VUs | Runs | Captured | Voided after auth | Blocked pre-PayPal | Mismatch detection | Missed / false blocks | HTTP failed | HTTP p50/p95/p99 | Gate p50/p95/p99 | End-to-end p50/p95/p99 | Decisions/s | AI fallback | Errors | k6 thresholds |
|---|---:|---:|---:|---:|---:|---|---|---:|---|---|---|---:|---:|---:|---|
| smoke | 5 | 52 | 29 | 18 | 5 | 100% (23/23) | 0 / 0 | 0% | 11 / 17 / 34 | 8 / 10 / 12 | 174 / 182 / 187 | 2.3 | 11.5% | 0 | pass |
| demo | 25 | 481 | 257 | 196 | 28 | 100% (224/224) | 0 / 0 | 0% | 6 / 13 / 18 | 5 / 8 / 9 | 165 / 174 / 177 | 10.9 | 7.3% | 0 | pass |
| normal | 100 | 2923 | 1590 | 1145 | 188 | 100% (1333/1333) | 0 / 0 | 0% | 6 / 16 / 24 | 3 / 4 / 7 | 160 / 169 / 176 | 42.1 | 6.9% | 0 | pass |
| stress | 250 | 5705 | 3048 | 2251 | 406 | 100% (2657/2657) | 0 / 0 | 0% | 405 / 1231 / 1384 | 3 / 4 / 5 | 456 / 1195 / 1532 | 81.5 | 7.2% | 0 | pass |
| spike | 500 | 3390 | 1778 | 1379 | 233 | 100% (1612/1612) | 0 / 0 | 3.1% | 578 / 1666 / 26563 | 3 / 3 / 3 | 641 / 1424 / 1797 | 112.9 | 6.8% | 0 | FAIL (thresholds crossed) |
| soak | 50 | 14121 | 7474 | 5707 | 940 | 100% (6647/6647) | 0 / 0 | 0% | 14 / 63 / 122 | 4 / 7 / 8 | 167 / 203 / 245 | 23.6 | 6.7% | 0 | pass |

Thresholds: `http_req_failed < 2%` and `http_req_duration p95 < 1500 ms`.

Soak: 14121 runs over 602s at 50 VUs, 0 errors, 0 runs stuck in flight after drain. Server RSS sampled every 30 s (MB): 467, 322, 375, 496, 411, 443, 598, 446, 536, 545, 638, 508, 529, 471, 532, 503, 612, 485, 547, 425 — steady-state range 322–638 MB with no monotonic growth over the 10 minutes (a single 10-minute run is not proof of absence of leaks); process start reading 1054 MB is the embedded-database boot spike. Peak CPU 111.8%, peak in-flight runs 12. Memory includes the embedded database, so it is not representative of Render.

## Findings
- **Correctness held at every load level:** see the "Missed / false blocks" column. A *missed* mismatch would be a mutated order that was captured; a *false block* is a valid order that was voided.
- **Where it strains:** the gate itself stays in single-digit milliseconds at every level; what grows under load is HTTP queueing in the single Node process / single-connection embedded database. The stress and spike rows sit at the edge of the thresholds and **vary run to run**: across builds in this project the same 500-VU spike profile has both passed narrowly and crossed the thresholds (up to 12.8% of requests timing out, with a p99 outlier of about 24 s in one run; see `reports/load-all.log`, `load-all2.log`, `load-all3.log`). Treat roughly 250 concurrent virtual shoppers as the comfortable ceiling and 500 as beyond it on this setup. Requests that time out can still complete server-side.
- **A correction worth stating:** an early run on an earlier build capped its stats at 5,000 rows and polled them every second, which both truncated totals and added load. Stats are now SQL aggregates and every profile was re-run; the table above is the latest run on the current build (signed intents + preflight add a little work per run).
- **Mismatch detection** is measured over runs whose scenario is a deliberate mismatch (price, quantity, SKU, shipping country, poisoned proposal blocked at preflight, intent revoked after authorization). It is 100% by construction of the checks the fixtures violate; it is not a claim about unknown attacks.
- **AI fallback rate** is dominated by the deliberate `malformed_ai_output` scenario in the mix, so it is a property of the mix, not of any model.

## Resource limits and caveats
- Measured on one developer laptop, single Node process, **PGlite (embedded Postgres, one connection)**. Render runs real Postgres through `pg` with a pool, so absolute throughput and memory there will differ. **UNVERIFIED on Render**: re-run `node scripts/run-load.js <profile>` against the deployed service (use k6 directly with `BASE_URL`).
- Server memory reported by the runner (RSS) includes the embedded database and is not representative of a Render deployment.
- Resource samples (RSS, CPU, in-flight) are only valid for runs made after the runner was fixed to launch k6 asynchronously. Earlier runs launched k6 synchronously, which froze the sampler, so their resource fields (and any 'starved sampler' explanation given at the time) were wrong; only the k6 and database figures from those runs were valid. Profiles whose resource fields are all equal/zero were affected.
- Requests that k6 abandoned on timeout can still complete server-side, so `decided` can exceed k6's accepted count.
- The simulation API is operator-limited: over 25 shoppers per request needs `INTERNAL_ACTION_KEY` when it is set; `SIM_MAX_ACTIVE` caps in-flight shoppers (default 600); the mock adapter's webhook arrives ~300 ms after capture/void by design.
- A single instance WebSocket broadcast is used. Multiple instances would need a shared pub/sub (Redis adapter); not built because one Render instance is the target.

## Browser coverage (Playwright, 5 concurrent real Chrome sessions)
6 tests pass (`npm run test:browser`): rows appear without a page reload, the grid shows both VOIDED and CAPTURED, the event stream shows `gate.blocked` and `payment.captured`, and a row opens a MOCK-labelled evidence trace with the fresh-fetch badge and a failed assertion.

## How to reproduce
```bash
node scripts/run-load.js smoke   # smoke | demo | normal | stress | spike | soak
node scripts/make-sim-report.js
npm run test:browser
```
