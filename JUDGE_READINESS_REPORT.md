# Judge readiness

> **Note (signed-intent spine update):** this document predates the signed-intent / three-path spine and the open-world intent compiler. Product positioning is now "a PayPal-native intent gate for autonomous commerce — Agents propose. Intent decides." and the gate is described as *agent-independent* (not out-of-process). `README.md` is authoritative for the current architecture, labels and status.

**Verdict: NOT yet ready for a 3-minute demo submission.** The product runs and the core is tested; the submission artifacts and the live loop are missing.

## What a judge can do without credentials (verified)
`npm install && npm start` → open `http://localhost:3000` → pick any FIXTURE → Ask → Create order → Simulate approval (REPLAY). Or click any row in the **Scenario matrix**. Screens are labelled REPLAY. `npm test` runs offline.

## What needs Sandbox credentials
Live path: `LIVE_PAYPAL=true`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optional `PAYPAL_WEBHOOK_ID`, `NVIDIA_API_KEY`, `NVIDIA_MODEL`, `AI_PROVIDER=nvidia`. A Sandbox personal buyer account (US address) for the popup.

## 60-second comprehension check
Banner → request → red/green decision → expected-vs-actual grid → "what moved / did not move". Screenshot-verified on the block path; the capture path renders through the same code (e2e-verified, not yet screenshotted live).

## Before recording / submitting (all outstanding)
1. Run the live loop ×3 capture, ×3 void (`npm run test:sandbox:interactive`).
2. Deploy to Render (+Postgres), set secrets, register webhook, confirm a real webhook lands.
3. `git init`, push to a public repo (LICENSE present; `.env` ignored).
4. Record ≤ 2:45 video per `DEMO_SCRIPT.md`; upload public to YouTube.
5. Devpost: paste copy from `WINNING_STRATEGY.md`; put Sandbox test creds in the private testing field.
6. Rotate the keys that were pasted into chat.
