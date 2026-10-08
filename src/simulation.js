// Real-time simulation: virtual shoppers drive the SAME services and the SAME deterministic gate as real users,
// against a MOCK PayPal adapter (never real PayPal). Simulated shoppers have no handle on capture/void.
const SCENARIOS = {
  valid_order: { fixture: 'happy', expect: 'CAPTURE' },
  price_mutation: { fixture: 'inflated_total', expect: 'VOID' },
  quantity_mutation: { fixture: 'wrong_quantity', expect: 'VOID' },
  sku_mutation: { fixture: 'wrong_variant', expect: 'VOID' },
  shipping_country_mismatch: { fixture: 'wrong_country', expect: 'VOID' },
  poisoned_proposal: { fixture: 'poisoned_proposal', expect: 'BLOCK' }, // blocked at preflight: zero PayPal calls
  revoked_intent: { fixture: 'revoke_before_capture', expect: 'VOID', revoke: true }, // authorized, then revoked before the gate runs
  malformed_ai_output: { fixture: 'happy', expect: 'CAPTURE', llm: async () => 'Sure, I chose the black pack {"sku": "PACK-BLK' }, // model fails → deterministic fallback
};
export const SIM_SCENARIOS = Object.keys(SCENARIOS);
const DEFAULT_MIX = { valid_order: 64, price_mutation: 9, quantity_mutation: 6, sku_mutation: 5, shipping_country_mismatch: 4, poisoned_proposal: 5, revoked_intent: 3, malformed_ai_output: 4 };
const REQ = 'Buy one black travel backpack under $90 delivered';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pctile = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]); };

export function createSimulation({ db, bus, env, sim, svc }) {
  const limits = { unauthenticated: 25, withKey: 500, maxActive: Number(env.SIM_MAX_ACTIVE || 600) };
  let seq = 0; let active = 0; let epoch = new Date(0); const counters = { started: 0, errors: 0 };
  const errorSamples = [];

  const pick = (mix) => {
    const entries = Object.entries(mix).filter(([k, w]) => SCENARIOS[k] && w > 0);
    if (!entries.length) return 'valid_order';
    let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
    return entries[0][0];
  };

  async function create(shopperId, scenario) {
    const def = SCENARIOS[scenario];
    const run = await svc.createRun(sim, { text: REQ, scenario: def.fixture, shopperId, simScenario: scenario, llm: def.llm });
    return { ...run, revoke: !!def.revoke };
  }
  async function proceed(run, thinkMs) {
    try {
      if (run.status === 'BLOCKED') return; // preflight blocked it: no PayPal order is ever created
      const getRun = () => sim.ledger.getRun(run.run_id);
      const order = await svc.createOrder(sim, await getRun());
      await sleep(thinkMs); // the simulated buyer is "approving"
      await svc.approve(sim, await getRun());
      if (run.revoke) { // authority withdrawn after authorization, before the gate evaluates
        await svc.authorize(sim, await getRun(), order.body.id, { deferGate: true });
        await svc.revoke(sim, await getRun(), 'simulated revocation');
        await svc.evaluate(sim, run.run_id);
      } else await svc.authorize(sim, await getRun(), order.body.id); // runs the deterministic gate: the only path to capture/void
    } catch (e) {
      counters.errors++; if (errorSamples.length < 20) errorSamples.push(e.message);
      bus.emit('event', { event: 'run.error', run_id: run.run_id, mode: sim.mode, reason: e.message, timestamp: new Date().toISOString() });
    } finally { active--; }
  }

  async function start(opts = {}) {
    const count = Math.max(1, Math.floor(Number(opts.count) || 1));
    const authed = !env.INTERNAL_ACTION_KEY || opts.key === env.INTERNAL_ACTION_KEY;
    const cap = authed ? limits.withKey : limits.unauthenticated;
    if (count > cap) throw Object.assign(new Error(`count ${count} exceeds the limit of ${cap}${authed ? '' : ' (operator key required for more)'}`), { status: authed ? 400 : 401 });
    if (active + count > limits.maxActive) throw Object.assign(new Error('simulation capacity reached, try again shortly'), { status: 429 });
    if (opts.scenario && !SCENARIOS[opts.scenario]) throw Object.assign(new Error('unknown scenario'), { status: 400 });
    const mix = opts.mix && typeof opts.mix === 'object' ? opts.mix : DEFAULT_MIX;
    const thinkMs = Math.min(Math.max(Number(opts.think_ms ?? 400), 0), 5000);
    const staggerMs = Math.min(Math.max(Number(opts.stagger_ms ?? (count > 1 ? 40 : 0)), 0), 2000);
    const batchId = 'batch_' + Date.now().toString(36);
    active += count; counters.started += count;
    const launch = async (n) => {
      const scenario = opts.scenario ?? pick(mix);
      const shopperId = opts.shopper_id && count === 1 ? String(opts.shopper_id).slice(0, 40) : `shopper-${String(++seq).padStart(4, '0')}`;
      try { const run = await create(shopperId, scenario); return { run, scenario, shopperId }; }
      catch (e) { active--; counters.errors++; if (errorSamples.length < 20) errorSamples.push(e.message); throw e; }
    };
    if (count === 1) {
      const { run, scenario, shopperId } = await launch(0);
      proceed(run, thinkMs);
      return { accepted: 1, batch_id: batchId, run_id: run.run_id, shopper_id: shopperId, scenario, mode: sim.mode };
    }
    (async () => {
      for (let i = 0; i < count; i++) {
        launch(i).then(({ run }) => proceed(run, thinkMs)).catch(() => {});
        if (staggerMs) await sleep(staggerMs);
      }
    })();
    return { accepted: count, batch_id: batchId, mode: sim.mode, note: 'runs stream in over /ws; poll GET /api/simulation/runs' };
  }

  async function rows(limit = 200) {
    const r = await db.query(`SELECT r.id AS run_id, r.shopper_id, COALESCE(r.sim_scenario, r.scenario) AS scenario, r.status, r.final_decision AS decision, r.created_at, r.mode, r.authorization_id,
        d.reason_codes, (d.record->>'latency_ms')::float AS gate_ms, t.trace_mode, t.error AS trace_error, d.created_at AS decided_at
      FROM runs r LEFT JOIN decisions d ON d.run_id=r.id LEFT JOIN agent_traces t ON t.run_id=r.id
      WHERE r.mode=$1 AND r.created_at >= $3 ORDER BY r.created_at DESC LIMIT $2`, [sim.mode, limit, epoch.toISOString()]);
    return r.rows;
  }

  async function stats() {
    const ep = epoch.toISOString();
    const q = async (sql, p = [sim.mode, ep]) => (await db.query(sql, p)).rows;
    const byOutcome = await q(`SELECT COALESCE(sim_scenario, scenario) AS sc, final_decision AS dec, count(*)::int AS n FROM runs WHERE mode=$1 AND created_at >= $2 GROUP BY 1,2`);
    const pct = (await q(`SELECT count(*)::int AS n,
        avg((d.record->>'latency_ms')::float) AS g_avg,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (d.record->>'latency_ms')::float) AS g50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY (d.record->>'latency_ms')::float) AS g95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY (d.record->>'latency_ms')::float) AS g99,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d.created_at - r.created_at))*1000) AS e50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d.created_at - r.created_at))*1000) AS e95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d.created_at - r.created_at))*1000) AS e99,
        min(r.created_at) AS first_at, max(d.created_at) AS last_at
      FROM runs r JOIN decisions d ON d.run_id=r.id WHERE r.mode=$1 AND r.created_at >= $2`))[0];
    const reasonRows = await q(`SELECT c, count(*)::int AS n FROM (SELECT jsonb_array_elements_text(d.reason_codes) AS c FROM runs r JOIN decisions d ON d.run_id=r.id WHERE r.mode=$1 AND r.created_at >= $2) x GROUP BY c`);
    const fb = (await q(`SELECT count(*)::int AS n FROM runs r JOIN agent_traces t ON t.run_id=r.id WHERE r.mode=$1 AND r.created_at >= $2 AND t.trace_mode='REPLAY_AGENT_TRACE' AND t.error IS NOT NULL`))[0].n;
    const total = byOutcome.reduce((s, r) => s + r.n, 0);
    const decided = byOutcome.filter((r) => r.dec).reduce((s, r) => s + r.n, 0);
    const sum = (f) => byOutcome.filter(f).reduce((s, r) => s + r.n, 0);
    const isMut = (r) => SCENARIOS[r.sc] && SCENARIOS[r.sc].expect !== 'CAPTURE';
    const mutRuns = sum((r) => r.dec && isMut(r)); const mutVoided = sum((r) => (r.dec === 'VOID' || r.dec === 'BLOCK') && isMut(r));
    const round = (x) => (x == null ? null : Math.round(x));
    const scen = {}; for (const r of byOutcome) scen[r.sc] = (scen[r.sc] ?? 0) + r.n;
    const span = pct.first_at && pct.last_at ? (new Date(pct.last_at) - new Date(pct.first_at)) / 1000 : 0;
    return {
      mode: sim.mode, total, active_shoppers: active, in_flight: total - decided, decided,
      captured: sum((r) => r.dec === 'CAPTURE'), voided: sum((r) => r.dec === 'VOID'),
      mismatches_caught: mutVoided, mutation_runs: mutRuns, mutations_missed: sum((r) => r.dec === 'CAPTURE' && isMut(r)),
      false_blocks: sum((r) => (r.dec === 'VOID' || r.dec === 'BLOCK') && !isMut(r)), blocked_preflight: sum((r) => r.dec === 'BLOCK'),
      mismatch_detection_rate: mutRuns ? Math.round((1000 * mutVoided) / mutRuns) / 10 : null,
      ai_fallback_rate: total ? Math.round((1000 * fb) / total) / 10 : 0,
      gate_latency_ms: { avg: round(pct.g_avg), p50: round(pct.g50), p95: round(pct.g95), p99: round(pct.g99) },
      end_to_end_ms: { p50: round(pct.e50), p95: round(pct.e95), p99: round(pct.e99) },
      throughput_decisions_per_s: span > 0 ? Math.round((10 * decided) / span) / 10 : null,
      reasons: Object.fromEntries(reasonRows.map((r) => [r.c, r.n])), scenarios: scen,
      errors: counters.errors, error_samples: errorSamples.slice(0, 5), paypal_api_errors: counters.errors, truncated: false,
    };
  }

  return { start, stats, rows, limits, resetCounters() { epoch = new Date(); counters.errors = 0; errorSamples.length = 0; } };
}
