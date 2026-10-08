# Risk register

> **Note (signed-intent spine update):** this document predates the signed-intent / three-path spine and the open-world intent compiler. Product positioning is now "a PayPal-native intent gate for autonomous commerce — Agents propose. Intent decides." and the gate is described as *agent-independent* (not out-of-process). `README.md` is authoritative for the current architecture, labels and status.

| # | Risk | Likelihood | Impact | Mitigation / status |
|---|---|---|---|---|
| 1 | Live Sandbox loop fails on demo day (popup, buyer account, PayPal outage) | Med | High | Replay mode + saved traces; rehearse 3× per path; record video from a successful take. **Live loop not yet run.** |
| 2 | Ship-to country check fails on a real buyer (address missing/non-US Sandbox buyer) → unintended VOID | Med | Med | Strict by design (missing = fail). Use a US-address Sandbox buyer; check in the first live run. **UNVERIFIED.** |
| 3 | `intent.fresh` expires while buyer approves (default 60 min) | Low | Low | `INTENT_TTL_MIN` env. |
| 4 | Webhook verification untested on real PayPal; needs public URL + webhook ID | High | Med | Deploy to Render first; subscribe `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.AUTHORIZATION.VOIDED`. Capture/void immediate response is stored independently. |
| 5 | Nemotron latency spikes (observed up to timeout) | Med | Med | 20 s timeout → labelled deterministic fallback. |
| 6 | Model followed injected instructions | Observed | Contained | Strict schema, catalog/price/shipping/request/budget checks (0 unsafe accepts). |
| 7 | Credentials pasted into chat | Done | High | **Rotate PayPal Sandbox secret and NVIDIA key after the hackathon.** Never committed; `.env` is gitignored. |
| 8 | Hash-chained ledger is tamper-evident, not tamper-proof; chain ordering assumes a single instance | Low | Med | Documented. Anchor head hash externally for production. |
| 9 | Replay mode mistaken for live | Low | High | Labelled on every screen; replay never calls PayPal/model. |
| 10 | No git repo / public URL / video yet | High | High | Required before submission; see WINNING_STRATEGY. |
| 11 | Operator/read endpoints unauthenticated (run IDs unguessable, list endpoint open) | Med | Low–Med | Fixtures gated by `INTERNAL_ACTION_KEY`; add auth to `/api/runs` listing before any non-demo use. |
| 12 | Claim drift: described as escrow/fraud/"safe AI" | Low | High | Copy reviewed; use "authorization firewall". |
| 13 | Live Runs / simulation mistaken for real PayPal traffic | Med | High | MOCK badge on every screen; simulation adapter hard-wired to the in-process mock (cannot reach PayPal even with `LIVE_PAYPAL=true`); sim runs rejected by browser payment routes; tests cover all three. Say "mock harness" in the video. |
| 14 | Simulation endpoint abused on the hosted demo | Med | Med | >25 shoppers per request needs `INTERNAL_ACTION_KEY`; `SIM_MAX_ACTIVE` cap; per-IP rate limit. Set the key on Render. |
| 15 | Load ceiling on Render unknown (measured on laptop + PGlite) | Med | Med | Re-run k6 against the deployed URL; demo with ≤ 25–100 shoppers, well inside measured limits. **UNVERIFIED on Render.** |
