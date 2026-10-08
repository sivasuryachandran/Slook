# Demo script — target 2:30 (rules: under 3:00; public YouTube; no unlicensed music)

**Pitch:** "Slook is an intent gate for autonomous commerce. Agents propose. Intent decides."
Say plainly: Sandbox only; the poisoned page is a controlled test fixture; the live grid is a mock harness.

Pre-flight: `LIVE_PAYPAL=true`, Sandbox buyer with a US address, `INTENT_SIGNING_KEY` set, a successful rehearsal of each path. If PayPal misbehaves, record the same flow in REPLAY and say so on camera.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Title, banner | "AI can propose the wrong purchase. Slook decides whether that proposal is still authorized." |
| 0:15–0:45 | **Path A** — type "Find a suitable birthday cake under $60.", pick *Path A · Poisoned proposal*, Ask | Signed intent card (Ed25519, expiry, max $60). "This merchant page carries an injected instruction — a controlled test fixture." The proposal now has a $500 gift card. |
| 0:45–1:05 | Red preflight panel + decision | "Preflight compares the proposal to the signed intent: unrequested item, total $548 over $60. Blocked **before PayPal** — zero PayPal calls, no order exists." Show the PREFLIGHT rows in the AG Grid. |
| 1:05–1:35 | **Path B** (real Sandbox) — "Buy 12 donuts and 3 kg of grapes for Friday morning under $80." Create order, approve in PayPal popup | "PayPal authorized it. Funds are not captured. Before capture the buyer revokes the intent." Click **Revoke intent**, then **Run the gate** → VOIDED. "The gate re-verified the signature, saw the revocation, fetched the order from PayPal itself, and voided." |
| 1:35–2:05 | **Path C** (real Sandbox) — "Buy biryani tonight under $25.", approve | "Same gate, valid order: fresh fetch, signature, every assertion passes — captured once under an idempotency key; the webhook reconciles." |
| 2:05–2:30 | Evidence grid (assertions expected vs actual, ledger integrity) then `/live.html`, **Start 25** | "Every decision is evidence. 25 simulated shoppers against a PayPal-compatible **mock** harness — mismatches blocked or voided, valid orders captured. Real PayPal Sandbox is the three paths you just saw." |

Do not say: escrow, fraud-proof, guarantees, "real PayPal shoppers", out-of-process, AP2-compliant, "prevents prompt injection". Do say: Sandbox, controlled test fixture, mock harness, agent-independent deterministic gate.

Optional (10 s, only if time): click the microphone, say the cake request, edit the transcript, submit. "Voice only fills the text box; it follows the same signed path and cannot pay."

On camera, point at the AI line on the proposal card: "Nemotron compiled the intent (grounded in my words, budget locked) and chose the products from untrusted merchant text. Prices come from product data. Here it declined the injection, so the test fixture adds the gift card so we can show the block." If the model ever does obey the injection on its own, the card says ORGANIC AGENT TRACE — say that is a real model failure.

Numbers you may quote (from `reports/`): model schema-valid 76%, followed injected instructions in 9/10 adversarial prompts, 0 unsafe proposals accepted; simulation detected 100% of deliberate mismatches with 0 false blocks (mock harness).
