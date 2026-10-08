// Live proof against a DEPLOYED Slook (real PayPal Sandbox + real webhooks). No credentials live here.
//   node scripts/live-hosted.js https://<service>.onrender.com
// Buyer approval: prints the PayPal link. If APPROVE_CMD is set (e.g. "node approve.mjs") it is invoked with the link;
// otherwise a human approves in the browser. Writes reports/live-hosted.json.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https:\/\//.test(base)) throw new Error('usage: node scripts/live-hosted.js https://<host>');
const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = (await j('GET', '/api/config')).body;
if (cfg.mode !== 'LIVE_SANDBOX') throw new Error(`host is ${cfg.mode}, not LIVE_SANDBOX`);

async function oneRun(label, text, kind) {
  const row = { label, kind, host: base };
  const run = await j('POST', '/api/runs', { request_text: text, scenario: 'happy' });
  if (run.body.status !== 'READY') throw new Error(JSON.stringify(run.body));
  const id = row.run_id = run.body.run_id;
  const order = await j('POST', `/api/runs/${id}/paypal/order`); row.paypal_order_id = order.body.id;
  const link = `https://www.sandbox.paypal.com/checkoutnow?token=${order.body.id}`;
  console.log(`\n[${label}] approve: ${link}`);
  if (process.env.APPROVE_CMD) { const [c, ...a] = process.env.APPROVE_CMD.split(' '); spawn(c, [...a, link, label.replace(/\W+/g, '')], { stdio: ['ignore', 'ignore', 'inherit'] }); }
  let auth;
  for (let i = 0; i < 120; i++) { // authorize only succeeds once the buyer has approved
    auth = await j('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id, ...(kind === 'void' ? { defer_gate: true } : {}) });
    if (auth.status === 200) break; await sleep(3000);
  }
  if (auth.status !== 200) throw new Error('not approved in time');
  if (kind === 'void') { await j('POST', `/api/runs/${id}/intent/revoke`, { reason: 'hosted live proof: revoked before capture' }); auth = await j('POST', `/api/runs/${id}/evaluate`); }
  const d = auth.body.decision; row.decision = d.decision; row.reason_codes = d.reason_codes; row.paypal_action = d.paypal_action; row.idempotency_key = d.idempotency_key; row.adapter_mode = d.adapter_mode;
  const retry = await j('POST', `/api/runs/${id}/evaluate`); row.retry_returns_stored = retry.body.decision?.replayed === true;
  const want = kind === 'void' ? 'PAYMENT.AUTHORIZATION.VOIDED' : 'PAYMENT.CAPTURE.COMPLETED';
  let ev; for (let i = 0; i < 40; i++) { ev = (await j('GET', `/api/runs/${id}/evidence`)).body; if (ev.webhooks?.some((w) => w.event_type === want && w.verified)) break; await sleep(3000); }
  row.authorization_id = ev.run.authorization_id; row.final_status = ev.run.status; row.actions = ev.actions.map((a) => a.action); row.signature_valid = ev.signature_check?.ok; row.ledger_chain_ok = ev.integrity?.ok;
  row.webhooks = ev.webhooks.map((w) => ({ type: w.event_type, verified: w.verified, verification: w.verification, event_id: w.event_id }));
  row.passed = row.decision === (kind === 'void' ? 'VOID' : 'CAPTURE') && row.actions.length === 1 && row.retry_returns_stored && !!ev.webhooks.find((w) => w.event_type === want && w.verified) && row.final_status === 'RECONCILED';
  console.log(row.passed ? 'PASS' : 'FAIL', JSON.stringify({ decision: row.decision, status: row.final_status, webhooks: row.webhooks.map((w) => `${w.type}:${w.verified ? 'verified' : 'UNVERIFIED'}`) }));
  return row;
}
const rows = [];
rows.push(await oneRun('Hosted Path C: clean capture', 'Buy biryani tonight under $25.', 'capture'));
rows.push(await oneRun('Hosted Path B: revoke then void', 'Buy 12 donuts and 3 kg of grapes for Friday morning under $80.', 'void'));
writeFileSync('reports/live-hosted.json', JSON.stringify({ generated_at: new Date().toISOString(), host: base, mode: cfg.mode, rows }, null, 2));
console.log(`\n${rows.filter((r) => r.passed).length}/${rows.length} passed`); process.exit(0);
