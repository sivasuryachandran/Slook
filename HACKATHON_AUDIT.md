# Hackathon audit — Slook

> **Note (signed-intent spine update):** this document predates the signed-intent / three-path spine and the open-world intent compiler. Product positioning is now "a PayPal-native intent gate for autonomous commerce — Agents propose. Intent decides." and the gate is described as *agent-independent* (not out-of-process). `README.md` is authoritative for the current architecture, labels and status.

*Audited 2026-10-07 against the PayPal AI Hackathon requirements. Skeptical by design.*

## Requirements checklist
| Requirement | Status | Evidence / gap |
|---|---|---|
| Meaningful PayPal integration | **Partly verified** | Real Sandbox calls verified today: OAuth, create (`AUTHORIZE`), idempotent re-create with same `PayPal-Request-Id`, GET preserving `custom_id`/`sku`/variant, authorize-before-approval refused (`tests/sandbox.test.js`, 2/2 pass). **UNVERIFIED:** authorize → capture/void → webhook on real Sandbox (needs a human buyer approval). |
| Meaningful AI integration | **Verified, with caveats** | Nemotron is called live and its output drives the proposal and contract. 50-scenario eval (`reports/ai-eval.json`): model is unreliable on adversarial input; deterministic validation contains it. |
| Working prototype | Yes (local) | `npm start`; 49 tests (45 pass, 4 skipped by design). |
| Demo / run instructions | Yes | README, replay mode needs no credentials. |
| Public repo + license | **Not done** | MIT `LICENSE` exists; not a git repo yet, not pushed. |
| Demo video < 3 min | **Not done** | Script in `DEMO_SCRIPT.md`. |
| Tools explained | Yes | README "Tools used". |
| Hosted demo | **Not done** | `render.yaml` written, never deployed. |

## Criteria scores
| Criterion | Score | Evidence | Weakness | Fix | Effort |
|---|---:|---|---|---|---|
| Technological Implementation | 7 | Fresh-GET gate, single-flight lease, idempotency keys, hash-chained ledger, 15/15 mutations caught, real Sandbox contract checks | Full live loop not yet run; webhook verification untested against real PayPal | Run `test:sandbox:interactive` ×3 each path, deploy for webhooks | 2–3 h |
| Design | 7 | Decision banner, expected-vs-actual grid, drill-down, replay matrix (screenshot-verified) | Not yet polished for mobile/dark; one-page layout is long | 60-second walkthrough polish, collapse sections | 2 h |
| Potential Impact | 6 | Concrete failure (agent-vs-order mismatch) with a named buyer type | Single-merchant catalog; market proof is argument, not data | Position as authorization firewall; show multi-merchant adapter in docs | 1 h |
| Innovation | 7 | Authorize→verify→capture/void as an agent-safety primitive; AI cannot move money | "Pre-capture check" is a known pattern; novelty is in the framing + evidence ledger | Lead with the tamper-evident evidence + adversarial results | 1 h |
| Presentation | 4 | Script exists | No video, no public repo, no hosted URL | Record, push, deploy | 3–4 h |

## Things that are simulated, circular, or scripted (be upfront in submission)
1. **Controlled mismatches are test fixtures.** The wrong order is produced by our own fixture, not an organic agent failure. Labelled everywhere.
2. **Replay traces use a simulated PayPal adapter.** The model output in them is verbatim from a real call; the PayPal side is not.
3. **The proposal contract is derived from the (validated) AI proposal.** Mitigated: deterministic request cross-check, catalog price/shipping check, budget check. A proposal that is wrong but plausible and within the request text would be frozen.
4. **AI eval oracle partly overlaps the pipeline's own checks**, so "0 unsafe accepts" is weaker than it sounds for categories where the oracle is rule-based.
5. **Gate checks do not include fraud/identity risk.** Not escrow, not fraud detection.
