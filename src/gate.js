// Deterministic capture gate. The ONLY code that decides CAPTURE vs VOID.
// Input is a stored run_id; everything else is loaded server-side or fetched from PayPal.
import { eq, lte, toCents } from './money.js';
import { catalogBySku, CATALOG } from './fixtures.js';
import { customIdFor } from './contract.js';
import { SCHEMA, itemMatches, verifyIntent, verifyRevocation } from './intent.js';
import { proposalTotal } from './agent.js';

export const EVALUATOR_VERSION = 'gate-v2';
export class GateError extends Error {
  constructor(msg, code = 409) { super(msg); this.code = code; }
}

export function normalizeOrder(order) {
  const pu = order?.purchase_units?.[0] ?? {};
  const authz = pu.payments?.authorizations?.[0] ?? null;
  return {
    orderId: order?.id, orderStatus: order?.status, intent: order?.intent,
    total: pu.amount?.value, currency: pu.amount?.currency_code,
    shipping: pu.amount?.breakdown?.shipping?.value ?? null,
    customId: pu.custom_id ?? null,
    shipCountry: pu.shipping?.address?.country_code ?? null,
    items: (pu.items ?? []).map((i) => ({
      sku: i.sku, name: i.name, title: i.name, quantity: Number(i.quantity), unit: i.unit_amount?.value,
      variant: /variant=([\w-]+)/.exec(i.description ?? '')?.[1] ?? null,
    })),
    authorization: authz ? { id: authz.id, status: authz.status } : null,
  };
}

const safe = (fn) => { try { return fn(); } catch { return false; } };

// Pure function: no I/O. Unit-tested directly.
// V2 (signed, open-world) assertions. Authority = the signed intent; the preflight-approved proposal (loaded server-side)
// supplies the concrete line items/prices the buyer's agent was cleared to buy. The order must match BOTH.
export function runAssertionsV2({ contract, approved, order, run, fetchMeta, catalog = CATALOG, proposal, now = new Date(), signature, revocation }) {
  const out = [];
  const A = (id, pass, expected, actual, explanation, blocking = true, source = 'PAYPAL_ORDER') =>
    out.push({ id, stage: 'GATE', status: pass ? 'PASS' : 'FAIL', blocking, expected: String(expected), actual: String(actual ?? 'missing'), source, explanation });
  const ai = approved.line_items; const oi = order.items;
  A('intent.signature', signature.ok && contract.contract_hash === run.contract_hash, 'valid Ed25519 signature; hash equals stored hash', signature.ok ? (contract.contract_hash === run.contract_hash ? 'valid' : 'hash differs from stored hash') : signature.reason, 'The gate re-verifies the signed intent itself', true, 'CONTRACT');
  A('intent.fresh', now.getTime() <= Date.parse(contract.expires_at), `before ${contract.expires_at}`, now.toISOString(), 'Intent must not be expired at capture time', true, 'CONTRACT');
  A('intent.revoked', !revocation.revoked, 'not revoked', revocation.revoked ? `revoked at ${revocation.at}${revocation.valid ? '' : ' (record unverifiable; failing closed)'}` : 'not revoked', 'A revoked intent grants no authority', true, 'CONTRACT');

  const approvedTotal = proposalTotal(approved);
  A('amount.total', safe(() => eq(order.total, approvedTotal) && lte(order.total, contract.max_total)), `${approvedTotal} (max ${contract.max_total})`, order.total, 'PayPal order total must equal the approved total and stay within the signed maximum');
  A('amount.currency', order.currency === contract.currency, contract.currency, order.currency, 'Currency must match the signed intent');
  const key = (x) => x.sku ?? x.title;
  A('items.sku', oi.length === ai.length && oi.every((o, n) => o.sku === ai[n].sku), ai.map((l) => l.sku).join(','), oi.map((o) => o.sku).join(',') || null, 'Every payable item must be the approved product');
  A('items.variant', oi.length === ai.length && oi.every((o, n) => !ai[n].variant || o.variant === ai[n].variant), ai.map((l) => l.variant ?? '-').join(','), oi.map((o) => o.variant ?? '-').join(',') || null, 'Variant must match the approved variant');
  const unrequested = oi.filter((o) => !contract.items.some((r) => itemMatches(r, o.name ?? o.title ?? '', o.variant ?? '')));
  A('items.unrequested', unrequested.length === 0, 'only items the buyer asked for', unrequested.length ? unrequested.map((o) => `${o.name} × ${o.quantity}`).join('; ') : 'none', 'Every PayPal line item must match something the signed intent requested');
  const qtyOk = oi.length === ai.length && oi.every((o, n) => { const r = contract.items.find((x) => itemMatches(x, o.name ?? '', o.variant ?? '')); return o.quantity === ai[n].quantity && (!r?.quantity || (o.quantity >= r.quantity.min && o.quantity <= r.quantity.max)); });
  A('items.quantity', qtyOk, ai.map((l) => l.quantity).join(','), oi.map((o) => o.quantity).join(',') || null, 'Quantity must equal the approved quantity and sit inside the signed range');
  A('items.unit_amount', oi.length === ai.length && oi.every((o, n) => safe(() => lte(o.unit, ai[n].unit_amount))), `<= ${ai.map((l) => l.unit_amount).join(',')}`, oi.map((o) => o.unit).join(',') || null, 'Unit price must not exceed the approved price');
  A('shipping.amount', order.shipping != null && safe(() => lte(order.shipping, approved.shipping_amount)), `<= ${approved.shipping_amount}`, order.shipping, 'Shipping must be present and within the approved amount');
  const countries = contract.delivery?.countries ?? ['US'];
  A('shipping.country', countries.includes(order.shipCountry), countries.join(','), order.shipCountry, 'Ship-to country must be allowed by the signed intent');
  const catBad = oi.filter((o, n) => {
    const c = catalog.items.find((x) => x.sku === o.sku);
    const wasCatalog = catalog.items.some((x) => x.sku === ai[n]?.sku); // an item approved from the catalog must still be a catalog item
    return (wasCatalog && !c) || (c && !safe(() => eq(o.unit, c.unit_amount)));
  });
  A('catalog.price', catBad.length === 0, 'catalog price wherever a catalog SKU exists', catBad.length ? catBad.map((o) => `${o.sku}@${o.unit}`).join(',') : 'ok', 'Optional: when catalog data exists the unit price must equal it');
  const sameKeys = JSON.stringify(oi.map(key).sort()) === JSON.stringify(ai.map(key).sort());
  A('policy.substitution', contract.allow_substitutions || sameKeys, contract.allow_substitutions ? 'substitutions allowed' : 'no substitution', sameKeys ? 'none' : 'substituted', 'Items must not be substituted when the intent forbids it');
  A('link.custom_id', order.customId === customIdFor(contract.run_id, contract.contract_hash), customIdFor(contract.run_id, contract.contract_hash), order.customId, 'PayPal custom_id must link to this run and signed contract hash');
  const stateOk = order.intent === 'AUTHORIZE' && order.orderStatus === 'COMPLETED' && order.authorization?.status === 'CREATED' && order.authorization?.id === run.authorization_id;
  A('paypal.state', stateOk, `intent AUTHORIZE, order COMPLETED, auth ${run.authorization_id} CREATED`, `intent ${order.intent}, order ${order.orderStatus}, auth ${order.authorization?.id} ${order.authorization?.status}`, 'Order and authorization must be in the expected state');
  A('freshness.snapshot', fetchMeta.httpStatus === 200 && fetchMeta.insideGate && fetchMeta.ageMs < 60_000, 'fresh PayPal GET inside gate', `HTTP ${fetchMeta.httpStatus}, age ${fetchMeta.ageMs}ms`, 'Gate must use its own fresh PayPal GET, never browser data', true, 'PAYPAL_GET');
  out.push({ id: 'explanation', stage: 'GATE', status: 'INFO', blocking: false, expected: 'coherent AI explanation', actual: proposal?.reasoning_summary ?? 'none', source: 'AGENT_TRACE', explanation: 'Display only; never affects the decision' });
  return out;
}

export function runAssertions(args) {
  if (args.contract?.schema_version === SCHEMA) return runAssertionsV2(args);
  return runAssertionsV1(args);
}

export function runAssertionsV1({ contract, order, run, fetchMeta, catalog = CATALOG, proposal, now = new Date() }) {
  const out = [];
  const A = (id, pass, expected, actual, explanation, blocking = true, source = 'PAYPAL_ORDER') =>
    out.push({ id, status: pass ? 'PASS' : 'FAIL', blocking, expected: String(expected), actual: String(actual ?? 'missing'), source, explanation });
  const ci = contract.items;

  A('amount.total', safe(() => eq(order.total, contract.expected_total) && lte(order.total, contract.max_total)),
    `${contract.expected_total} (max ${contract.max_total})`, order.total, 'PayPal order total must equal the contracted total and stay within the shopper limit');
  A('amount.currency', order.currency === contract.currency, contract.currency, order.currency, 'Currency must match the contract');

  const catalogOk = order.items.length > 0 && order.items.every((i) => catalog.items.some((c) => c.sku === i.sku));
  A('items.sku', catalogOk && order.items.length === ci.length && order.items.every((i, n) => i.sku === ci[n]?.sku),
    ci.map((i) => i.sku).join(','), order.items.map((i) => i.sku).join(',') || null, 'Every payable item must be the contracted catalog SKU');
  A('items.variant', order.items.length === ci.length && order.items.every((i, n) => i.variant === ci[n]?.variant),
    ci.map((i) => i.variant).join(','), order.items.map((i) => i.variant).join(',') || null, 'Variant must match the requested variant');
  A('items.quantity', order.items.length === ci.length && order.items.every((i, n) => i.quantity === ci[n]?.quantity),
    ci.map((i) => i.quantity).join(','), order.items.map((i) => i.quantity).join(',') || null, 'Quantity must match the request');
  A('items.unit_amount', order.items.length === ci.length && order.items.every((i, n) => safe(() => lte(i.unit, ci[n].max_unit_amount))),
    `<= ${ci.map((i) => i.max_unit_amount).join(',')}`, order.items.map((i) => i.unit).join(',') || null, 'Unit price must not exceed the contract maximum');

  const maxShip = contract.allowed_shipping?.max_amount;
  A('shipping.amount', maxShip == null || (order.shipping != null && safe(() => lte(order.shipping, maxShip))),
    maxShip == null ? 'n/a' : `<= ${maxShip}`, order.shipping, 'Shipping must be present and within the allowed maximum', maxShip != null);

  A('shipping.country', (contract.allowed_shipping?.countries ?? []).includes(order.shipCountry),
    (contract.allowed_shipping?.countries ?? []).join(','), order.shipCountry, 'Ship-to country must be allowed by the contract');

  A('catalog.price', order.items.length > 0 && order.items.every((i) => { const c = catalog.items.find((x) => x.sku === i.sku); return c && safe(() => eq(i.unit, c.unit_amount)); }),
    order.items.map((i) => catalog.items.find((x) => x.sku === i.sku)?.unit_amount ?? 'not in catalog').join(','), order.items.map((i) => i.unit).join(',') || null,
    'Unit price must equal the catalog snapshot price for that SKU');

  A('intent.fresh', now.getTime() <= Date.parse(contract.expires_at), `before ${contract.expires_at}`, now.toISOString(), 'Intent contract must not be expired', true, 'CONTRACT');

  const sameSkus = JSON.stringify(order.items.map((i) => i.sku).sort()) === JSON.stringify(ci.map((i) => i.sku).sort());
  A('policy.substitution', contract.policy.allow_substitutions || sameSkus,
    contract.policy.allow_substitutions ? 'substitutions allowed' : 'no substitution', sameSkus ? 'none' : 'substituted',
    'Items must not be substituted when the contract forbids it');

  const expectedCustom = customIdFor(contract.run_id, contract.contract_hash);
  A('link.custom_id', order.customId === expectedCustom, expectedCustom, order.customId, 'PayPal custom_id must link to this run and contract hash');

  const stateOk = order.intent === 'AUTHORIZE' && order.orderStatus === 'COMPLETED' &&
    order.authorization?.status === 'CREATED' && order.authorization?.id === run.authorization_id;
  A('paypal.state', stateOk, `intent AUTHORIZE, order COMPLETED, auth ${run.authorization_id} CREATED`,
    `intent ${order.intent}, order ${order.orderStatus}, auth ${order.authorization?.id} ${order.authorization?.status}`, 'Order and authorization must be in the expected state');

  A('freshness.snapshot', fetchMeta.httpStatus === 200 && fetchMeta.insideGate && fetchMeta.ageMs < 60_000,
    'fresh PayPal GET inside gate', `HTTP ${fetchMeta.httpStatus}, age ${fetchMeta.ageMs}ms`, 'Gate must use its own fresh PayPal GET, never browser data', true, 'PAYPAL_GET');
  out.push({ id: 'explanation', status: 'INFO', blocking: false, expected: 'coherent AI explanation',
    actual: proposal?.reasoning_summary ?? 'none', source: 'AGENT_TRACE', explanation: 'Display only; never affects the decision' });
  return out;
}

const inflight = new Map();

export function createGate({ db, paypal, ledger, mode }) {
  async function storedDecision(runId) {
    const d = (await db.query('SELECT record FROM decisions WHERE run_id=$1', [runId])).rows[0];
    return d ? { ...d.record, replayed: true } : null;
  }

  async function doEvaluate(runId) {
    const prior = await storedDecision(runId);
    if (prior) return prior; // idempotent: no PayPal call

    const run = await ledger.getRun(runId);
    if (!run) throw new GateError('run not found', 404);
    if (!run.authorization_id || !['AUTHORIZED', 'VERIFYING'].includes(run.status)) throw new GateError(`run is ${run.status}; not ready for evaluation`);

    // single-flight lease across processes
    const lease = await db.query(
      `UPDATE runs SET status='VERIFYING', lease_at=now(), updated_at=now()
       WHERE id=$1 AND (status='AUTHORIZED' OR (status='VERIFYING' AND lease_at < now() - interval '30 seconds')) RETURNING id`, [runId]);
    if (!lease.rows.length) {
      for (let i = 0; i < 40; i++) { // another evaluator is active; wait for its stored decision
        await new Promise((r) => setTimeout(r, 250));
        const d = await storedDecision(runId);
        if (d) return d;
      }
      throw new GateError('evaluation already in progress');
    }

    try {
      const t0 = Date.now();
      await ledger.event(runId, 'GATE_EVALUATING', {});
      const fresh = await paypal.getOrder(run.paypal_order_id); // gate's OWN fetch
      const snapId = await ledger.snapshot(runId, 'GATE_FRESH_GET', fresh);
      if (!fresh.ok) throw new GateError(`PayPal order fetch failed (HTTP ${fresh.status})`, 502);
      const order = normalizeOrder(fresh.body);
      const trace = (await db.query('SELECT proposal FROM agent_traces WHERE run_id=$1 ORDER BY id LIMIT 1', [runId])).rows[0];
      const contract = run.contract_json;
      const pem = (await db.query('SELECT public_pem FROM intent_keys WHERE key_id=$1', [contract.key_id])).rows[0]?.public_pem;
      const signature = verifyIntent(contract, pem);
      const revocation = run.revocation_json ? verifyRevocation(run.revocation_json, pem, run.contract_hash) : { revoked: false };
      const assertions = runAssertions({ contract, order, run, approved: run.proposal_json, signature, revocation,
        fetchMeta: { httpStatus: fresh.status, insideGate: true, ageMs: Date.now() - t0 }, proposal: trace?.proposal, now: new Date() });
      for (const a of assertions) {
        await db.query(`INSERT INTO assertions(run_id,assertion_id,status,blocking,expected,actual,source,explanation,evaluator_version,stage)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'GATE')`, [runId, a.id, a.status, a.blocking, a.expected, a.actual, a.source, a.explanation, EVALUATOR_VERSION]);
      }
      const failed = assertions.filter((a) => a.blocking && a.status === 'FAIL');
      const decision = failed.length ? 'VOID' : 'CAPTURE';
      const action = decision === 'CAPTURE' ? 'capture' : 'void';
      const requestId = `sl:${action}:${runId}:v1`;
      const endpoint = `POST /v2/payments/authorizations/${run.authorization_id}/${action}`;

      await db.query(`INSERT INTO actions(run_id,action,request_id,endpoint,status) VALUES($1,$2,$3,$4,'PENDING') ON CONFLICT (run_id,action) DO NOTHING`,
        [runId, action, requestId, endpoint]);
      const res = decision === 'CAPTURE'
        ? await paypal.captureAuthorization(run.authorization_id, requestId)
        : await paypal.voidAuthorization(run.authorization_id, requestId);
      const respSnap = await ledger.snapshot(runId, action.toUpperCase() + '_RESPONSE', res, requestId);
      await db.query('UPDATE actions SET status=$3, http_status=$4, snapshot_id=$5 WHERE run_id=$1 AND action=$2',
        [runId, action, res.ok ? 'DONE' : 'FAILED', res.status, respSnap]);
      if (!res.ok) throw new GateError(`PayPal ${action} failed (HTTP ${res.status}); will retry with same idempotency key`, 502);

      const record = {
        run_id: runId, decision, reason_codes: failed.map((a) => a.id),
        assertions: assertions.map(({ id, status, expected, actual, source }) => ({ id, status, expected, actual, source })),
        paypal_order_id: run.paypal_order_id, authorization_id: run.authorization_id,
        paypal_action: endpoint, idempotency_key: requestId, fresh_paypal_snapshot_id: snapId,
        paypal_response_status: res.status, adapter_mode: mode, latency_ms: Date.now() - t0, created_at: new Date().toISOString(),
      };
      await db.query('INSERT INTO decisions(run_id,decision,reason_codes,record) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [runId, decision, JSON.stringify(record.reason_codes), JSON.stringify(record)]);
      await ledger.setStatus(runId, decision === 'CAPTURE' ? 'CAPTURED' : 'VOIDED', { final_decision: decision });
      await ledger.event(runId, 'DECISION', { decision, reason_codes: record.reason_codes, latency_ms: record.latency_ms });
      // a webhook may have beaten the decision write; reconcile if so
      const wantType = decision === 'CAPTURE' ? 'PAYMENT.CAPTURE.COMPLETED' : 'PAYMENT.AUTHORIZATION.VOIDED';
      const early = await db.query('SELECT 1 FROM webhook_events WHERE run_id=$1 AND event_type=$2 AND verified', [runId, wantType]);
      if (early.rows.length) await ledger.setStatus(runId, 'RECONCILED');
      return record;
    } catch (e) {
      const r = await ledger.getRun(runId);
      if (r && !r.final_decision) await ledger.setStatus(runId, 'AUTHORIZED');
      throw e;
    }
  }

  return {
    // In-process single-flight on top of the DB lease.
    evaluate(runId) {
      if (!inflight.has(runId)) inflight.set(runId, doEvaluate(runId).finally(() => inflight.delete(runId)));
      return inflight.get(runId);
    },
  };
}
