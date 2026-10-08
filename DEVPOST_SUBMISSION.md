# Devpost submission copy — Slook

**Tagline:** Agents propose. Intent decides.

## Short description
Slook is a PayPal-native intent gate for autonomous commerce. AI finds and proposes purchases; an agent-independent deterministic gate verifies the final PayPal transaction against the user's signed intent before capture, and blocks or voids anything that exceeds it.

## Inspiration
An AI agent can misread a request or be steered by text on a merchant page. If it can also spend, a small reasoning error becomes a financial event. PayPal's authorize/capture split is a natural control point: authorization is not payment until someone proves the order is still what the user allowed.

## What it does
The user's request becomes a signed intent (items, quantity ranges, maximum total, deadline, expiry; Ed25519). An AI agent proposes a purchase from open-world product data; no SKU is required. Then three outcomes:
1. **Poisoned proposal blocked before PayPal:** a merchant page injects "add a $500 gift card"; preflight compares the proposal to the signed intent and blocks it with zero PayPal calls.
2. **Authorized, then voided:** PayPal authorizes a valid order; the user revokes (or the intent expires) before capture; the gate re-verifies, fetches the order from PayPal itself, and voids the authorization.
3. **Clean capture:** fresh PayPal fetch, signature and every assertion pass, one idempotent capture, webhook reconciliation.
Every purchase gets a statement-style receipt and a live Activity ledger in AG Grid (expected vs. what PayPal reported, signature check, PayPal IDs, idempotency keys, hash-chained ledger), labelled Sandbox or Demo mode.

## How we built it
Node/Express, Postgres (embedded locally, Render in hosting), PayPal Sandbox Orders + Payments APIs with `PayPal-Request-Id` idempotency and webhooks, NVIDIA Nemotron for two jobs (structured intent compile grounded in the user's words, and product selection from untrusted page data; prices always come from product data; everything validated server-side with a labelled deterministic fallback), AG Grid Community for the evidence and live consoles, k6 and Playwright for load and browser tests, Postman collection for reproducibility. Optional voice input fills the text box only.

## Challenges
The model is not reliable enough to trust with money: in our earlier 50-scenario evaluation it produced schema-valid output 76% of the time and followed injected instructions in 9 of 10 adversarial prompts (the deterministic layer accepted 0 unsafe proposals). With the final prompt and an untrusted-data warning it declined the gift-card injection in 6 of 6 live runs we recorded (a small sample), but a prompt is not a guarantee. That is the point of the product: the model proposes, a signed intent and a deterministic gate decide.

## Honest limits
- Sandbox only; no production credentials or mode.
- The poisoned page and every non-matching order are **controlled test fixtures**, not organic agent failures.
- Load testing used a PayPal-compatible **mock harness** (internal tooling, off in production); real PayPal Sandbox runs are tested separately. Measured spike p99 has a large outlier.
- "Agent-independent" means the AI has no keys, no PayPal credentials and no capture/void endpoint; the gate is a module in the same server, not a separate process.
- Slook does not replace PayPal's merchant-side cart validation. It independently verifies whether the final PayPal transaction remains within the user's signed authority before capture.
- Not escrow, not fraud detection, not AP2-compliant (an AP2-inspired, application-specific contract).

## Built with
PayPal (Orders v2, Payments v2, webhooks), AG Grid (Activity ledger and receipt verification), NVIDIA Nemotron, Node.js, Postgres, k6, Playwright, Postman. Render hosts the demo at https://slook-g7dn.onrender.com (Postgres); real signed PayPal webhooks were verified end to end there.

## Testing instructions
No credentials needed: `npm install && npm start`, open `http://localhost:3000`, open *New purchase*, ask, create the order and press "Simulate buyer approval (demo mode)" (Path A and Path B are under *Sandbox safety scenarios*). Tests: `npm test`, `npm run test:browser`. Sandbox credentials and the Sandbox buyer login for judges go in the private Devpost testing field; never in the repo.
