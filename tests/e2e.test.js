import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const REQ = 'Buy one black travel backpack under $90 delivered';
async function boot() {
  const app = await createApp({ LIVE_PAYPAL: 'false' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { api, close: async () => { server.close(); await app.close(); } };
}
async function runFlow(api, scenario = 'happy') {
  const run = await api('POST', '/api/runs', { request_text: REQ, scenario });
  assert.equal(run.status, 201);
  const id = run.body.run_id;
  const order = await api('POST', `/api/runs/${id}/paypal/order`);
  await api('POST', `/api/runs/${id}/replay/approve`);
  const auth = await api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id });
  return { id, order: order.body.id, auth };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('happy path captures, reconciles via webhook, evidence is complete', async () => {
  const { api, close } = await boot();
  const { id, auth } = await runFlow(api);
  assert.equal(auth.body.decision.decision, 'CAPTURE');
  assert.equal(auth.body.decision.idempotency_key, `sl:capture:${id}:v1`);
  await sleep(1200);
  const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
  assert.equal(ev.run.status, 'RECONCILED');
  assert.equal(ev.run.final_decision, 'CAPTURE');
  assert.ok(ev.snapshots.some((s) => s.kind === 'GATE_FRESH_GET'));
  assert.equal(ev.trace.trace_mode, 'REPLAY_AGENT_TRACE');
  assert.equal(ev.webhooks.length, 1);
  await close();
});

for (const [scenario, expectCodes] of [
  ['demo_mismatch', ['amount.total', 'items.sku', 'items.variant', 'policy.substitution']],
  ['wrong_variant', ['items.sku', 'items.variant', 'policy.substitution']],
  ['inflated_total', ['amount.total', 'items.unit_amount']],
  ['wrong_quantity', ['amount.total', 'items.quantity']],
]) {
  test(`${scenario} is voided, never captured`, async () => {
    const { api, close } = await boot();
    const { id, auth } = await runFlow(api, scenario);
    assert.equal(auth.body.decision.decision, 'VOID');
    for (const c of expectCodes) assert.ok(auth.body.decision.reason_codes.includes(c), `missing ${c}: ${auth.body.decision.reason_codes}`);
    const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
    assert.ok(!ev.actions.some((a) => a.action === 'capture'));
    assert.equal(ev.actions.find((a) => a.action === 'void').status, 'DONE');
    await close();
  });
}

test('retries and concurrent evaluation produce one final action', async () => {
  const { api, close } = await boot();
  const { id, order } = await runFlow(api);
  const results = await Promise.all([1, 2, 3, 4].map(() => api('POST', `/api/runs/${id}/evaluate`)));
  assert.ok(results.every((r) => r.body.decision.decision === 'CAPTURE'));
  const again = await api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order });
  assert.equal(again.body.decision.replayed, true);
  const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
  assert.equal(ev.actions.length, 1);
  assert.equal(ev.snapshots.filter((s) => s.kind === 'GATE_FRESH_GET').length, 1);
  await close();
});

test('browser cannot supply authority data or foreign order ids', async () => {
  const { api, close } = await boot();
  const a = await api('POST', '/api/runs', { request_text: REQ });
  const b = await api('POST', '/api/runs', { request_text: REQ });
  const oa = await api('POST', `/api/runs/${a.body.run_id}/paypal/order`);
  await api('POST', `/api/runs/${b.body.run_id}/paypal/order`);
  const bad = await api('POST', `/api/runs/${b.body.run_id}/paypal/authorize`, { orderID: oa.body.id });
  assert.equal(bad.status, 400);
  // evaluate before authorization is rejected, body amounts are ignored
  const early = await api('POST', `/api/runs/${a.body.run_id}/evaluate`, { amount: '1.00', decision: 'CAPTURE' });
  assert.equal(early.status, 409);
  for (const p of ['capture', 'void', 'paypal/capture', 'paypal/void']) {
    const r = await api('POST', `/api/runs/${a.body.run_id}/${p}`);
    assert.equal(r.status, 404);
  }
  // order creation is idempotent
  const again = await api('POST', `/api/runs/${a.body.run_id}/paypal/order`);
  assert.equal(again.body.id, oa.body.id);
  await close();
});

test('duplicate webhooks yield one ledger event; unverified webhook rejected', async () => {
  const { api, close } = await boot();
  const { id } = await runFlow(api);
  await sleep(1200);
  const dup = { id: 'WH-SIM-dup1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: (await api('GET', `/api/runs/${id}`)).body.contract_hash && `sl:${id}:h_x` } };
  const w1 = await api('POST', '/api/webhooks/paypal', dup);
  const w2 = await api('POST', '/api/webhooks/paypal', dup);
  assert.equal(w1.body.duplicate, false);
  assert.equal(w2.body.duplicate, true);
  const forged = await api('POST', '/api/webhooks/paypal', { id: 'EVIL-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });
  assert.equal(forged.status, 401);
  const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
  assert.equal(ev.webhooks.filter((w) => w.event_id === 'WH-SIM-dup1').length, 1);
  await close();
});

test('proposal over the shopper limit is rejected; fixtures need operator key when set', async () => {
  const { api, close } = await boot();
  const r = await api('POST', '/api/runs', { request_text: 'Buy one black travel backpack under $50 delivered' });
  assert.equal(r.status, 422);
  await close();
  const app = await createApp({ LIVE_PAYPAL: 'false', INTERNAL_ACTION_KEY: 'k' });
  const server = app.listen(0);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_text: REQ, scenario: 'demo_mismatch' }) });
  assert.equal(res.status, 401);
  server.close(); await app.close();
});

test('expired intent is voided at the gate', async () => {
  const app = await createApp({ LIVE_PAYPAL: 'false', INTENT_TTL_MIN: '0.0003' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
  const run = await api('POST', '/api/runs', { request_text: REQ });
  const order = await api('POST', `/api/runs/${run.run_id}/paypal/order`);
  await api('POST', `/api/runs/${run.run_id}/replay/approve`);
  await sleep(100);
  const res = await api('POST', `/api/runs/${run.run_id}/paypal/authorize`, { orderID: order.id });
  assert.equal(res.decision.decision, 'VOID');
  assert.deepEqual(res.decision.reason_codes, ['intent.fresh']);
  server.close(); await app.close();
});

test('audit ledger is hash-chained and tampering is detected', async () => {
  const { api, close } = await boot();
  const { id } = await runFlow(api);
  const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
  assert.equal(ev.integrity.ok, true);
  assert.ok(ev.integrity.events >= 4);
  await close();
  const app = await createApp({ LIVE_PAYPAL: 'false' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
  const run = await j('POST', '/api/runs', { request_text: REQ });
  await app.db.query(`UPDATE ledger_events SET detail='{"forged":true}' WHERE run_id=$1`, [run.run_id]);
  assert.equal((await j('GET', `/api/runs/${run.run_id}/evidence`)).integrity.ok, false);
  server.close(); await app.close();
});

test('replay traces re-evaluate deterministically with no credentials and are labelled REPLAY', async () => {
  const { api, close } = await boot();
  const list = (await api('GET', '/api/replay')).body;
  assert.ok(list.length >= 9);
  assert.ok(list.every((t) => t.reproduced === true && t.label === 'REPLAY'));
  assert.equal(list.find((t) => t.id === 'T00').decision, 'CAPTURE');
  assert.ok(list.filter((t) => t.fixture).every((t) => t.decision === 'VOID'));
  const one = (await api('GET', '/api/replay/T03')).body;
  assert.match(one.label, /REPLAY MODE/);
  assert.ok(one.model && one.model_raw_output && one.recorded_at && one.paypal_order_fixture);
  await close();
});
