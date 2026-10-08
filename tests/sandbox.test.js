// Real PayPal Sandbox integration. Skipped unless RUN_PAYPAL_SANDBOX=true (never runs by default).
//   RUN_PAYPAL_SANDBOX=true node --env-file=.env --test tests/sandbox.test.js            # non-interactive checks
//   RUN_PAYPAL_SANDBOX=true SANDBOX_INTERACTIVE=true node --env-file=.env --test tests/sandbox.test.js
// The interactive run prints a PayPal approval link; a human must approve with a Sandbox buyer account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRealPayPal } from '../src/paypal/real.js';

const ON = process.env.RUN_PAYPAL_SANDBOX === 'true';
const INTERACTIVE = process.env.SANDBOX_INTERACTIVE === 'true';
const REQ = 'Buy one black travel backpack under $90 delivered';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { skip: !ON && 'set RUN_PAYPAL_SANDBOX=true to run against the real PayPal Sandbox' };

test('sandbox: orders API keeps AUTHORIZE, custom_id, sku, variant; request-id is idempotent', opts, async () => {
  const pp = createRealPayPal({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET });
  const rid = 'sl:test:' + Date.now();
  const body = { intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r1', custom_id: 'sl:run_probe:h_abc123',
    amount: { currency_code: 'USD', value: '90.00', breakdown: { item_total: { currency_code: 'USD', value: '72.00' }, shipping: { currency_code: 'USD', value: '18.00' } } },
    items: [{ name: '20L travel backpack', sku: 'PACK-BLK-20L', description: 'variant=black', quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'USD', value: '72.00' } }] }] };
  const a = await pp.createOrder(body, rid);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await pp.createOrder(body, rid);
  assert.equal(b.body.id, a.body.id, 'same PayPal-Request-Id must return the same order');
  const got = await pp.getOrder(a.body.id);
  assert.equal(got.status, 200);
  const pu = got.body.purchase_units[0];
  assert.equal(got.body.intent, 'AUTHORIZE');
  assert.equal(pu.custom_id, 'sl:run_probe:h_abc123');
  assert.equal(pu.items[0].sku, 'PACK-BLK-20L');
  assert.equal(pu.items[0].description, 'variant=black');
  assert.equal(pu.amount.value, '90.00');
  assert.ok(a.debugId);
});

test('sandbox: gate rejects authorize of an unapproved order without any money action', opts, async () => {
  const app = await createApp({ ...process.env, LIVE_PAYPAL: 'true', REPLAY_MODE: 'true' });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  const run = await j('POST', '/api/runs', { request_text: REQ });
  const order = await j('POST', `/api/runs/${run.body.run_id}/paypal/order`);
  assert.equal(order.status, 201);
  const auth = await j('POST', `/api/runs/${run.body.run_id}/paypal/authorize`, { orderID: order.body.id });
  assert.equal(auth.status, 502); // PayPal refuses: buyer has not approved
  const ev = await j('GET', `/api/runs/${run.body.run_id}/evidence`);
  assert.equal(ev.body.actions.length, 0);
  assert.equal(ev.body.run.final_decision, null);
  server.close(); await app.close();
});

test('sandbox: an open-world multi-item order round-trips through real PayPal and the gate would read it identically', opts, async () => {
  const app = await createApp({ ...process.env, LIVE_PAYPAL: 'true', REPLAY_MODE: 'true' });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  const run = await j('POST', '/api/runs', { request_text: 'Buy 12 donuts and 3 kg of grapes for Friday morning under $80.' });
  assert.equal(run.body.status, 'READY'); assert.equal(run.body.preflight.decision, 'PASS');
  const order = await j('POST', `/api/runs/${run.body.run_id}/paypal/order`);
  assert.equal(order.status, 201);
  const got = (await app.paypal.getOrder(order.body.id)).body;
  const { normalizeOrder } = await import('../src/gate.js');
  const n = normalizeOrder(got);
  assert.equal(n.items.length, 2); assert.deepEqual(n.items.map((i) => [i.sku, i.quantity, i.unit]), [['WEB-DONUT-GLZ', 12, '1.25'], ['WEB-GRAPE-KG', 3, '6.50']]);
  assert.equal(n.total, '39.50'); assert.equal(n.shipping, '5.00'); assert.equal(n.currency, 'USD'); assert.equal(n.intent, 'AUTHORIZE');
  assert.equal(n.customId, `sl:${run.body.run_id}:h_${run.body.contract.contract_hash.replace('sha256:', '').slice(0, 6)}`);
  server.close(); await app.close();
});

test('sandbox: a poisoned proposal never reaches PayPal (zero real calls)', opts, async () => {
  const app = await createApp({ ...process.env, LIVE_PAYPAL: 'true', REPLAY_MODE: 'true' });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const calls = []; for (const fn of ['createOrder', 'getOrder', 'authorizeOrder']) { const o = app.paypal[fn].bind(app.paypal); app.paypal[fn] = (...a) => { calls.push(fn); return o(...a); }; }
  const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  const run = await j('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.', scenario: 'poisoned_proposal' });
  assert.equal(run.body.status, 'BLOCKED');
  assert.equal((await j('POST', `/api/runs/${run.body.run_id}/paypal/order`)).status, 409);
  assert.deepEqual(calls, []);
  server.close(); await app.close();
});

for (const [scenario, expected] of [['happy', 'CAPTURE'], ['revoke_before_capture', 'VOID']]) {
  test(`sandbox INTERACTIVE: ${scenario} → ${expected} (human approves in PayPal)`, { ...opts, skip: (!ON || !INTERACTIVE) && 'needs RUN_PAYPAL_SANDBOX=true SANDBOX_INTERACTIVE=true and a human buyer', timeout: 400_000 }, async () => {
    const app = await createApp({ ...process.env, LIVE_PAYPAL: 'true', REPLAY_MODE: 'true' });
    const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
    const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
    const run = await j('POST', '/api/runs', { request_text: REQ, scenario });
    const id = run.body.run_id; const hold = scenario === 'revoke_before_capture';
    const order = await j('POST', `/api/runs/${id}/paypal/order`);
    const snap = (await app.db.query(`SELECT body FROM paypal_snapshots WHERE run_id=$1 AND kind='CREATE_ORDER'`, [id])).rows[0].body;
    const link = snap.links.find((l) => /approve|payer-action/.test(l.rel))?.href;
    console.log(`\n>>> APPROVE (${scenario}) with a Sandbox buyer: ${link}\n`);
    let status;
    for (let i = 0; i < 100; i++) { status = (await app.paypal.getOrder(order.body.id)).body.status; if (status === 'APPROVED') break; await sleep(3000); }
    assert.equal(status, 'APPROVED', 'buyer did not approve in time');
    let auth = await j('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id, ...(hold ? { defer_gate: true } : {}) });
    if (hold) { await j('POST', `/api/runs/${id}/intent/revoke`, { reason: 'sandbox test' }); auth = await j('POST', `/api/runs/${id}/evaluate`); }
    assert.equal(auth.body.decision.decision, expected);
    const ev = (await j('GET', `/api/runs/${id}/evidence`)).body;
    assert.equal(ev.actions.length, 1);
    assert.ok(/^[A-Z0-9]+$/.test(ev.run.authorization_id));
    const retry = await j('POST', `/api/runs/${id}/evaluate`);
    assert.equal(retry.body.decision.replayed, true);
    server.close(); await app.close();
  });
}
