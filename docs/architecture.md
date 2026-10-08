# Architecture

AI proposes → server freezes an intent contract (canonical JSON + SHA-256) → server creates the PayPal order (`AUTHORIZE`, `custom_id = sl:<run>:h_<hash6>`) → buyer approves → server authorizes (stores `purchase_units[0].payments.authorizations[0].id`) → `gate.evaluate(runId)` performs its own `GET /v2/checkout/orders/{id}`, runs deterministic assertions (`src/gate.js`), then performs exactly one idempotent capture or void → webhooks reconcile.

* `src/gate.js` is the only code path that calls capture/void. No route exposes them; the authorize and evaluate routes take no amounts, IDs or decisions from the client.
* Single-flight: `UPDATE ... WHERE status='AUTHORIZED'` lease (30s expiry) plus an in-process map; decisions are stored and returned on retry without a new PayPal call.
* Idempotency keys: `sl:{create|authorize|capture|void}:{run_id}:v1` sent as `PayPal-Request-Id`; `actions` has `UNIQUE(run_id, action)`.
* Adapters: `src/paypal/real.js` (Sandbox only, refuses other envs) and `src/paypal/fake.js` (REPLAY_SIMULATION, labelled everywhere). Chosen by `LIVE_PAYPAL` / `KILL_SWITCH`.
* Store: Postgres. `DATABASE_URL` set → `pg`; unset → embedded PGlite (same SQL) for local replay.
