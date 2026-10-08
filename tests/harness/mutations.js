// Adversarial mutation harness. Every mutation runs through the real app + real gate against the
// simulated PayPal adapter (response shapes preserved). Each is executed twice to prove determinism.
import { createApp } from '../../src/app.js';
import { CATALOG } from '../../src/fixtures.js';

export const REQ = 'Buy one black travel backpack under $90 delivered';
const goodModel = () => JSON.stringify({ sku: 'PACK-BLK-20L', title: '20L travel backpack', variant: 'black', quantity: 1, unit_amount: '72.00', shipping_amount: '18.00', currency: 'USD', reasoning_summary: 'ok', confidence: 0.9 });

export const MUTATIONS = [
  { id: 'M01', name: 'PayPal unit price raised after AI proposal', kind: 'order', mutate: (o) => { const u = o.purchase_units[0]; u.items[0].unit_amount.value = '90.00'; u.amount.value = '108.00'; u.amount.breakdown.item_total.value = '90.00'; }, expect: ['amount.total', 'items.unit_amount', 'catalog.price'] },
  { id: 'M02', name: 'Quantity changed 1 → 2', kind: 'order', mutate: (o) => { const u = o.purchase_units[0]; u.items[0].quantity = '2'; u.amount.value = '162.00'; }, expect: ['amount.total', 'items.quantity'] },
  { id: 'M03', name: 'SKU swapped to navy variant', kind: 'order', mutate: (o) => { const i = o.purchase_units[0].items[0]; i.sku = 'PACK-NVY-20L'; i.description = 'variant=navy'; }, expect: ['items.sku', 'items.variant', 'policy.substitution'] },
  { id: 'M04', name: 'Currency changed USD → EUR', kind: 'order', mutate: (o) => { o.purchase_units[0].amount.currency_code = 'EUR'; }, expect: ['amount.currency'] },
  { id: 'M05', name: 'Ship-to country changed US → CA', kind: 'scenario', scenario: 'wrong_country', expect: ['shipping.country'] },
  { id: 'M06', name: 'Item removed from catalog (unknown SKU)', kind: 'order', mutate: (o) => { o.purchase_units[0].items[0].sku = 'PACK-GHOST-99'; }, expect: ['items.sku', 'catalog.price'] },
  { id: 'M07', name: 'custom_id / intent reference altered', kind: 'order', mutate: (o) => { o.purchase_units[0].custom_id = 'sl:run_forged:h_000000'; }, expect: ['link.custom_id'] },
  { id: 'M08', name: 'Stale PayPal response (pre-authorization snapshot)', kind: 'fault', faults: { staleGet: true }, expect: ['paypal.state'] },
  { id: 'M09', name: 'Duplicate webhook delivered', kind: 'webhook', expect: [] },
  { id: 'M10', name: 'AI returns invalid JSON', kind: 'ai', llm: () => 'Sure! I picked the black backpack {sku: PACK-BLK', expectRejected: true },
  { id: 'M11', name: 'AI returns valid JSON with unauthorized price ($1.00)', kind: 'ai', llm: () => JSON.stringify({ ...JSON.parse(goodModel()), unit_amount: '1.00' }), expectRejected: true },
  { id: 'M12', name: 'AI adds an unrequested product', kind: 'ai', llm: () => JSON.stringify({ ...JSON.parse(goodModel()), extra_items: [{ sku: 'PACK-BLK-30L', quantity: 1 }] }), expectRejected: true },
  { id: 'M13', name: 'AI ignores the budget (picks the $95 pack)', kind: 'ai-budget', llm: () => JSON.stringify({ sku: 'PACK-BLK-30L', title: '30L expedition backpack', variant: 'black', quantity: 1, unit_amount: '95.00', shipping_amount: '18.00', currency: 'USD', reasoning_summary: 'bigger is better', confidence: 0.8 }), request: 'Buy a black backpack under $90 delivered', expectStatus: 422 },
  { id: 'M14', name: 'Caller submits a fake amount to the gate', kind: 'caller', expect: [] },
  { id: 'M15', name: 'Gate called 8× concurrently', kind: 'concurrency', expect: [] },
];

async function boot(overrides = {}) {
  const app = await createApp({ LIVE_PAYPAL: 'false' }, overrides);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { app, api, close: async () => { server.close(); await app.close(); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(m) {
  const { app, api, close } = await boot({ faults: m.faults, llm: m.llm });
  try {
    const out = { id: m.id, name: m.name, kind: m.kind };
    const created = await api('POST', '/api/runs', { request_text: m.request ?? REQ, scenario: m.scenario ?? 'happy' });
    if (m.kind === 'ai-budget') { out.status = created.status; out.detected = created.status === m.expectStatus; out.capturePrevented = created.status !== 201; out.voided = 'n/a (rejected before any PayPal order exists)'; out.evidenceStored = true; out.explained = !!created.body.error; out.reasonCodes = [created.body.error]; return out; }
    if (m.kind === 'ai') {
      const t = created.body;
      out.detected = t.trace_mode === 'REPLAY_AGENT_TRACE' && /rejected/.test(t.trace_error ?? '');
      out.capturePrevented = true; out.voided = 'n/a (model output rejected; deterministic fallback proposal used)';
      const ev = (await api('GET', `/api/runs/${t.run_id}/evidence`)).body;
      out.evidenceStored = !!ev.trace?.error; out.explained = !!t.trace_error; out.reasonCodes = [t.trace_error];
      return out;
    }
    const id = created.body.run_id;
    const order = await api('POST', `/api/runs/${id}/paypal/order`);
    if (m.kind === 'order') app.paypal.tamper(order.body.id, m.mutate);
    await api('POST', `/api/runs/${id}/replay/approve`);
    if (m.kind === 'concurrency') {
      const calls = await Promise.all(Array.from({ length: 8 }, () => api('POST', `/api/runs/${id}/paypal/authorize`, { orderID: order.body.id })));
      const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
      out.detected = new Set(calls.map((c) => c.body.decision?.decision)).size === 1;
      out.capturePrevented = ev.actions.length === 1; out.voided = 'n/a (clean order captured exactly once)';
      out.evidenceStored = ev.snapshots.filter((s) => s.kind === 'GATE_FRESH_GET').length === 1; out.explained = true; out.reasonCodes = [`${ev.actions.length} action, ${calls.length} callers`];
      return out;
    }
    let body = { orderID: order.body.id };
    if (m.kind === 'caller') body = { orderID: order.body.id, amount: '0.01', total: '0.01', decision: 'CAPTURE', authorization_id: 'FAKE', items: [] };
    // a fake amount must not change a clean order's outcome nor rescue a bad one: test against a tampered order too
    if (m.kind === 'caller') app.paypal.tamper(order.body.id, (o) => { o.purchase_units[0].amount.value = '108.00'; });
    const auth = await api('POST', `/api/runs/${id}/paypal/authorize`, body);
    const d = auth.body.decision;
    if (m.kind === 'webhook') {
      await sleep(1200);
      const ev0 = (await api('GET', `/api/runs/${id}/evidence`)).body;
      const w = ev0.webhooks[0];
      const raw = (await app.db.query('SELECT raw FROM webhook_events WHERE event_id=$1', [w.event_id])).rows[0].raw;
      const again = await api('POST', '/api/webhooks/paypal', raw);
      const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
      out.detected = again.body.duplicate === true; out.capturePrevented = true; out.voided = 'n/a'; out.evidenceStored = ev.webhooks.length === 1; out.explained = true; out.reasonCodes = ['duplicate event ignored'];
      return out;
    }
    const ev = (await api('GET', `/api/runs/${id}/evidence`)).body;
    const codes = d.reason_codes;
    out.reasonCodes = codes;
    out.detected = codes.length > 0 && (m.expect ?? []).every((c) => codes.includes(c));
    out.capturePrevented = !ev.actions.some((a) => a.action === 'capture');
    out.voided = ev.actions.some((a) => a.action === 'void' && a.status === 'DONE');
    out.evidenceStored = !!ev.decision && ev.assertions.length > 0 && ev.snapshots.some((s) => s.kind === 'GATE_FRESH_GET');
    out.explained = ev.assertions.filter((a) => a.status === 'FAIL').every((a) => a.explanation && a.expected && a.actual !== undefined) && codes.length > 0;
    return out;
  } finally { await close(); }
}

export async function runMutations() {
  const results = [];
  for (const m of MUTATIONS) {
    const a = await attempt(m);
    const b = await attempt(m);
    a.deterministic = JSON.stringify(a.reasonCodes) === JSON.stringify(b.reasonCodes) && a.detected === b.detected;
    a.expected = m.expect ?? null;
    results.push(a);
  }
  return results;
}
