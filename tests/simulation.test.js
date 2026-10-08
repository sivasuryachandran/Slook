import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';

async function boot(env = {}) {
  const app = await createApp({ LIVE_PAYPAL: 'false', ...env });
  const server = app.listen(0); app.attachWebSocket(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, b, h = {}) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  return { app, api, base, close: async () => { server.close(); await app.close(); } };
}
async function settled(api, n, ms = 30_000) {
  const t0 = Date.now();
  for (;;) { const s = (await api('GET', '/api/simulation/stats')).body; if (s.decided >= n) return s; if (Date.now() - t0 > ms) throw new Error('timeout ' + JSON.stringify(s)); await new Promise((r) => setTimeout(r, 150)); }
}

test('every simulation scenario ends in the expected decision', { timeout: 60_000 }, async () => {
  const { api, close } = await boot();
  const expect = { valid_order: 'CAPTURE', price_mutation: 'VOID', quantity_mutation: 'VOID', sku_mutation: 'VOID', shipping_country_mismatch: 'VOID', poisoned_proposal: 'BLOCK', revoked_intent: 'VOID', malformed_ai_output: 'CAPTURE' };
  for (const [scenario, decision] of Object.entries(expect)) {
    const r = await api('POST', '/api/simulation/runs', { scenario, think_ms: 20 });
    assert.equal(r.status, 202); assert.equal(r.body.mode, 'MOCK_SIMULATION');
    await settled(api, Object.keys(expect).indexOf(scenario) + 1);
    const ev = (await api('GET', `/api/runs/${r.body.run_id}/evidence`)).body;
    assert.equal(ev.decision.decision, decision, scenario);
    assert.equal(ev.run.mode, 'MOCK_SIMULATION');
    assert.equal(ev.integrity.ok, true);
    if (scenario === 'malformed_ai_output') { assert.equal(ev.trace.trace_mode, 'REPLAY_AGENT_TRACE'); assert.match(ev.trace.error, /rejected/); }
  }
  const s = (await api('GET', '/api/simulation/stats')).body;
  assert.equal(s.mismatches_caught, 6); assert.equal(s.blocked_preflight, 1); assert.equal(s.mutations_missed, 0); assert.equal(s.false_blocks, 0); assert.equal(s.ai_fallback_rate > 0, true);
  await close();
});

test('25 concurrent shoppers: nothing missed, no false blocks, no errors, one action per run', { timeout: 60_000 }, async () => {
  const { api, app, close } = await boot();
  const r = await api('POST', '/api/simulation/runs', { count: 25, think_ms: 80 });
  assert.equal(r.status, 202); assert.equal(r.body.accepted, 25);
  const s = await settled(api, 25);
  assert.equal(s.total, 25); assert.equal(s.errors, 0); assert.equal(s.mutations_missed, 0); assert.equal(s.false_blocks, 0);
  assert.equal(s.captured + s.voided + s.blocked_preflight, 25);
  const dup = await app.db.query(`SELECT run_id, count(*) c FROM actions GROUP BY run_id HAVING count(*) > 1`);
  assert.equal(dup.rows.length, 0);
  await close();
});

test('state transitions stream over WebSocket in order and are persisted in the ledger', { timeout: 30_000 }, async () => {
  const { api, base, close } = await boot();
  const events = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  ws.on('message', (m) => events.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on('open', r));
  const r = await api('POST', '/api/simulation/runs', { scenario: 'price_mutation', think_ms: 20 });
  await settled(api, 1); await new Promise((r2) => setTimeout(r2, 600));
  const mine = events.filter((e) => e.run_id === r.body.run_id).map((e) => e.event);
  const order = ['run.created', 'ai.proposal.created', 'paypal.order.created', 'buyer.approval.required', 'buyer.approved', 'paypal.order.authorized', 'gate.evaluating', 'gate.blocked', 'gate.voided', 'run.completed'];
  let last = -1; for (const e of order) { const i = mine.indexOf(e); assert.ok(i > last, `${e} out of order in ${mine}`); last = i; }
  assert.ok(mine.includes('webhook.received'));
  const ev = (await api('GET', `/api/runs/${r.body.run_id}/evidence`)).body;
  for (const k of ['CONTRACT_FROZEN', 'ORDER_CREATED', 'BUYER_APPROVED', 'AUTHORIZED', 'GATE_EVALUATING', 'DECISION', 'WEBHOOK']) assert.ok(ev.events.some((x) => x.kind === k), k + ' not persisted');
  const blocked = events.find((e) => e.event === 'gate.blocked' && e.run_id === r.body.run_id);
  assert.equal(blocked.decision, 'VOID'); assert.match(blocked.reason, /amount\.total/); assert.equal(blocked.mode, 'MOCK_SIMULATION');
  ws.close(); await close();
});

test('simulation runs are isolated from the browser payment routes and the real adapter', { timeout: 30_000 }, async () => {
  const { api, close } = await boot();
  const r = await api('POST', '/api/simulation/runs', { scenario: 'valid_order', think_ms: 2000 });
  const id = r.body.run_id;
  // no browser route can authorize/evaluate/approve a simulation run
  assert.equal((await api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: 'x' })).status, 404);
  assert.equal((await api('POST', `/api/runs/${id}/evaluate`)).status, 404);
  assert.equal((await api('POST', `/api/runs/${id}/replay/approve`)).status, 404);
  // there is no simulation route that captures or voids
  for (const p of ['/api/simulation/capture', '/api/simulation/void', `/api/simulation/runs/${id}/capture`]) assert.equal((await api('POST', p)).status, 404);
  await settled(api, 1);
  await close();
});

test('limits: unknown scenario, count caps, operator key above 25, capacity', async () => {
  const { api, close } = await boot({ INTERNAL_ACTION_KEY: 'k', SIM_MAX_ACTIVE: '30' });
  assert.equal((await api('POST', '/api/simulation/runs', { scenario: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/simulation/runs', { count: 26 })).status, 401);
  assert.equal((await api('POST', '/api/simulation/runs', { count: 600 }, { 'x-internal-key': 'k' })).status, 400);
  assert.equal((await api('POST', '/api/simulation/runs', { count: 500 }, { 'x-internal-key': 'k' })).status, 429); // over SIM_MAX_ACTIVE
  assert.equal((await api('POST', '/api/simulation/reset')).status, 401);
  await close();
});
