// Live-proof runner. Each row prints a PayPal approval link; approve it with a Sandbox buyer, the script does the rest.
//   node scripts/live-matrix.js            # real PayPal Sandbox (needs .env with LIVE_PAYPAL=true)
//   LIVE_PAYPAL=false node scripts/live-matrix.js   # dry run on the simulated adapter (auto-approves)
// Writes reports/live-matrix.json. Webhooks only arrive if the app is publicly reachable; this local run reports them as such.
import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
import { createApp } from '../src/app.js';

const REQ = 'Buy one black travel backpack under $90 delivered';
// [fixture scenario, expected decision, label, request text]. Paths A/B/C are the product spine; the rest are extra mutations.
const CAKE = 'Find a suitable birthday cake under $60.';
const MATRIX = [
  ['poisoned_proposal', 'BLOCK', 'Path A: poisoned proposal blocked before PayPal', CAKE],
  ['revoke_before_capture', 'VOID', 'Path B #1: authorize, revoke intent, void', 'Buy 12 donuts and 3 kg of grapes for Friday morning under $80.'],
  ['revoke_before_capture', 'VOID', 'Path B #2: authorize, revoke intent, void', REQ],
  ['revoke_before_capture', 'VOID', 'Path B #3: authorize, revoke intent, void', 'Buy biryani tonight under $25.'],
  ['happy', 'CAPTURE', 'Path C #1: clean capture', REQ], ['happy', 'CAPTURE', 'Path C #2: clean capture', CAKE], ['happy', 'CAPTURE', 'Path C #3: clean capture', 'Buy biryani tonight under $25.'],
  ['inflated_total', 'VOID', 'Price mutation', REQ], ['wrong_quantity', 'VOID', 'Quantity mutation', REQ],
  ['wrong_variant', 'VOID', 'SKU mutation', REQ], ['wrong_country', 'VOID', 'Shipping-country mismatch', REQ],
];
const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
const app = await createApp({ ...process.env, REPLAY_MODE: 'true' }); // deterministic proposal: the matrix tests the gate, not model latency
const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dry = !!app.paypal.simulateApproval;
console.log(dry ? 'DRY RUN (simulated adapter) — not live proof' : 'LIVE PayPal SANDBOX');

const rows = [];
for (const [i, [scenario, expected, label, text]] of MATRIX.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const row = { n: i + 1, label, scenario, expected, live: !dry };
  try {
    const run = await j('POST', '/api/runs', { request_text: text, scenario, confirm: true });
    const id = run.body.run_id; row.run_id = id; row.request = text;
    if (run.body.status === 'BLOCKED') { // Path A: assert that PayPal was never contacted
      const ev0 = (await j('GET', `/api/runs/${id}/evidence`)).body;
      Object.assign(row, { decision: ev0.decision.decision, reason_codes: ev0.decision.record.reason_codes, paypal_calls: ev0.decision.record.paypal_calls, paypal_snapshots: ev0.snapshots.length, paypal_actions_recorded: ev0.actions.length, ledger_chain_ok: ev0.integrity.ok,
        passed: ev0.decision.decision === expected && ev0.snapshots.length === 0 && ev0.actions.length === 0 });
      rows.push(row); console.log(row.passed ? 'PASS' : 'FAIL', JSON.stringify({ n: row.n, label, decision: row.decision, reasons: row.reason_codes })); continue;
    }
    const order = await j('POST', `/api/runs/${id}/paypal/order`);
    row.paypal_order_id = order.body.id;
    if (dry) await j('POST', `/api/runs/${id}/replay/approve`);
    else {
      const snap = (await app.db.query(`SELECT body FROM paypal_snapshots WHERE run_id=$1 AND kind='CREATE_ORDER'`, [id])).rows[0].body;
      console.log(`\n[${i + 1}/${MATRIX.length}] ${label} — APPROVE (US-address Sandbox buyer):\n  ${snap.links.find((l) => /payer-action|approve/.test(l.rel))?.href}\n`);
      let status; for (let k = 0; k < 120; k++) { status = (await app.paypal.getOrder(order.body.id)).body.status; if (status === 'APPROVED') break; await sleep(3000); }
      if (status !== 'APPROVED') throw new Error('not approved within 6 min');
    }
    const hold = scenario === 'revoke_before_capture';
    const auth = await j('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id, ...(hold ? { defer_gate: true } : {}) });
    let d = auth.body.decision;
    if (hold) { // Path B: authority withdrawn after PayPal authorized and before capture
      await j('POST', `/api/runs/${id}/intent/revoke`, { reason: 'live matrix: revoked before capture' });
      d = (await j('POST', `/api/runs/${id}/evaluate`)).body.decision;
    }
    if (!d) throw new Error(JSON.stringify(auth.body));
    const retry1 = await j('POST', `/api/runs/${id}/evaluate`);
    const retry2 = await j('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id });
    const ev = (await j('GET', `/api/runs/${id}/evidence`)).body;
    Object.assign(row, { decision: d.decision, reason_codes: d.reason_codes, authorization_id: ev.run.authorization_id, idempotency_key: d.idempotency_key, paypal_action: d.paypal_action, paypal_http: d.paypal_response_status,
      retries_return_stored: retry1.body.decision?.replayed === true && retry2.body.decision?.replayed === true,
      paypal_actions_recorded: ev.actions.length, duplicate_action: ev.actions.length !== 1, ledger_chain_ok: ev.integrity.ok,
      passed: d.decision === expected && ev.actions.length === 1 && ev.actions[0].action === (expected === 'CAPTURE' ? 'capture' : 'void') });
  } catch (e) { row.error = e.message; row.passed = false; }
  rows.push(row); console.log(row.passed ? 'PASS' : 'FAIL', JSON.stringify({ n: row.n, label, decision: row.decision, reasons: row.reason_codes, err: row.error }));
}
await sleep(dry ? 800 : 8000);
const hooks = [];
for (const r of rows) if (r.run_id) { const w = (await j('GET', `/api/runs/${r.run_id}/evidence`)).body.webhooks; r.webhooks = w.map((x) => ({ type: x.event_type, verified: x.verified })); hooks.push(...w); }
const out = { generated_at: new Date().toISOString(), live: !dry, webhook_events_received: hooks.length,
  webhook_note: dry ? 'simulated' : hooks.length ? 'received' : 'none — expected when running locally; webhooks need the deployed public URL + PAYPAL_WEBHOOK_ID', rows };
writeFileSync(dry ? 'reports/live-matrix.dryrun.json' : 'reports/live-matrix.json', JSON.stringify(out, null, 2));
console.log(`\n${rows.filter((r) => r.passed).length}/${rows.length} passed · webhooks: ${out.webhook_note}`);
server.close(); await app.close(); process.exit(0);
