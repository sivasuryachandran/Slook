// Records replay fixtures by running each mutation through the real gate on the simulated adapter.
// The shopper's proposal comes from one real model call (if keys are present) and is stored verbatim.
import { existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
import { createApp } from '../src/app.js';
import { propose, PROMPT_VERSION } from '../src/proposal.js';
import { MUTATIONS, REQ } from '../tests/harness/mutations.js';

const rec = await propose(REQ, process.env);
console.log('proposal source:', rec.trace_mode, rec.model, rec.error ?? '');
const meta = { model: rec.model, provider: rec.provider, prompt_version: PROMPT_VERSION, temperature: Number(process.env.AI_TEMPERATURE ?? 0), agent_trace_mode: rec.trace_mode, raw: rec.raw_output };

const cases = [{ id: 'T00', title: 'Matching order → capture', fixture: false, mutate: null },
  ...MUTATIONS.filter((m) => ['order', 'scenario', 'fault'].includes(m.kind)).map((m) => ({ ...m, id: 'T' + m.id.slice(1), title: m.name, fixture: true }))];
const traces = [];
for (const c of cases) {
  const app = await createApp({ LIVE_PAYPAL: 'false' }, { faults: c.faults, llm: async () => meta.raw });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
  const run = await api('POST', '/api/runs', { request_text: REQ, scenario: c.scenario ?? 'happy' });
  const order = await api('POST', `/api/runs/${run.run_id}/paypal/order`);
  if (c.mutate) app.paypal.tamper(order.id, c.mutate);
  await api('POST', `/api/runs/${run.run_id}/replay/approve`);
  const res = await api('POST', `/api/runs/${run.run_id}/paypal/authorize`, { orderID: order.id });
  const ev = await api('GET', `/api/runs/${run.run_id}/evidence`);
  const fresh = ev.snapshots.find((s) => s.kind === 'GATE_FRESH_GET');
  await new Promise((r) => setTimeout(r, 450));
  const wh = (await api('GET', `/api/runs/${run.run_id}/evidence`)).webhooks[0] ?? null;
  const d = res.decision;
  traces.push({
    id: c.id, title: c.title, fixture: c.fixture, recorded_at: new Date().toISOString(), request_text: REQ,
    model: meta.model, provider: meta.provider, prompt_version: meta.prompt_version, temperature: meta.temperature,
    agent_trace_mode: meta.agent_trace_mode, model_raw_output: meta.raw, proposal: ev.trace.proposal,
    contract: ev.contract, authorization_id: ev.run.authorization_id, paypal_order: fresh.body,
    recorded_decision: d.decision, recorded_reason_codes: d.reason_codes, recorded_paypal_action: `${d.paypal_action} → HTTP ${d.paypal_response_status} (simulated adapter)`,
    webhook: wh ? { event_type: wh.event_type, event_id: wh.event_id, simulated: true } : null,
  });
  server.close(); await app.close();
  console.log(c.id, d.decision, d.reason_codes.join(','));
}
writeFileSync('fixtures/traces.json', JSON.stringify({ note: 'Recorded traces. PayPal side is the simulated adapter (REPLAY_SIMULATION); the model output is verbatim from the recorded model call.', traces }, null, 2));
