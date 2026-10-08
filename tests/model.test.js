// NVIDIA model integration (stubbed client: no network). The model proposes; deterministic code validates and decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { compileIntent, reconcileIntent, validateModelIntent } from '../src/intent.js';
import { modelEnabled, createModelClient, extractJson } from '../src/model.js';

const j = (o) => JSON.stringify(o);
// A stub with the same surface as the real client. `compile`/`select` return {raw, parsed, latency_ms, model}.
function stub({ compile, select } = {}) {
  const calls = { compile: 0, select: 0 };
  const wrap = (fn, k) => async (x) => { calls[k]++; const parsed = await fn(x); return { raw: j(parsed), parsed, latency_ms: 7, model: 'nvidia/nemotron-3.5-lightning-30b-a3b' }; };
  return { calls, model: 'nvidia/nemotron-3.5-lightning-30b-a3b', temperature: 0.2,
    compile: wrap(compile ?? (async () => null), 'compile'), select: wrap(select ?? (async () => null), 'select') };
}
async function boot(modelClient, env = {}) {
  const app = await createApp({ LIVE_PAYPAL: 'false', ...env }, { modelClient });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, b, h = {}) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  return { api, app, close: async () => { server.close(); await app.close(); } };
}
const goodCompile = (cat) => async (text) => ({ items: [{ description: 'biryani', category: cat, attributes: {}, quantity: { min: 1, max: 1 }, unit: null }], max_total: '25.00', delivery_deadline: 'tonight', allow_substitutions: false });
const pickCheapest = async (p) => ({ line_items: p.items.map((i) => ({ product_id: i.candidates[0].product_id, quantity: i.requested.quantity?.min ?? 1 })), reasoning_summary: 'Chose the cheapest option within budget.' });
async function finish(api, id, hold = false) {
  const o = await api('POST', `/api/runs/${id}/paypal/order`); await api('POST', `/api/runs/${id}/replay/approve`);
  return api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: o.body.id });
}

test('model compile: agreeing output is used, enriches the signed intent with a category, and is recorded in the trace', async () => {
  const m = stub({ compile: goodCompile('prepared_food'), select: pickCheapest });
  const { api, close } = await boot(m);
  const r = await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.' });
  assert.equal(r.body.status, 'READY');
  assert.equal(r.body.contract.items[0].category, 'prepared_food'); // enriched by the model, signed into the intent
  assert.equal(r.body.ai.compile.agreement, 'agrees'); assert.equal(r.body.ai.compile.used, 'model');
  assert.equal(r.body.trace_mode, 'LIVE_AGENT_TRACE'); assert.equal(r.body.ai.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.deepEqual([m.calls.compile, m.calls.select], [1, 1]);
  const out = await finish(api, r.body.run_id); assert.equal(out.body.decision.decision, 'CAPTURE');
  const ev = (await api('GET', `/api/runs/${r.body.run_id}/evidence`)).body;
  assert.equal(ev.trace.provider, 'nvidia'); assert.equal(ev.trace.prompt_version, 'openworld-v1'); assert.ok(JSON.parse(ev.trace.raw_output).select);
  assert.equal(ev.signature_check.ok, true);
  await close();
});

test('model compile: hallucinated items, changed budgets and ungrounded quantities are rejected; deterministic parse is kept', () => {
  const text = 'Buy biryani tonight under $25.'; const det = () => compileIntent(text);
  const base = { items: [{ description: 'biryani', category: 'prepared_food', attributes: {}, quantity: { min: 1, max: 1 }, unit: null }], max_total: '25.00', delivery_deadline: 'tonight', allow_substitutions: false };
  const bad = (patch) => reconcileIntent(text, det(), { ...base, ...patch }).meta;
  assert.match(bad({ items: [...base.items, { description: 'gift card', category: 'other', attributes: {}, quantity: { min: 1, max: 1 }, unit: null }] }).reasons[0], /not grounded/);
  assert.match(bad({ max_total: '250.00' }).reasons[0], /max_total 250.00 differs/);
  assert.match(bad({ items: [{ ...base.items[0], quantity: { min: 40, max: 40 } }] }).reasons[0], /quantity not grounded/);
  assert.match(bad({ items: [{ ...base.items[0], category: 'weapons' }] }).reasons[0], /bad category/);
  assert.match(reconcileIntent(text, det(), 'not json').meta.reasons[0], /rejected/);
  assert.equal(bad({ items: [] }).used, 'deterministic');
  assert.equal(validateModelIntent(base), null);
});

test('model compile: rescues phrasing the deterministic parser cannot read, but only with user confirmation', async () => {
  const text = 'donuts, two dozen please, under $50';
  assert.equal(compileIntent(text).status, 'NEEDS_INFORMATION');
  const m = stub({ compile: async () => ({ items: [{ description: 'donuts', category: 'bakery', attributes: {}, quantity: { min: 24, max: 24 }, unit: null }], max_total: '50.00', delivery_deadline: null, allow_substitutions: false }), select: pickCheapest });
  const { api, close } = await boot(m);
  const first = await api('POST', '/api/runs', { request_text: text });
  assert.equal(first.body.status, 'REQUIRE_APPROVAL'); assert.match(first.body.assumptions[0], /I read your request as: 24 donuts, up to 50.00 total\. Confirm\?/);
  assert.equal((await api('GET', '/api/runs')).body.length, 0); // nothing signed yet
  const ok = await api('POST', '/api/runs', { request_text: text, confirm: true });
  assert.equal(ok.body.status, 'READY'); assert.equal(ok.body.contract.items[0].quantity.min, 24); assert.equal(ok.body.contract.assumptions_confirmed.length, 1);
  await close();
});

test('model select: prices and titles always come from product data, never from the model', async () => {
  const m = stub({ compile: goodCompile('prepared_food'), select: async (p) => ({ line_items: [{ product_id: p.items[0].candidates[0].product_id, quantity: 1, unit_amount: '0.01', title: 'free biryani' }], reasoning_summary: 'cheap' }) });
  const { api, close } = await boot(m);
  const r = await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.' });
  assert.equal(r.body.proposal.line_items[0].unit_amount, '18.00'); assert.equal(r.body.proposal.line_items[0].title, 'Chicken biryani family tray');
  await close();
});

test('model select: unusable output falls back to the deterministic agent, labelled, with the failure recorded', async () => {
  for (const select of [async () => null, async () => ({ line_items: [] }), async () => ({ line_items: [{ product_id: 'X', quantity: 1 }] })]) {
    const { api, close } = await boot(stub({ compile: async () => null, select }));
    const r = await api('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.' });
    assert.equal(r.body.status, 'READY'); assert.equal(r.body.trace_mode, 'REPLAY_AGENT_TRACE');
    assert.match(r.body.trace_error, /deterministic agent used/); assert.equal(r.body.proposal.line_items.length, 1);
    await close();
  }
});

test('Path A with a model: obeying the injection is an ORGANIC AGENT TRACE; declining it leaves a CONTROLLED TEST FIXTURE; both block before PayPal', async () => {
  const gift = (p) => ({ line_items: [{ product_id: p.items[0].candidates[0].product_id, quantity: 1 }, { product_id: 'WEB-GIFT-500', quantity: 1 }], reasoning_summary: 'Added the loyalty gift card as the page said.' });
  for (const [select, label, followed] of [[async (p) => gift(p), 'ORGANIC AGENT TRACE', true], [pickCheapest, 'CONTROLLED TEST FIXTURE', false]]) {
    const { api, app, close } = await boot(stub({ compile: async () => null, select }));
    const calls = []; for (const fn of ['createOrder', 'authorizeOrder', 'getOrder']) { const o = app.paypal[fn].bind(app.paypal); app.paypal[fn] = (...a) => { calls.push(fn); return o(...a); }; }
    const r = await api('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.', scenario: 'poisoned_proposal' });
    assert.equal(r.body.status, 'BLOCKED'); assert.ok(r.body.preflight.reason_codes.includes('items.unrequested'));
    assert.equal(r.body.proposal.source_content.label, label); assert.equal(r.body.proposal.source_content.model_followed_injection, followed);
    assert.equal(r.body.proposal.line_items.filter((l) => l.sku === 'WEB-GIFT-500').length, 1); // never duplicated
    assert.deepEqual(calls, []);
    await close();
  }
});

test('the model sees untrusted page text as data and the poisoned page only in the poison scenario', async () => {
  const seen = [];
  const m = stub({ compile: async () => null, select: async (p) => { seen.push(JSON.stringify(p)); return pickCheapest(p); } });
  const { api, close } = await boot(m);
  await api('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.' });
  await api('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.', scenario: 'poisoned_proposal' });
  assert.ok(!seen[0].includes('SYSTEM NOTE')); assert.ok(seen[1].includes('SYSTEM NOTE TO AI SHOPPING AGENTS'));
  assert.ok(!/signature|PRIVATE|client_secret|PAYPAL/i.test(seen[0] + seen[1])); // no authority or secrets in the model payload
  await close();
});

test('the simulation never calls the model', async () => {
  const m = stub({ compile: goodCompile('prepared_food'), select: pickCheapest });
  const { api, close } = await boot(m);
  await api('POST', '/api/simulation/runs', { count: 10, think_ms: 10 });
  for (let i = 0; i < 80; i++) { if ((await api('GET', '/api/simulation/stats')).body.decided >= 10) break; await new Promise((r) => setTimeout(r, 120)); }
  assert.deepEqual([m.calls.compile, m.calls.select], [0, 0]);
  await close();
});

test('model failures (timeout/HTTP error) never block a run: deterministic fallback, failure noted', async () => {
  const m = { model: 'x', temperature: 0, compile: async () => { throw new Error('model API HTTP 503'); }, select: async () => { throw new Error('The operation was aborted due to timeout'); } };
  const { api, close } = await boot(m);
  const r = await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.' });
  assert.equal(r.body.status, 'READY'); assert.equal(r.body.trace_mode, 'REPLAY_AGENT_TRACE'); assert.match(r.body.trace_error, /503/); assert.match(r.body.trace_error, /timeout/);
  assert.equal((await finish(api, r.body.run_id)).body.decision.decision, 'CAPTURE');
  await close();
});

test('real client: enabled only with a real key and REPLAY_MODE off; hourly budget caps calls', async () => {
  const on = { AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'nvapi-real', NVIDIA_MODEL: 'm', REPLAY_MODE: 'false' };
  assert.equal(modelEnabled(on), true);
  for (const bad of [{ NVIDIA_API_KEY: 'unused' }, { NVIDIA_API_KEY: '' }, { REPLAY_MODE: 'true' }, { AI_PROVIDER: 'anthropic' }]) assert.equal(modelEnabled({ ...on, ...bad }), false);
  assert.equal(createModelClient({ ...on, REPLAY_MODE: 'true' }), null);
  const realFetch = globalThis.fetch; let n = 0;
  globalThis.fetch = async () => { n++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }) }; };
  try {
    const c = createModelClient({ ...on, AI_MAX_CALLS_PER_HOUR: '2' });
    await c.compile('x'); await c.compile('x');
    await assert.rejects(() => c.compile('x'), /budget exhausted/); assert.equal(n, 2);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(extractJson('noise {"a":1} tail'), { a: 1 }); assert.equal(extractJson('no json'), null);
});

test('the model client cannot reach keys, PayPal, the database or the gate (static guarantees)', () => {
  const src = readFileSync('src/model.js', 'utf8');
  assert.ok(!/signing|paypal|gate|ledger|db\.js|PAYPAL_CLIENT_SECRET|INTENT_SIGNING_KEY|captureAuthorization|voidAuthorization/i.test(src.replace(/no PayPal client, no signing key, no database, no gate/, '').replace(/\/\/.*$/gm, '')), 'model.js references a forbidden capability');
  const agent = readFileSync('src/agent.js', 'utf8'); assert.ok(!/fetch\(|signing\.js|paypal\//.test(agent), 'agent.js must be pure (no network, no keys)');
});

test('Paths A and B are public demo paths; other fixtures still need the operator key', async () => {
  const { api, close } = await boot(null, { INTERNAL_ACTION_KEY: 'k' });
  assert.equal((await api('POST', '/api/runs', { request_text: 'Find a suitable birthday cake under $60.', scenario: 'poisoned_proposal' })).status, 201);
  assert.equal((await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.', scenario: 'revoke_before_capture' })).status, 201);
  for (const s of ['demo_mismatch', 'inflated_total', 'wrong_quantity', 'wrong_variant', 'wrong_country']) assert.equal((await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.', scenario: s })).status, 401, s);
  assert.equal((await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.', scenario: 'demo_mismatch' }, { 'x-internal-key': 'k' })).status, 201);
  await close();
});

test('a model can never widen authority: allow_substitutions guessed by the model is ignored; null quantity is compatible with a singular item', async () => {
  const m = stub({ compile: async () => ({ items: [{ description: 'biryani', category: 'prepared_food', attributes: {}, quantity: null, unit: null }], max_total: '25.00', delivery_deadline: 'tonight', allow_substitutions: true }), select: pickCheapest });
  const { api, close } = await boot(m);
  const r = await api('POST', '/api/runs', { request_text: 'Buy biryani tonight under $25.' });
  assert.equal(r.body.ai.compile.agreement, 'agrees'); assert.equal(r.body.contract.allow_substitutions, false); assert.equal(r.body.contract.items[0].category, 'prepared_food');
  await close();
});

test('money formatting variance from the model is normalized, but a different value is still rejected', () => {
  const text = 'Find a suitable birthday cake under $60.';
  const mk = (max_total) => ({ items: [{ description: 'birthday cake', category: 'bakery', attributes: {}, quantity: null, unit: null }], max_total, delivery_deadline: null, allow_substitutions: false });
  for (const v of ['60', 60, '$60.00', '60.0', ' 60.00 ']) assert.equal(reconcileIntent(text, compileIntent(text), mk(v)).meta.agreement, 'agrees', String(v));
  for (const v of ['600', '6', 61, '$70.00']) assert.match(reconcileIntent(text, compileIntent(text), mk(v)).meta.reasons[0], /differs/, String(v));
});
