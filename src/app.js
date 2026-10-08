import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb } from './db.js';
import { makeLedger, redactRun } from './ledger.js';
import { createGate, GateError } from './gate.js';
import { propose, validateProposal, checkRequestConsistency } from './proposal.js';
import { compileIntent, reconcileIntent, buildSignedIntent, verifyIntent, signRevocation, verifyRevocation } from './intent.js';
import { createModelClient, MODEL_PROMPT_VERSION } from './model.js';
import { candidatesFor, proposeFromCandidates, selectionPayload, applyModelSelection, applyPoison, proposalTotal, AGENT_VERSION } from './agent.js';
import { runPreflight } from './preflight.js';
import { createSigner } from './signing.js';
import { customIdFor, newRunId } from './contract.js';
import { CATALOG, POLICY, SCENARIOS } from './fixtures.js';
import { add, mul } from './money.js';
import { createRealPayPal } from './paypal/real.js';
import { createFakePayPal } from './paypal/fake.js';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { createSimulation } from './simulation.js';
import { loadTraces, replayView, evaluateTrace } from './replay.js';

const PUBLIC_DEMO_SCENARIOS = ['poisoned_proposal', 'revoke_before_capture'];
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SENSITIVE = /email|given_name|surname|payer_id|phone|address_line|admin_area|postal_code|full_name|account_id|merchant_id|payee|client_secret|access_token|^name$/i;
const redact = (v) => Array.isArray(v) ? v.map(redact)
  : v instanceof Date ? v
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(x)])) : v;

export async function createApp(env = process.env, overrides = {}) {
  const live = env.LIVE_PAYPAL === 'true' && !overrides.paypal;
  const killSwitch = env.KILL_SWITCH === 'true';
  const db = overrides.db ?? await openDb(env.DATABASE_URL);
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const modelClient = overrides.modelClient !== undefined ? overrides.modelClient : createModelClient(env); // null => deterministic agent only
  const signer = createSigner(env); // the private key lives only inside this closure; agent modules never see it
  await db.query('INSERT INTO intent_keys(key_id, public_pem) VALUES($1,$2) ON CONFLICT (key_id) DO NOTHING', [signer.keyId, signer.publicPem]);
  if (signer.ephemeral && env.NODE_ENV === 'production') console.warn('INTENT_SIGNING_KEY not set: using an ephemeral key; contracts will not verify after a restart');
  let paypal = overrides.paypal;
  const handleWebhook = (headers, event, ctx = main) => ingestWebhook(ctx, headers, event);
  if (!paypal) {
    paypal = live && !killSwitch
      ? createRealPayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID, env: env.PAYPAL_ENV || 'sandbox' })
      : createFakePayPal({ onWebhook: (e) => handleWebhook({}, e).catch(() => {}), faults: overrides.faults });
  }
  const mode = paypal.mode;
  const mkCtx = (pp, m) => { const ledger = makeLedger(db, m, bus); return { paypal: pp, ledger, gate: createGate({ db, paypal: pp, ledger, mode: m }), mode: m }; };
  const main = mkCtx(paypal, mode);
  // Simulation ALWAYS uses its own mock adapter. It can never reach real PayPal, whatever LIVE_PAYPAL says.
  const simPaypal = createFakePayPal({ mode: 'MOCK_SIMULATION', onWebhook: (e) => handleWebhook({}, e, sim).catch(() => {}) });
  const sim = mkCtx(simPaypal, 'MOCK_SIMULATION');
  const ledger = main.ledger;
  const isReplay = mode !== 'LIVE_SANDBOX';
  const banner = isReplay
    ? 'REPLAY — simulated PayPal adapter. No live funds moved.'
    : 'PayPal SANDBOX — test money only.';

  // ---- webhook ingestion (shared by HTTP route and in-process simulator)
  async function ingestWebhook(ctx, headers, event) {
    const { paypal: pp, ledger: led } = ctx;
    const v = await pp.verifyWebhook(headers, event);
    const r = event.resource ?? {};
    const orderId = r.supplementary_data?.related_ids?.order_id ?? null;
    const customId = r.custom_id ?? null;
    let run = null;
    if (orderId) run = (await db.query('SELECT * FROM runs WHERE paypal_order_id=$1', [orderId])).rows[0];
    if (!run && customId?.startsWith('sl:')) run = await led.getRun(customId.split(':')[1]);
    const ins = await db.query(
      `INSERT INTO webhook_events(event_id,event_type,verified,verification,run_id,reference,raw) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.id, event.event_type, v.verified, v.detail, run?.id ?? null, orderId ?? r.id ?? null, JSON.stringify(event)]);
    const fresh = ins.rows.length > 0;
    if (fresh && v.verified && run) {
      await led.event(run.id, 'WEBHOOK', { event_type: event.event_type, event_id: event.id });
      const done = (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && run.final_decision === 'CAPTURE')
        || (event.event_type === 'PAYMENT.AUTHORIZATION.VOIDED' && run.final_decision === 'VOID');
      if (done) await led.setStatus(run.id, 'RECONCILED');
    }
    return { verified: v.verified, duplicate: !fresh };
  }

  const httpErr = (status, message) => Object.assign(new Error(message), { status });

  // ---- services: every caller (browser routes, simulation) goes through these. None can capture/void; only the gate can.
  const catalogDomain = (draft) => draft.items.length === 1 && /backpack/.test(draft.items[0].description);
  async function historyFor(ctx) {
    const r = await db.query(`SELECT contract_json FROM runs WHERE mode=$1 AND final_decision='CAPTURE' ORDER BY created_at DESC LIMIT 20`, [ctx.mode]);
    return r.rows.flatMap((x) => (x.contract_json.items ?? []).map((i) => ({ description: i.description, quantity: i.quantity?.min }))).filter((h) => h.description && h.quantity);
  }

  async function svcCreateRun(ctx, { text, scenario = 'happy', shopperId = null, simScenario = null, llm, confirm = false }) {
    text = String(text ?? '').trim().slice(0, 300);
    if (!text) throw httpErr(400, 'request_text required');
    const sc = SCENARIOS[scenario];
    if (!sc) throw httpErr(400, 'unknown scenario');

    // 1. natural language -> structured intent draft. No catalog or SKU is required.
    // the simulation never calls the model (no cost, no latency, no key use)
    const useModel = !!modelClient && ctx.mode !== 'MOCK_SIMULATION';
    const aiEnv = useModel ? env : { ...env, REPLAY_MODE: 'true' };
    const ai = { model: useModel ? modelClient.model : null, notes: [], compile: null, select: null, raw: {} };
    let compiled = compileIntent(text, { history: await historyFor(ctx) });
    if (useModel) {
      try {
        const m = await modelClient.compile(text);
        const r = reconcileIntent(text, compiled, m.parsed);
        compiled = r.compiled; ai.raw.compile = m.raw; ai.compile = { latency_ms: m.latency_ms, ...r.meta };
        ai.notes.push(...r.meta.reasons);
      } catch (e) { ai.compile = { used: 'deterministic', reasons: [e.message] }; ai.notes.push('compile: ' + e.message); }
    }
    if (compiled.status === 'NEEDS_INFORMATION') return { status: 'NEEDS_INFORMATION', run_id: null, questions: compiled.questions, suggestions: compiled.suggestions };
    if (compiled.status === 'REQUIRE_APPROVAL' && !confirm) return { status: 'REQUIRE_APPROVAL', run_id: null, assumptions: compiled.assumptions, suggestions: compiled.suggestions, intent_draft: compiled.draft };
    const draft = compiled.draft;

    // 2. the agent proposes (catalog-backed agent for backpacks, open-world agent otherwise). It holds no keys and no PayPal client.
    let trace; let proposal;
    if (llm || catalogDomain(draft)) {
      trace = await propose(text, aiEnv, llm);
      const errs = [...validateProposal(trace.proposal), ...(trace.proposal ? checkRequestConsistency(text, trace.proposal) : [])];
      if (errs.length) throw httpErr(422, 'proposal rejected: ' + errs.join('; '));
      const p = trace.proposal;
      const total = add(mul(p.unit_amount, p.quantity), p.shipping_amount);
      if (Number(total) > Number(draft.max_total)) throw httpErr(422, `proposal total ${total} exceeds your limit ${draft.max_total}`);
      proposal = { line_items: [{ sku: p.sku, title: p.title, variant: p.variant, merchant: 'Trailhead Outfitters', quantity: p.quantity, unit_amount: p.unit_amount, unit: 'each' }],
        shipping_amount: p.shipping_amount, currency: p.currency, merchants: ['Trailhead Outfitters'], reasoning_summary: p.reasoning_summary, confidence: p.confidence, agent_version: 'catalog-agent' };
    } else {
      const cands = candidatesFor(draft, { poison: sc.poison });
      let usedModel = false;
      if (useModel && cands.every((c) => c.candidates.length)) {
        try {
          const m = await modelClient.select(selectionPayload(draft, cands));
          proposal = applyModelSelection(draft, cands, m.parsed);
          ai.raw.select = m.raw; ai.select = { latency_ms: m.latency_ms, used: 'model' }; usedModel = true;
        } catch (e) { ai.select = { used: 'deterministic', reasons: [e.message] }; ai.notes.push('select: model output unusable, deterministic agent used (' + e.message + ')'); }
      }
      if (!usedModel) {
        const r = proposeFromCandidates(draft, cands);
        if (r.missing) return { status: 'NEEDS_INFORMATION', run_id: null, questions: [`I could not find a product matching: ${r.missing.join(', ')}. Can you describe it differently?`], suggestions: [] };
        proposal = r.proposal;
      }
      const liveUsed = usedModel || ai.compile?.used === 'model';
      trace = { provider: liveUsed ? 'nvidia' : 'replay', model: liveUsed ? modelClient.model : 'deterministic-openworld-agent', prompt_version: liveUsed ? MODEL_PROMPT_VERSION : AGENT_VERSION,
        input: { text, temperature: modelClient?.temperature ?? null, compile: ai.compile, select: ai.select }, raw_output: liveUsed ? JSON.stringify({ compile: ai.raw.compile ?? null, select: ai.raw.select ?? null }) : JSON.stringify(proposal),
        trace_mode: liveUsed ? 'LIVE_AGENT_TRACE' : 'REPLAY_AGENT_TRACE', error: ai.notes.length ? ai.notes.join('; ') : null };
      ai.live = liveUsed;
    }
    if (sc.poison) proposal = applyPoison(proposal, { modelUsed: !!ai.select && ai.select.used === 'model' }); // CONTROLLED TEST FIXTURE: injected instruction obeyed by the fixture agent
    proposal.total = proposalTotal(proposal);

    // 3. freeze + sign the user's authority BEFORE any PayPal object exists
    const runId = newRunId();
    const contract = buildSignedIntent({ runId, draft, catalog: CATALOG, policy: POLICY, ttlMin: Number(env.INTENT_TTL_MIN || 60), signer, assumptionsConfirmed: compiled.status === 'REQUIRE_APPROVAL' ? compiled.assumptions : [] });
    const orderDraft = sc.apply({ items: proposal.line_items.map((l) => ({ sku: l.sku, title: l.title, variant: l.variant, quantity: l.quantity, unit_amount: l.unit_amount })), shipping_amount: proposal.shipping_amount, currency: proposal.currency });
    await db.query(`INSERT INTO runs(id,status,request_text,contract_json,contract_hash,catalog_snapshot_id,policy_snapshot_id,order_draft,scenario,mode,shopper_id,sim_scenario,proposal_json)
      VALUES($1,'DRAFT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [runId, text, JSON.stringify(contract), contract.contract_hash, CATALOG.id, POLICY.id, JSON.stringify(orderDraft), scenario, ctx.mode, shopperId, simScenario, JSON.stringify(proposal)]);
    await db.query(`INSERT INTO agent_traces(run_id,provider,model,prompt_version,input,raw_output,proposal,trace_mode,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [runId, trace.provider, trace.model, trace.prompt_version, JSON.stringify(trace.input), sc.poison ? JSON.stringify(proposal) : trace.raw_output, JSON.stringify(proposal), trace.trace_mode, trace.error]);
    await ctx.ledger.event(runId, 'CONTRACT_FROZEN', { contract_hash: contract.contract_hash, trace_mode: trace.trace_mode, fallback: !!trace.error, scenario: scenario === 'happy' ? null : 'CONTROLLED TEST FIXTURE: ' + scenario });

    // 4. preflight: deterministic check of the proposal against the signed intent. A BLOCK means zero PayPal calls, ever.
    const pf = runPreflight({ contract, proposal, signature: verifyIntent(contract, signer.publicPem), now: new Date(contract.issued_at) });
    for (const a of pf.assertions) {
      await db.query(`INSERT INTO assertions(run_id,assertion_id,status,blocking,expected,actual,source,explanation,evaluator_version,stage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PREFLIGHT')`,
        [runId, a.id, a.status, a.blocking, a.expected, a.actual, a.source, a.explanation, pf.version]);
    }
    await ctx.ledger.event(runId, 'PREFLIGHT', { decision: pf.decision, reason_codes: pf.reason_codes });
    if (pf.decision === 'BLOCK') {
      const record = { run_id: runId, decision: 'BLOCK', stage: 'PREFLIGHT', reason_codes: pf.reason_codes,
        assertions: pf.assertions.map(({ id, status, expected, actual, source }) => ({ id, status, expected, actual, source })),
        paypal_order_id: null, authorization_id: null, paypal_action: 'none — blocked before any PayPal order was created', idempotency_key: null, paypal_calls: 0,
        adapter_mode: ctx.mode, latency_ms: 0, created_at: new Date().toISOString() };
      await db.query('INSERT INTO decisions(run_id,decision,reason_codes,record) VALUES($1,$2,$3,$4)', [runId, 'BLOCK', JSON.stringify(pf.reason_codes), JSON.stringify(record)]);
      await db.query(`UPDATE runs SET status='BLOCKED', final_decision='BLOCK', preflight_decision='BLOCK', updated_at=now() WHERE id=$1`, [runId]);
      await ctx.ledger.event(runId, 'DECISION', { decision: 'BLOCK', reason_codes: pf.reason_codes, latency_ms: 0 });
    } else {
      await db.query(`UPDATE runs SET status='PREFLIGHT_PASSED', preflight_decision='PASS', updated_at=now() WHERE id=$1`, [runId]);
    }
    return { status: pf.decision === 'BLOCK' ? 'BLOCKED' : 'READY', run_id: runId, proposal, trace_mode: trace.trace_mode, trace_error: trace.error, contract, scenario, fixture: scenario !== 'happy',
      preflight: { decision: pf.decision, reason_codes: pf.reason_codes, assertions: pf.assertions }, hold: !!sc.hold, ai };
  }

  async function svcCreateOrder(ctx, run) {
    if (killSwitch && ctx.mode === 'LIVE_SANDBOX') throw httpErr(503, 'live PayPal actions disabled');
    if (run.paypal_order_id) return { status: 200, body: { id: run.paypal_order_id, reused: true } };
    if (run.preflight_decision !== 'PASS') throw httpErr(409, `preflight did not pass (${run.preflight_decision ?? 'not run'}); no PayPal order may be created`);
    const d = run.order_draft;
    const itemTotal = add(...d.items.map((i) => mul(i.unit_amount, i.quantity)));
    const body = {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: run.id,
        custom_id: customIdFor(run.id, run.contract_hash),
        description: 'Slook sandbox order',
        amount: { currency_code: d.currency, value: add(itemTotal, d.shipping_amount),
          breakdown: { item_total: { currency_code: d.currency, value: itemTotal }, shipping: { currency_code: d.currency, value: d.shipping_amount } } },
        items: d.items.map((i) => ({ name: String(i.title).slice(0, 127), sku: String(i.sku).slice(0, 127), ...(i.variant ? { description: `variant=${i.variant}` } : {}), quantity: String(i.quantity), category: 'PHYSICAL_GOODS',
          unit_amount: { currency_code: d.currency, value: i.unit_amount } })),
      }],
    };
    if (d.ship_country === 'CA') { // CONTROLLED TEST FIXTURE: ship-to country outside the contract
      body.purchase_units[0].shipping = { name: { full_name: 'Fixture Buyer' }, address: { address_line_1: '100 Queen St', admin_area_2: 'Toronto', admin_area_1: 'ON', postal_code: 'M5H 2N2', country_code: 'CA' } };
      body.payment_source = { paypal: { experience_context: { shipping_preference: 'SET_PROVIDED_ADDRESS' } } };
    }
    if (env.PAYPAL_REDIRECT_FALLBACK === 'true') {
      body.payment_source = { paypal: { experience_context: { ...(body.payment_source?.paypal?.experience_context ?? {}), user_action: 'PAY_NOW', return_url: `${env.APP_BASE_URL}/?run=${run.id}`, cancel_url: `${env.APP_BASE_URL}/?cancel=${run.id}` } } };
    }
    const requestId = `sl:create:${run.id}:v1`;
    const r = await ctx.paypal.createOrder(body, requestId);
    await ctx.ledger.snapshot(run.id, 'CREATE_ORDER', r, requestId);
    if (!r.ok) throw httpErr(502, `PayPal create order failed (HTTP ${r.status})`);
    const upd = await db.query('UPDATE runs SET paypal_order_id=$2, status=$3, updated_at=now() WHERE id=$1 AND paypal_order_id IS NULL RETURNING id', [run.id, r.body.id, 'APPROVAL_PENDING']);
    if (!upd.rows.length) return { status: 200, body: { id: (await ctx.ledger.getRun(run.id)).paypal_order_id, reused: true } };
    await ctx.ledger.event(run.id, 'ORDER_CREATED', { paypal_order_id: r.body.id });
    return { status: 201, body: { id: r.body.id } };
  }

  // authorize (accepts only the order id from onApprove). The gate runs automatically unless the caller defers it
  // (deferring only delays evaluation; it cannot skip it, and nothing is captured until the gate runs).
  async function svcAuthorize(ctx, run, orderID, { deferGate = false } = {}) {
    if (run.final_decision) return ctx.gate.evaluate(run.id);
    if (!run.paypal_order_id || orderID !== run.paypal_order_id) throw httpErr(400, 'order does not belong to this run');
    if (!run.authorization_id) {
      if (!['APPROVAL_PENDING', 'APPROVED'].includes(run.status)) throw httpErr(409, `run is ${run.status}`);
      const requestId = `sl:authorize:${run.id}:v1`;
      const r = await ctx.paypal.authorizeOrder(run.paypal_order_id, requestId);
      await ctx.ledger.snapshot(run.id, 'AUTHORIZE_ORDER', r, requestId);
      const authId = r.body?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
      if (!r.ok || !authId) throw httpErr(502, `PayPal authorize failed (HTTP ${r.status})`);
      const u = await db.query(`UPDATE runs SET authorization_id=$2, status='AUTHORIZED', updated_at=now() WHERE id=$1 AND authorization_id IS NULL RETURNING id`, [run.id, authId]);
      if (u.rows.length) await ctx.ledger.event(run.id, 'AUTHORIZED', { authorization_id: authId });
    }
    return deferGate ? null : ctx.gate.evaluate(run.id);
  }

  // The principal withdraws authority. This can only REDUCE what the gate allows, so it needs no operator key.
  async function svcRevoke(ctx, run, reason = 'user revoked') {
    if (run.final_decision) throw httpErr(409, 'run already decided');
    if (run.revocation_json) return run.revocation_json;
    const rev = signRevocation({ runId: run.id, contractHash: run.contract_hash, reason: String(reason).slice(0, 120), signer });
    await db.query('UPDATE runs SET revocation_json=$2, updated_at=now() WHERE id=$1 AND revocation_json IS NULL', [run.id, JSON.stringify(rev)]);
    await ctx.ledger.event(run.id, 'INTENT_REVOKED', { revoked_at: rev.revoked_at, reason: rev.reason });
    return rev;
  }

  async function svcSimulateApproval(ctx, run) {
    if (!run.paypal_order_id || !ctx.paypal.simulateApproval?.(run.paypal_order_id)) throw httpErr(409, 'no order to approve');
    await ctx.ledger.event(run.id, 'BUYER_APPROVED', { simulated: true });
  }

  const simulation = createSimulation({ db, bus, env, sim, svc: { createRun: svcCreateRun, createOrder: svcCreateOrder, authorize: svcAuthorize, approve: svcSimulateApproval, revoke: svcRevoke, evaluate: (ctx, id) => ctx.gate.evaluate(id) } });

  // ---- app
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const hits = new Map();
  const limit = (max) => (req, res, next) => {
    const k = req.ip + req.path.replace(/run_\w+/, ':id');
    const now = Date.now();
    const arr = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= max) return res.status(429).json({ error: 'rate limited' });
    arr.push(now); hits.set(k, arr); next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    const code = e instanceof GateError ? e.code : e.status ?? 500;
    if (code === 500) console.error(e);
    res.status(code).json({ error: code === 500 ? 'internal error' : e.message });
  });
  // browser routes only operate on runs that belong to the main adapter (never on simulation runs)
  const needRun = async (id) => {
    const r = await main.ledger.getRun(id);
    if (!r || r.mode !== main.mode) throw httpErr(404, 'run not found');
    return r;
  };

  app.get('/healthz', wrap(async (req, res) => { await db.query('SELECT 1'); res.json({ ok: true, db: db.kind, mode }); }));
  app.get('/api/config', (req, res) => res.json({
    mode, banner, replay: isReplay, killSwitch, paypalClientId: isReplay ? null : env.PAYPAL_CLIENT_ID,
    scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, s.label])),
    fixturesNeedKey: !!env.INTERNAL_ACTION_KEY, aiLive: !!(env.NVIDIA_API_KEY || env.ANTHROPIC_API_KEY) && env.REPLAY_MODE !== 'true',
    simulation: { mode: 'MOCK_SIMULATION', maxUnauthenticated: simulation.limits.unauthenticated, maxWithKey: simulation.limits.withKey, needsKeyAbove: !!env.INTERNAL_ACTION_KEY },
  }));

  app.post('/api/runs', limit(20), wrap(async (req, res) => {
    const scenario = req.body?.scenario ?? 'happy';
    // Paths A and B are harmless public demo paths (no PayPal mutation); other fixtures alter the PayPal order and need the operator key.
    if (!PUBLIC_DEMO_SCENARIOS.includes(scenario) && scenario !== 'happy' && env.INTERNAL_ACTION_KEY && req.get('x-internal-key') !== env.INTERNAL_ACTION_KEY) throw httpErr(401, 'fixtures require operator key');
    const out = await svcCreateRun(main, { text: req.body?.request_text, scenario, llm: overrides.llm, confirm: req.body?.confirm === true });
    res.status(out.run_id ? 201 : 200).json(out);
  }));

  app.post('/api/runs/:runId/paypal/order', limit(20), wrap(async (req, res) => {
    const run = await needRun(req.params.runId);
    const out = await svcCreateOrder(main, run);
    res.status(out.status).json(out.body);
  }));

  // replay only: stands in for the buyer clicking Approve in the PayPal popup
  app.post('/api/runs/:runId/replay/approve', limit(20), wrap(async (req, res) => {
    if (!isReplay) throw httpErr(404, 'not found');
    await svcSimulateApproval(main, await needRun(req.params.runId));
    res.json({ approved: true, simulated: true });
  }));

  app.post('/api/runs/:runId/paypal/authorize', limit(20), wrap(async (req, res) => {
    const decision = await svcAuthorize(main, await needRun(req.params.runId), req.body?.orderID, { deferGate: req.body?.defer_gate === true });
    res.json({ decision, authorized: true, gate_pending: decision === null });
  }));

  app.post('/api/runs/:runId/intent/revoke', limit(20), wrap(async (req, res) => {
    const rev = await svcRevoke(main, await needRun(req.params.runId), req.body?.reason);
    res.json({ revoked: true, revoked_at: rev.revoked_at });
  }));

  app.post('/api/runs/:runId/evaluate', limit(20), wrap(async (req, res) => {
    await needRun(req.params.runId);
    res.json({ decision: await main.gate.evaluate(req.params.runId) });
  }));

  app.get('/api/runs', wrap(async (req, res) => {
    const rows = (await db.query(`SELECT r.id,r.status,r.request_text,r.final_decision,r.scenario,r.mode,r.contract_hash,r.paypal_order_id,r.authorization_id,r.created_at,
      d.reason_codes FROM runs r LEFT JOIN decisions d ON d.run_id=r.id WHERE r.mode=$1 ORDER BY r.created_at DESC LIMIT 100`, [main.mode])).rows;
    res.json(rows);
  }));
  app.get('/api/runs/:runId', wrap(async (req, res) => {
    const run = await ledger.getRun(req.params.runId);
    if (!run) throw httpErr(404, 'run not found');
    res.json(redactRun(run));
  }));
  app.get('/api/runs/:runId/evidence', wrap(async (req, res) => {
    const ev = await ledger.evidence(req.params.runId);
    if (!ev) throw httpErr(404, 'run not found');
    ev.snapshots = redact(ev.snapshots);
    const pem = (await db.query('SELECT public_pem FROM intent_keys WHERE key_id=$1', [ev.contract?.key_id])).rows[0]?.public_pem;
    ev.signature_check = verifyIntent(ev.contract, pem); ev.key_id = ev.contract?.key_id;
    ev.mode = ev.run.mode; ev.banner = ev.run.mode === 'MOCK_SIMULATION' ? 'MOCK — simulated shopper and mock PayPal. No live funds moved.' : banner;
    res.json(ev);
  }));

  // ---- real-time simulation (operator-limited; mock PayPal only)
  app.post('/api/simulation/runs', limit(Number(env.SIM_RATE_LIMIT || 600)), wrap(async (req, res) => {
    const out = await simulation.start({ ...req.body, key: req.get('x-internal-key') });
    res.status(202).json(out);
  }));
  app.get('/api/simulation/stats', wrap(async (req, res) => res.json(await simulation.stats())));
  app.get('/api/simulation/runs', wrap(async (req, res) => res.json(await simulation.rows(Math.min(Number(req.query.limit) || 200, 1000)))));
  app.post('/api/simulation/reset', limit(10), wrap(async (req, res) => {
    if (env.INTERNAL_ACTION_KEY && req.get('x-internal-key') !== env.INTERNAL_ACTION_KEY) throw httpErr(401, 'operator key required');
    simulation.resetCounters(); res.json({ ok: true });
  }));

  // Replay mode: always available, never touches PayPal, the model, or the database.
  app.get('/api/replay', (req, res) => res.json(loadTraces().map((t) => {
    const e = evaluateTrace(t);
    return { id: t.id, title: t.title, fixture: t.fixture, recorded_at: t.recorded_at, model: t.model, decision: e.decision, reason_codes: e.reason_codes, reproduced: e.reproduced, label: 'REPLAY' };
  })));
  app.get('/api/replay/:id', wrap(async (req, res) => {
    const t = loadTraces().find((x) => x.id === req.params.id);
    if (!t) throw httpErr(404, 'trace not found');
    res.json(replayView(t));
  }));

  app.post('/api/webhooks/paypal', limit(120), wrap(async (req, res) => {
    const out = await handleWebhook(req.headers, req.body);
    res.status(out.verified ? 200 : 401).json(out);
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use(express.static(PUBLIC));
  app.close = () => { app.wss?.close(); return db.close(); };
  app.modelClient = modelClient; app.paypal = paypal; app.ledger = ledger; app.db = db; app.bus = bus; app.simulation = simulation;

  // WebSockets only NOTIFY; the database remains the source of truth (clients re-fetch rows/stats).
  app.attachWebSocket = (server) => {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
    app.wss = wss;
    const send = (ws, msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 1_000_000) ws.send(msg); };
    bus.on('event', (e) => { const m = JSON.stringify(e); for (const ws of wss.clients) send(ws, m); });
    wss.on('connection', (ws) => send(ws, JSON.stringify({ event: 'hello', mode: 'MOCK_SIMULATION', timestamp: new Date().toISOString() })));
    return wss;
  };
  return app;
}
