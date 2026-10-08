import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createRealPayPal } from '../src/paypal/real.js';
import { startMockPayPal } from './harness/mockPayPal.js';

const REQ = 'Buy one black travel backpack under $90 delivered';
async function boot(mockOpts) {
  const mock = await startMockPayPal(mockOpts);
  const paypal = createRealPayPal({ clientId: 'id', clientSecret: 'secret', webhookId: 'WH1', baseUrl: mock.url });
  const app = await createApp({ LIVE_PAYPAL: 'false' }, { paypal });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { mock, api, app, close: async () => { server.close(); await app.close(); mock.close(); } };
}
async function toApproved(t, scenario = 'happy') {
  const run = await t.api('POST', '/api/runs', { request_text: REQ, scenario });
  const id = run.body.run_id;
  const order = await t.api('POST', `/api/runs/${id}/paypal/order`);
  return { id, orderId: order.body.id, order };
}

test('real client: create order is AUTHORIZE, carries custom_id and a stable PayPal-Request-Id', async () => {
  const t = await boot();
  const { id, orderId } = await toApproved(t);
  const call = t.mock.log.find((l) => l.url === '/v2/checkout/orders' && l.method === 'POST');
  assert.equal(call.body.intent, 'AUTHORIZE');
  assert.equal(call.rid, `sl:create:${id}:v1`);
  assert.equal(call.auth, 'Bearer');
  assert.match(call.body.purchase_units[0].custom_id, new RegExp(`^sl:${id}:h_[0-9a-f]{6}$`));
  // repeated browser request never creates a second PayPal order
  const again = await t.api('POST', `/api/runs/${id}/paypal/order`);
  assert.equal(again.body.id, orderId);
  assert.equal(t.mock.orders.size, 1);
  await t.close();
});

test('order creation failure surfaces as 502 and leaves the run retryable', async () => {
  const t = await boot();
  t.mock.state.failNext.create = true;
  const run = await t.api('POST', '/api/runs', { request_text: REQ });
  const bad = await t.api('POST', `/api/runs/${run.body.run_id}/paypal/order`);
  assert.equal(bad.status, 502);
  assert.ok(!JSON.stringify(bad.body).includes('secret'));
  const ok = await t.api('POST', `/api/runs/${run.body.run_id}/paypal/order`);
  assert.equal(ok.status, 201);
  await t.close();
});

test('authorize: success stores purchase_units[0].payments.authorizations[0].id; failure does not advance', async () => {
  const t = await boot();
  const { id, orderId } = await toApproved(t);
  t.mock.approve(orderId);
  t.mock.state.failNext.authorize = true;
  const bad = await t.api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: orderId });
  assert.equal(bad.status, 502);
  assert.equal((await t.api('GET', `/api/runs/${id}`)).body.authorization_id, null);
  const ok = await t.api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: orderId });
  assert.equal(ok.body.decision.decision, 'CAPTURE');
  const stored = (await t.api('GET', `/api/runs/${id}`)).body.authorization_id;
  assert.equal(stored, t.mock.orders.get(orderId).purchase_units[0].payments.authorizations[0].id);
  await t.close();
});

test('gate re-fetches with its own GET and ignores the order PayPal showed at authorize time', async () => {
  const t = await boot();
  const { id, orderId } = await toApproved(t);
  t.mock.approve(orderId);
  // PayPal-side drift between authorize and gate GET is impossible to hide: gate always GETs
  await t.api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: orderId, amount: '0.01' });
  const gets = t.mock.log.filter((l) => l.method === 'GET' && l.url === `/v2/checkout/orders/${orderId}`);
  assert.equal(gets.length, 1);
  await t.close();
});

for (const action of ['capture', 'void']) {
  test(`${action} failure: run stays retryable, retry reuses the same PayPal-Request-Id, no duplicate`, async () => {
    const t = await boot();
    const { id, orderId } = await toApproved(t, action === 'void' ? 'wrong_variant' : 'happy');
    t.mock.approve(orderId);
    t.mock.state.failNext[action] = true;
    const bad = await t.api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: orderId });
    assert.equal(bad.status, 502);
    assert.equal((await t.api('GET', `/api/runs/${id}`)).body.final_decision, null);
    const ok = await t.api('POST', `/api/runs/${id}/evaluate`);
    assert.equal(ok.body.decision.decision, action === 'capture' ? 'CAPTURE' : 'VOID');
    const calls = t.mock.log.filter((l) => l.url.endsWith('/' + action));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].rid, calls[1].rid);
    assert.equal(calls[0].rid, `sl:${action}:${id}:v1`);
    // repeated evaluate after success: no further PayPal call
    await t.api('POST', `/api/runs/${id}/evaluate`);
    assert.equal(t.mock.log.filter((l) => l.url.endsWith('/' + action)).length, 2);
    await t.close();
  });
}

test('webhooks: invalid signature rejected and not trusted; valid one stored once; out-of-order handled', async () => {
  const t = await boot();
  const { id, orderId } = await toApproved(t);
  const evt = { id: 'WH-REAL-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1', custom_id: 'x', supplementary_data: { related_ids: { order_id: orderId } } } };
  // out of order: webhook lands before the run is even authorized
  const early = await t.api('POST', '/api/webhooks/paypal', evt);
  assert.equal(early.status, 200);
  t.mock.state.sigResult = 'FAILURE';
  const forged = await t.api('POST', '/api/webhooks/paypal', { ...evt, id: 'WH-REAL-2' });
  assert.equal(forged.status, 401);
  t.mock.state.sigResult = 'SUCCESS';
  t.mock.approve(orderId);
  await t.api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: orderId });
  const dup = await t.api('POST', '/api/webhooks/paypal', evt);
  assert.equal(dup.body.duplicate, true);
  const ev = (await t.api('GET', `/api/runs/${id}/evidence`)).body;
  assert.equal(ev.run.status, 'RECONCILED'); // early webhook reconciled once the decision landed
  assert.equal(ev.webhooks.filter((w) => w.verified).length, 1);
  assert.equal(ev.webhooks.filter((w) => !w.verified).length, 1); // forged event kept as audit evidence, never trusted
  const verifyCall = t.mock.log.find((l) => l.url === '/v1/notifications/verify-webhook-signature');
  assert.equal(verifyCall.body.webhook_id, 'WH1');
  await t.close();
});

test('real client refuses non-sandbox env and non-loopback base overrides', () => {
  assert.throws(() => createRealPayPal({ clientId: 'a', clientSecret: 'b', env: 'live' }));
  assert.throws(() => createRealPayPal({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' }));
});
