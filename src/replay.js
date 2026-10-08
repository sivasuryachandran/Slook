// Replay mode: re-evaluates SAVED traces through the same deterministic assertion code.
// Nothing here talks to PayPal or an AI model. Every response is labelled REPLAY.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAssertions, normalizeOrder } from './gate.js';
import { CATALOG } from './fixtures.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'traces.json');
export const loadTraces = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).traces : []);

export function evaluateTrace(t) {
  const order = normalizeOrder(t.paypal_order);
  const assertions = runAssertions({
    contract: t.contract, order, run: { authorization_id: t.authorization_id }, catalog: CATALOG,
    fetchMeta: { httpStatus: 200, insideGate: true, ageMs: 0 }, proposal: t.proposal, now: new Date(t.recorded_at),
  });
  const failed = assertions.filter((a) => a.blocking && a.status === 'FAIL').map((a) => a.id);
  const decision = failed.length ? 'VOID' : 'CAPTURE';
  return { assertions, decision, reason_codes: failed, reproduced: decision === t.recorded_decision && JSON.stringify(failed) === JSON.stringify(t.recorded_reason_codes) };
}

export function replayView(t) {
  const ev = evaluateTrace(t);
  return {
    label: 'REPLAY MODE — saved trace, no live PayPal or model call, no funds moved',
    id: t.id, title: t.title, fixture: t.fixture, recorded_at: t.recorded_at,
    shopper_request: t.request_text, model: t.model, prompt_version: t.prompt_version, temperature: t.temperature,
    agent_trace_mode_at_recording: t.agent_trace_mode, model_raw_output: t.model_raw_output, proposal: t.proposal,
    contract: t.contract, paypal_order_fixture: t.paypal_order, paypal_response_status: t.recorded_paypal_action,
    webhook_fixture: t.webhook, ...ev, recorded_decision: t.recorded_decision,
  };
}
