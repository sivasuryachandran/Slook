# Test harness report

> **Note (signed-intent spine update):** this document predates the signed-intent / three-path spine and the open-world intent compiler. Product positioning is now "a PayPal-native intent gate for autonomous commerce — Agents propose. Intent decides." and the gate is described as *agent-independent* (not out-of-process). `README.md` is authoritative for the current architecture, labels and status.

Generated 2026-10-07. Commands: `npm test` (default, offline) · `npm run test:sandbox` · `npm run test:sandbox:interactive` · `npm run eval:ai` · `npm run record:traces`.

## Totals (`npm test`)
**49 tests: 45 pass, 0 fail, 4 skipped by design** (sandbox tests, need `RUN_PAYPAL_SANDBOX=true`). Duration ≈ 37 s.

| Mode | File | Tests | Result |
|---|---|---:|---|
| A. Unit (no network) | `unit.test.js`, `unit-ai.test.js` | 24 | pass |
| B. Contract / mock PayPal (real client ↔ local HTTP mock) | `contract.test.js` | 8 | pass |
| End-to-end on simulated adapter | `e2e.test.js` | 12 | pass |
| Adversarial mutations (15 mutations × 2 runs) | `mutations.test.js` | 1 (30 executions) | pass |
| C. Real Sandbox | `sandbox.test.js` | 2 non-interactive **ran and passed** with credentials; 2 interactive **not run** | see below |
| D. Replay | via `e2e.test.js` + `/api/replay` | covered | pass |

## Real Sandbox (run today with Sandbox credentials)
- ✔ Order created with `intent: AUTHORIZE`; same `PayPal-Request-Id` returns the **same order id**; `GET` preserves `custom_id`, `sku`, `description=variant=black`, amount.
- ✔ Authorizing an unapproved order is refused (HTTP 502 from our API) with **zero** capture/void actions stored.
- **UNVERIFIED:** happy-path capture and mismatch-void on real PayPal, real webhook delivery and signature verification. Verify: `npm run test:sandbox:interactive`, open the printed link, approve with a Sandbox buyer account; repeat 3× per path; deploy to a public URL and register the webhook.

## Mutation suite (`reports/mutation-results.json`)
**Detection rate 15/15 (100%). Capture prevented 15/15. Voided where a PayPal authorization existed 9/9. Evidence stored 15/15. Deterministic across 2 runs 15/15.**

| ID | Mutation | Outcome |
|---|---|---|
| M01 | Unit price raised after proposal | VOID — amount.total, items.unit_amount, catalog.price |
| M02 | Quantity 1→2 | VOID — amount.total, items.quantity |
| M03 | SKU swapped | VOID — items.sku, items.variant, policy.substitution |
| M04 | Currency USD→EUR | VOID — amount.currency |
| M05 | Ship-to country US→CA | VOID — shipping.country |
| M06 | Item removed from catalog | VOID — items.sku, catalog.price, policy.substitution |
| M07 | custom_id altered | VOID — link.custom_id |
| M08 | Stale PayPal response | VOID — paypal.state (+ shipping.country) |
| M09 | Duplicate webhook | one ledger event |
| M10 | AI invalid JSON | rejected → deterministic fallback, labelled |
| M11 | AI unauthorized price $1.00 | rejected |
| M12 | AI adds unrequested product | rejected (unexpected fields) |
| M13 | AI ignores budget | HTTP 422 before any PayPal order |
| M14 | Fake amount sent to gate | ignored; gate decides from PayPal GET |
| M15 | 8 concurrent gate calls | one decision, one PayPal action, one fresh GET |

Caveat: "UI explains" is asserted as *every failing assertion carries an expected value, actual value and explanation*, plus a manual screenshot review — not an automated browser test.

## AI evaluation (`reports/ai-eval.json`, model `nvidia/nemotron-3.5-lightning-30b-a3b`, temp 0.2, 50 scenarios)
| Metric | Result |
|---|---|
| Valid JSON rate | 88% |
| Schema validation rate | 76% |
| Correct SKU / qty / price (20 normal) | 95% / 95% / 95% (the miss was a 45 s timeout) |
| Budget compliance of schema-valid raw output | 84.2% |
| Raw model policy-violation rate | 44% (adversarial: 9/10, catalog/budget traps: 9/10) |
| Pipeline rejection rate | 52% |
| **Unsafe accepted proposals** | **0 (model path), 0 (fallback path)** |
| Latency avg / p95 | 9.2 s / timeout-bound (4 of 50 calls hit the 45 s limit; now 20 s with fallback) |
| Fallback reproducibility | 100% |
| Model same-SKU on repeat (10 calls) | 90% |

**Limitation, stated plainly:** the model is not reliable enough to be trusted with purchase decisions — it followed injected instructions in most adversarial cases. That is the product's argument, not a bug to hide: the deterministic layer rejected every one. Oracle caveat in `HACKATHON_AUDIT.md`.

## Replay
`fixtures/traces.json`: 9 saved traces (1 matching, 8 mismatches). Each shows REPLAY label, original model name, verbatim model output, PayPal order fixture (simulated adapter), gate decision and reasons, recorded timestamp. All 9 re-evaluate to the recorded decision (reproduced = yes).
