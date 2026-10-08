# Winning strategy and product assessment

> **Note (signed-intent spine update):** this document predates the signed-intent / three-path spine and the open-world intent compiler. Product positioning is now "a PayPal-native intent gate for autonomous commerce — Agents propose. Intent decides." and the gate is described as *agent-independent* (not out-of-process). `README.md` is authoritative for the current architecture, labels and status.


## Positioning
**"A PayPal-native intent gate for autonomous commerce. Agents propose. Intent decides."** (earlier framing: "authorization firewall for AI commerce") PayPal authorizes; Slook proves the order still matches the shopper's intent; only then capture. Not escrow, not fraud scoring, not "makes AI safe".

## Product questions
- **First paying customer:** a platform/marketplace shipping buyer-side shopping agents on PayPal (agent-commerce startups, procurement-automation vendors).
- **Cost of failure:** wrong-variant/qty/price orders → refunds, chargebacks, support load, and loss of user trust in letting an agent spend. One bad agent run is a financial event.
- **Why PayPal is central:** the authorize/capture split is the control point that makes "check, then move money" possible without custody. Its `custom_id`, request-id idempotency and webhooks are used in the core path. (A card processor with auth/capture could be adapted — we don't claim exclusivity.)
- **Why AI:** it turns free-form requests into structured intent. Our eval shows it is also the unreliable part — which is why the firewall exists.
- **Versus ordinary validation / fraud tools:** those test the payment against payment rules or risk. This tests the payable order against the *user's original intent*, with a stored evidence trail.
- **Strongest use case:** agents buying on behalf of businesses (procurement) where intent = PO line items and an approver needs an audit record.
- **What a customer pays for:** per-transaction gating + audit export + policy packs + multi-merchant catalog adapters.
- **Beyond a demo:** needs real catalog connectors, auth/multi-tenant, anchored ledger, PayPal production review. None built; say so.

## Award targets (qualitative)
| Award | Outlook | Why |
|---|---|---|
| Best Use of AG Grid | **Moderate–strong** | Four meaningful grids (assertion compare w/ mismatch highlight + filter, scenario matrix, ledger, runs) + drill-down. Not decoration. |
| Best Use of PayPal + AI | **Moderate** → strong after live loop | Core path uses create/authorize/GET/capture/void/webhooks; AI is evaluated honestly. Needs the live proof. |
| Best Use of Agentic Commerce | **Moderate** | Directly on theme; narrow catalog. |
| Most Impactful | Low–moderate | Real problem, no market evidence. |
| Best Demo Delivery | Low until video exists | Strong script, nothing recorded. |
| Best Use of Render | Low | Config only; not deployed. |
| Grand Prize | Low–moderate | Competes on rigor (mutation + eval + honesty) rather than breadth. |

**Strongest target:** AG Grid. **Weakest:** Render / Demo Delivery (both purely "not done yet"). **Evidence that would raise it:** a recorded live capture + void with a real webhook, a deployed URL, a clean 2:40 video.

## Differentiators to lead with
1. The AI is measured, shown to be manipulable, and contained: 50-scenario eval, 0 unsafe accepts.
2. 15/15 adversarial mutations caught, including a caller-supplied fake amount.
3. Tamper-evident ledger + fresh-GET proof, replayable by judges with no credentials.

## Devpost copy (honest)
*Slook is an authorization firewall for AI commerce. NVIDIA Nemotron turns a shopping request into a structured proposal, frozen as a hashed intent contract. The buyer approves a PayPal Sandbox AUTHORIZE order; before capture, Slook re-fetches the order from PayPal, compares it to the contract, catalog, price, quantity, shipping and policy, then captures or voids. The AI can recommend a purchase but never moves money. Every decision lands in a hash-chained evidence ledger explored in AG Grid. Demo mismatches are labelled controlled test fixtures; replay mode runs with no credentials.*
