// Append-only evidence ledger helpers.
import { createHash } from 'node:crypto';
import { canonicalize } from './contract.js';

const chainHash = (prev, runId, kind, detail, at) =>
  createHash('sha256').update(`${prev}|${runId}|${kind}|${canonicalize(detail ?? null)}|${at}`).digest('hex');

// Maps persisted ledger kinds to the live stream vocabulary. The DB stays the source of truth; the stream only notifies.
function streamEvents(kind, d = {}) {
  const dec = d.decision;
  switch (kind) {
    case 'CONTRACT_FROZEN': return [['run.created'], ['ai.proposal.created']];
    case 'ORDER_CREATED': return [['paypal.order.created'], ['buyer.approval.required']];
    case 'BUYER_APPROVED': return [['buyer.approved']];
    case 'AUTHORIZED': return [['paypal.order.authorized']];
    case 'GATE_EVALUATING': return [['gate.evaluating']];
    case 'PREFLIGHT': return [[dec === 'BLOCK' ? 'preflight.blocked' : 'preflight.passed']];
    case 'INTENT_REVOKED': return [['intent.revoked']];
    case 'DECISION': return dec === 'BLOCK' ? [['gate.blocked'], ['run.completed']] : dec === 'CAPTURE' ? [['gate.approved'], ['payment.captured'], ['run.completed']] : [['gate.blocked'], ['gate.voided'], ['run.completed']];
    case 'WEBHOOK': return [['webhook.received']];
    default: return [];
  }
}

export function makeLedger(db, mode, bus) {
  const metaCache = new Map();
  const metaFor = async (runId) => {
    if (!metaCache.has(runId)) {
      const r = (await db.query('SELECT shopper_id, COALESCE(sim_scenario, scenario) AS scenario, mode FROM runs WHERE id=$1', [runId])).rows[0];
      metaCache.set(runId, r ?? {});
    }
    return metaCache.get(runId);
  };
  const j = (v) => JSON.stringify(v ?? null);
  const queues = new Map(); // serialize appends per run so the hash chain cannot fork
  return {
    // Append-only, hash-chained: each event commits to its predecessor (tamper-evident, not tamper-proof).
    event(runId, kind, detail) {
      const run = async () => {
        const last = (await db.query('SELECT hash FROM ledger_events WHERE run_id=$1 ORDER BY id DESC LIMIT 1', [runId])).rows[0];
        const prev = last?.hash ?? 'GENESIS';
        const at = new Date().toISOString();
        await db.query('INSERT INTO ledger_events(run_id,kind,detail,created_at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6)',
          [runId, kind, j(detail), at, prev, chainHash(prev, runId, kind, detail, at)]);
        if (bus) {
          const m = await metaFor(runId);
          for (const [event] of streamEvents(kind, detail ?? {})) {
            bus.emit('event', { event, run_id: runId, shopper_id: m.shopper_id ?? null, scenario: m.scenario ?? null, mode: m.mode ?? mode,
              decision: detail?.decision ?? null, proposal: detail?.trace_mode ? (detail.fallback ? 'Fallback' : detail.trace_mode === 'LIVE_AGENT_TRACE' ? 'Live AI' : 'Ready') : null, reason: detail?.reason_codes?.length ? detail.reason_codes.join(', ') : null, latency_ms: detail?.latency_ms ?? null, timestamp: at });
          }
        }
      };
      const p = (queues.get(runId) ?? Promise.resolve()).then(run, run);
      queues.set(runId, p.catch(() => {}));
      return p;
    },
    async verifyChain(runId) {
      const rows = (await db.query('SELECT kind,detail,created_at,prev_hash,hash FROM ledger_events WHERE run_id=$1 ORDER BY id', [runId])).rows;
      let prev = 'GENESIS';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const at = new Date(r.created_at).toISOString();
        if (r.prev_hash !== prev || r.hash !== chainHash(prev, runId, r.kind, r.detail, at)) return { ok: false, events: rows.length, broken_at: i };
        prev = r.hash;
      }
      return { ok: true, events: rows.length, head: prev };
    },
    async snapshot(runId, kind, res, requestId) {
      const r = await db.query(
        'INSERT INTO paypal_snapshots(run_id,kind,request_id,http_status,debug_id,mode,body) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [runId, kind, requestId ?? null, res.status, res.debugId ?? null, mode, j(res.body)]);
      return r.rows[0].id;
    },
    async getRun(id) {
      return (await db.query('SELECT * FROM runs WHERE id=$1', [id])).rows[0];
    },
    async setStatus(id, status, extra = {}) {
      const cols = ['status=$2', 'updated_at=now()'];
      const vals = [id, status];
      for (const [k, v] of Object.entries(extra)) { vals.push(v); cols.push(`${k}=$${vals.length}`); }
      await db.query(`UPDATE runs SET ${cols.join(',')} WHERE id=$1`, vals);
    },
    async evidence(runId) {
      const q = async (s) => (await db.query(s, [runId])).rows;
      const run = await this.getRun(runId);
      if (!run) return null;
      return {
        run: redactRun(run),
        contract: run.contract_json,
        approved_proposal: run.proposal_json,
        revocation: run.revocation_json,
        trace: (await q('SELECT provider,model,prompt_version,raw_output,proposal,trace_mode,error,created_at FROM agent_traces WHERE run_id=$1 ORDER BY id'))[0] ?? null,
        snapshots: await q('SELECT id,kind,request_id,http_status,debug_id,mode,body,created_at FROM paypal_snapshots WHERE run_id=$1 ORDER BY id'),
        assertions: await q('SELECT assertion_id,stage,status,blocking,expected,actual,source,explanation,evaluator_version FROM assertions WHERE run_id=$1 ORDER BY id'),
        actions: await q('SELECT action,request_id,endpoint,status,http_status,created_at FROM actions WHERE run_id=$1 ORDER BY id'),
        decision: (await q('SELECT decision,reason_codes,record,created_at FROM decisions WHERE run_id=$1'))[0] ?? null,
        webhooks: await q('SELECT event_id,event_type,verified,verification,received_at FROM webhook_events WHERE run_id=$1 ORDER BY received_at'),
        integrity: await this.verifyChain(runId),
        events: await q('SELECT kind,detail,created_at,hash FROM ledger_events WHERE run_id=$1 ORDER BY id'),
      };
    },
  };
}
export function redactRun(r) {
  const { lease_at, order_draft, proposal_json, revocation_json, ...rest } = r;
  return rest;
}
