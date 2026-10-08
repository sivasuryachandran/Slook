const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let cfg, runId, orderId;
const grids = {};

async function api(method, path, body, headers = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function setGrid(key, el, opts, rows) {
  if (grids[key]) { grids[key].setGridOption('rowData', rows); return; }
  grids[key] = agGrid.createGrid($(el), { ...opts, rowData: rows, domLayout: 'normal' });
}
const kv = (pairs) => pairs.map(([k, v]) => `<div><b>${esc(k)}</b><code>${esc(v)}</code></div>`).join('');
const statusCell = (p) => `<span class="${p.value === 'FAIL' ? 'fail-cell' : p.value === 'PASS' ? 'pass-cell' : ''}">${esc(p.value)}</span>`;

async function init() {
  cfg = await api('GET', '/api/config');
  const b = $('banner');
  b.textContent = cfg.banner + (cfg.killSwitch ? ' · LIVE ACTIONS DISABLED (kill switch)' : '');
  b.className = cfg.replay ? 'replay' : 'live';
  $('scenario').innerHTML = Object.entries(cfg.scenarios).map(([k, v]) => `<option value="${esc(k)}">${k === 'happy' || v.startsWith('Path') ? '' : 'FIXTURE · '}${esc(v)}</option>`).join('');
  $('keyrow').classList.toggle('hidden', !cfg.fixturesNeedKey);
  setupRunsGrid();
  await loadRuns();
  await loadReplay();
  const q = new URLSearchParams(location.search);
  if (q.get('run') && q.get('token')) { // redirect fallback after PayPal approval
    runId = q.get('run'); orderId = q.get('token');
    $('proposalCard').classList.remove('hidden');
    await authorize(orderId);
  } else if (q.get('run')) await showEvidence(q.get('run'));
}

// ---- optional voice input: Web Speech API -> text box ONLY. No other code path reads speech.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const APPROVAL_ONLY = /^\s*(yes|yeah|yep|ok|okay|sure|confirm|approve|pay|capture|void|go ahead|do it)\b(?:[\s,.!]+(?:pay|it|now|please|the|this|that|payment|order|purchase|capture|approve|confirm|yes))*[\s,.!]*$/i;
let rec = null;
$('micBtn').onclick = () => {
  const note = (t) => { $('voiceNote').textContent = t; };
  if (!SR) { note('Voice input is not supported in this browser. Type your request instead; nothing else changes.'); return; }
  if (rec) { rec.stop(); return; }
  try {
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
    rec.onstart = () => { $('micBtn').classList.add('on'); $('micBtn').setAttribute('aria-pressed', 'true'); note('Listening… the transcript appears in the box. Edit it before you submit.'); };
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (APPROVAL_ONLY.test(text)) { note('Voice cannot approve or pay. Describe what to buy, then review the signed intent.'); return; }
      $('req').value = text; note('Transcribed. Edit if needed, then press "Ask the agent". Voice never approves payments.');
    };
    rec.onerror = (e) => note(`Voice input failed (${e.error || 'error'}). Type your request instead.`);
    rec.onend = () => { rec = null; $('micBtn').classList.remove('on'); $('micBtn').setAttribute('aria-pressed', 'false'); };
    rec.start();
  } catch (e) { rec = null; note('Voice input could not start. Type your request instead.'); }
};

let holdGate = false; let pendingConfirm = false;
const intentItems = (c) => c.items.map((i) => `${i.quantity ? (i.quantity.min === i.quantity.max ? i.quantity.min : i.quantity.min + '–' + i.quantity.max) : '?'}${i.unit ? ' ' + i.unit : ''} × ${i.description}${Object.keys(i.attributes ?? {}).length ? ' (' + Object.values(i.attributes).join(', ') + ')' : ''}`).join(' · ');

$('go').onclick = async () => {
  $('err').textContent = ''; $('go').disabled = true; $('assume').classList.add('hidden'); $('status').textContent = ''; $('err').textContent = cfg.aiLive ? 'The agent is working (model calls can take 5–10 seconds)…' : '';
  try {
    const headers = $('opkey').value ? { 'x-internal-key': $('opkey').value } : {};
    const r = await api('POST', '/api/runs', { request_text: $('req').value, scenario: $('scenario').value, confirm: pendingConfirm }, headers);
    pendingConfirm = false;
    if (r.status === 'NEEDS_INFORMATION') { $('err').textContent = 'I need more information: ' + r.questions.join(' '); return; }
    if (r.status === 'REQUIRE_APPROVAL') {
      $('assume').classList.remove('hidden'); $('assumeText').textContent = r.assumptions.join(' ');
      pendingConfirm = true; $('err').textContent = ''; return;
    }
    runId = r.run_id; orderId = null; holdGate = r.hold;
    $('decision').style.display = 'none'; $('evidenceCard').classList.add('hidden'); $('afterAuth').classList.add('hidden');
    $('proposalCard').classList.remove('hidden');
    const p = r.proposal, c = r.contract;
    $('traceMode').textContent = r.trace_mode === 'LIVE_AGENT_TRACE' ? 'LIVE_AGENT_TRACE' : 'REPLAY_AGENT_TRACE — deterministic agent, not a live model call';
    $('traceMode').className = 'pill ' + (r.trace_mode === 'LIVE_AGENT_TRACE' ? 'live' : 'replay');
    $('fixtureTag').classList.toggle('hidden', !r.fixture);
    $('intentKv').innerHTML = kv([['Run', runId], ['Signed intent', intentItems(c)], ['Maximum total', `${c.max_total} ${c.currency}`], ['Expires', new Date(c.expires_at).toLocaleTimeString()],
      ['Delivery', (c.delivery.countries ?? []).join(',') + (c.delivery.deadline ? ' · ' + c.delivery.deadline : '')], ['Signature', `Ed25519 · ${c.key_id}`], ['Contract hash', c.contract_hash.slice(0, 22) + '…']]);
    $('proposalKv').innerHTML = p.line_items.map((l) => `<div><b>${esc(l.merchant)}</b><code>${esc(l.quantity)} × ${esc(l.title)}${l.variant ? ' (' + esc(l.variant) + ')' : ''} @ ${esc(l.unit_amount)}</code></div>`).join('')
      + kv([['Shipping', p.shipping_amount], ['Proposed total', `${p.total} ${p.currency}`]]);
    $('err').textContent = '';
    $('reasoning').textContent = 'Agent: ' + p.reasoning_summary + (r.trace_error ? ' — ' + r.trace_error : '');
    const ai = r.ai;
    $('aiNote').textContent = ai?.model
      ? `AI: ${ai.model} · intent: ${ai.compile?.used === 'model' ? 'model-assisted (' + ai.compile.agreement + ' with the deterministic parser)' : 'deterministic parser (model output not used)'}${ai.compile?.latency_ms ? ' · ' + ai.compile.latency_ms + ' ms' : ''} · product choice: ${ai.select?.used === 'model' ? 'model' : 'deterministic fallback'}${ai.select?.latency_ms ? ' · ' + ai.select.latency_ms + ' ms' : ''}. Prices always come from product data; the signed intent and gate decide.`
      : 'AI: model off on this server (REPLAY_MODE). The deterministic agent proposed this order.';
    $('poison').classList.toggle('hidden', !p.source_content);
    if (p.source_content) { const f = p.source_content.model_followed_injection; $('poisonText').textContent = `${p.source_content.label}: merchant page said — “${p.source_content.merchant_page_text}”` + (f === true ? ' The model obeyed this instruction on its own (a real model failure).' : f === false ? ' The model declined it; the test fixture added the gift card so the block can be demonstrated.' : ''); }
    const pf = r.preflight; const blocked = pf.decision === 'BLOCK';
    $('preflight').className = 'pf ' + (blocked ? 'bad' : 'ok');
    $('preflight').innerHTML = blocked
      ? `<b>PREFLIGHT: BLOCKED</b> — ${esc(pf.reason_codes.join(', '))}. ${pf.assertions.filter((a) => a.status === 'FAIL').map((a) => `<br>• <b>${esc(a.id)}</b>: expected ${esc(a.expected)}; proposal had ${esc(a.actual)}`).join('')}<br><b>Zero PayPal calls were made. No PayPal order exists.</b>`
      : '<b>PREFLIGHT: PASSED</b> — the proposal stays inside the signed intent. Next: the server creates the PayPal order.';
    $('orderBtn').classList.toggle('hidden', blocked); $('orderBtn').disabled = false;
    $('paypal-buttons').classList.add('hidden'); $('paypal-buttons').innerHTML = ''; $('approveBtn').classList.add('hidden');
    $('status').textContent = blocked ? 'Blocked before PayPal. The evidence is below.' : 'Intent signed. Next: create the PayPal order (AUTHORIZE).';
    if (blocked) await showEvidence(runId);
    await loadRuns();
  } catch (e) { $('err').textContent = e.message; } finally { $('go').disabled = false; }
};
$('confirmBtn').onclick = () => { $('assume').classList.add('hidden'); $('go').click(); };

$('orderBtn').onclick = async () => {
  $('orderBtn').disabled = true;
  try {
    if (cfg.replay) {
      const o = await api('POST', `/api/runs/${runId}/paypal/order`); orderId = o.id;
      $('status').textContent = `Order ${orderId} created (simulated). Waiting for buyer approval.`;
      $('approveBtn').classList.remove('hidden');
    } else await mountPayPal();
    $('orderBtn').classList.add('hidden');
  } catch (e) { $('status').textContent = 'Error: ' + e.message; $('orderBtn').disabled = false; }
};

async function mountPayPal() {
  if (!window.paypal) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&intent=authorize&currency=USD`;
      s.onload = res; s.onerror = () => rej(new Error('PayPal SDK failed to load'));
      document.head.appendChild(s);
    });
  }
  $('paypal-buttons').classList.remove('hidden');
  const thisRun = runId;
  window.paypal.Buttons({
    createOrder: async () => { const o = await api('POST', `/api/runs/${thisRun}/paypal/order`); orderId = o.id; return o.id; },
    onApprove: async (data) => { await authorize(data.orderID); },
    onError: (e) => { $('status').textContent = 'PayPal error: ' + (e?.message || e); },
    onCancel: () => { $('status').textContent = 'Buyer cancelled approval. Nothing was authorized.'; },
  }).render('#paypal-buttons');
  $('status').textContent = 'Approve with your PayPal Sandbox buyer account.';
}

$('approveBtn').onclick = async () => {
  $('approveBtn').disabled = true;
  try { await api('POST', `/api/runs/${runId}/replay/approve`); await authorize(orderId); }
  catch (e) { $('status').textContent = 'Error: ' + e.message; $('approveBtn').disabled = false; }
};

async function authorize(oid) {
  $('approveBtn').classList.add('hidden');
  try {
    if (holdGate) { // Path B: authorize, then pause so the principal can withdraw authority before the gate runs
      $('status').textContent = 'Authorizing…';
      await api('POST', `/api/runs/${runId}/paypal/authorize`, { orderID: oid, defer_gate: true });
      $('afterAuth').classList.remove('hidden');
      $('status').textContent = 'PayPal authorized this order. Funds are NOT captured. Revoke the intent, then run the gate.';
      await showEvidence(runId); return;
    }
    $('status').textContent = 'Authorizing, then the gate re-fetches the order from PayPal…';
    await api('POST', `/api/runs/${runId}/paypal/authorize`, { orderID: oid }); // only the order id is sent
    await showEvidence(runId);
    $('status').textContent = 'Done.';
    const rid = runId;
    for (const ms of [1500, 5000]) setTimeout(() => { if (runId === rid) showEvidence(rid); }, ms); // pick up webhook reconciliation
    await loadRuns();
  } catch (e) { $('status').textContent = 'Error: ' + e.message; }
}
$('revokeBtn').onclick = async () => {
  try { await api('POST', `/api/runs/${runId}/intent/revoke`, { reason: 'user revoked before capture' }); $('status').textContent = 'Intent revoked (signed). Now run the gate: it will fetch the order from PayPal and void.'; $('revokeBtn').disabled = true; await showEvidence(runId); }
  catch (e) { $('status').textContent = 'Error: ' + e.message; }
};
$('gateBtn').onclick = async () => {
  try { $('status').textContent = 'Gate evaluating…'; await api('POST', `/api/runs/${runId}/evaluate`); $('afterAuth').classList.add('hidden'); await showEvidence(runId); $('status').textContent = 'Done.'; await loadRuns(); }
  catch (e) { $('status').textContent = 'Error: ' + e.message; }
};

async function showEvidence(id) {
  const ev = await api('GET', `/api/runs/${id}/evidence`);
  runId = id;
  const fresh = ev.snapshots.find((s) => s.kind === 'GATE_FRESH_GET');
  const t = ev.trace;
  render({
    banner: ev.mode === 'LIVE_SANDBOX' ? 'LIVE SANDBOX run — PayPal Sandbox, test money only' : ev.mode === 'MOCK_SIMULATION' ? 'MOCK run — simulated shopper on a mock PayPal adapter, no live funds moved' : 'REPLAY ADAPTER run — simulated PayPal, no live funds moved',
    decision: ev.decision?.record, assertions: ev.assertions, mode: ev.mode,
    freshText: ev.decision?.record?.stage === 'PREFLIGHT' ? 'No PayPal fetch: blocked at preflight, before any PayPal order existed' : fresh ? `Fresh fetch from PayPal · ${new Date(fresh.created_at).toLocaleTimeString()} · HTTP ${fresh.http_status}${ev.mode !== 'LIVE_SANDBOX' ? ' · SIMULATED' : ''}` : 'Awaiting gate fetch',
    kvs: [['Run', ev.run.id], ['Shopper request', ev.run.request_text], ['Run status', ev.run.status], ['PayPal order', ev.run.paypal_order_id], ['Authorization', ev.run.authorization_id],
      ['Contract hash', ev.run.contract_hash.slice(0, 22) + '…'], ['Signature', ev.signature_check ? (ev.signature_check.ok ? `VALID · ${ev.key_id}` : 'INVALID · ' + ev.signature_check.reason) : '—'], ['Revocation', ev.revocation ? `revoked ${new Date(ev.revocation.revoked_at).toLocaleTimeString()}` : 'not revoked'], ['AI model', t ? `${t.model} (${t.provider})` : '—'], ['Trace', t?.trace_mode], ['Prompt', t?.prompt_version],
      ['Webhooks', ev.webhooks.length ? ev.webhooks.map((w) => w.event_type + (w.verified ? ' ✓' : ' ✗')).join(', ') : 'none yet'],
      ['Ledger integrity', ev.integrity.ok ? `hash chain OK (${ev.integrity.events} events)` : 'BROKEN at event ' + ev.integrity.broken_at],
      ['Mode', ev.mode === 'LIVE_SANDBOX' ? 'LIVE SANDBOX' : ev.mode === 'MOCK_SIMULATION' ? 'MOCK — no live funds moved' : 'REPLAY — no live funds moved']],
    tabs: { 'Signed intent': ev.contract, 'Agent proposal (approved by preflight)': ev.approved_proposal, 'PayPal-fetched order (redacted)': fresh?.body ?? 'not fetched yet',
      'AI trace': t ? { model: t.model, provider: t.provider, prompt_version: t.prompt_version, trace_mode: t.trace_mode, temperature: (t.input ?? {}).temperature, error: t.error, raw_model_output: t.raw_output, proposal: t.proposal } : null,
      'Webhooks': ev.webhooks },
    rows: [
      ...ev.events.map((e) => ({ time: e.created_at, source: 'LEDGER', event: e.kind, detail: JSON.stringify(e.detail) })),
      ...ev.actions.map((a) => ({ time: a.created_at, source: 'PAYPAL ACTION', event: a.action.toUpperCase(), detail: `${a.endpoint} · ${a.request_id} · HTTP ${a.http_status ?? '-'} ${a.status}` })),
      ...ev.webhooks.map((w) => ({ time: w.received_at, source: 'WEBHOOK', event: w.event_type, detail: `${w.event_id} · ${w.verified ? 'verified' : 'UNVERIFIED'} · ${w.verification}` })),
      ...ev.snapshots.map((s) => ({ time: s.created_at, source: 'PAYPAL SNAPSHOT', event: s.kind, detail: `HTTP ${s.http_status} · debug ${s.debug_id ?? '-'} · ${s.mode}` })),
    ],
  });
}

async function showReplay(id) {
  const v = await api('GET', `/api/replay/${id}`);
  runId = null;
  render({
    banner: v.label, replay: true,
    decision: { decision: v.decision, reason_codes: v.reason_codes, idempotency_key: '(recorded) ' + (v.paypal_response_status ?? ''), paypal_action: v.paypal_response_status, paypal_response_status: '—', adapter_mode: 'REPLAY', replayed: true },
    assertions: v.assertions.map((a) => ({ assertion_id: a.id, stage: 'GATE', status: a.status, blocking: a.blocking, expected: a.expected, actual: a.actual, source: a.source, explanation: a.explanation })),
    mode: 'REPLAY',
    freshText: `REPLAY · re-evaluated now by the live gate code against the saved PayPal order · reproduced recorded decision: ${v.reproduced ? 'YES' : 'NO'}`,
    kvs: [['Trace', `${v.id} — ${v.title}`], ['Fixture', v.fixture ? 'CONTROLLED TEST FIXTURE' : 'matching order'], ['Shopper request', v.shopper_request], ['Recorded at', v.recorded_at],
      ['Original model', `${v.model} (temp ${v.temperature}, ${v.prompt_version})`], ['Agent trace when recorded', v.agent_trace_mode_at_recording], ['Recorded decision', v.recorded_decision],
      ['PayPal side', 'simulated adapter fixture (not a live PayPal response)'], ['Webhook fixture', v.webhook_fixture ? v.webhook_fixture.event_type + ' (simulated)' : 'none'], ['Mode', 'REPLAY MODE']],
    tabs: { 'Intent contract': v.contract, 'PayPal order fixture': v.paypal_order_fixture, 'Original model output': { model: v.model, raw_model_output: v.model_raw_output, proposal: v.proposal }, 'Webhook fixture': v.webhook_fixture },
    rows: [{ time: v.recorded_at, source: 'REPLAY', event: 'RECORDED', detail: `${v.title} → ${v.recorded_decision}` }],
  });
}

let assertDetailMap = {};
function render(v) {
  $('evidenceCard').classList.remove('hidden');
  $('evBanner').textContent = v.banner;
  $('evBanner').className = 'pill ' + (v.replay || v.mode !== 'LIVE_SANDBOX' ? 'replay' : 'live');
  const d = v.decision;
  const box = $('decision');
  if (d) {
    box.style.display = 'block'; box.className = d.decision;
    const cap = d.decision === 'CAPTURE'; const pre = d.decision === 'BLOCK';
    const reasons = d.reason_codes.length ? d.reason_codes.join(', ') : 'all blocking assertions passed';
    const sim = v.mode !== 'LIVE_SANDBOX';
    box.innerHTML = `<h3>${cap ? 'CAPTURED — order matched the signed intent' : pre ? 'BLOCKED BEFORE PAYPAL — no order was created' : 'VOIDED — authorization released, nothing captured'}</h3>
      <div>${cap ? 'Signature, expiry and every blocking assertion passed against a fresh PayPal fetch.' : (pre ? 'The proposal exceeded the signed intent: ' : 'The gate refused capture: ') + '<b>' + esc(reasons) + '</b>. Capture was never called.'}</div>
      <div class="moved"><div><b>What moved</b><br>${cap ? 'Funds captured from the authorization (' + (sim ? 'simulated — no real funds' : 'PayPal Sandbox test money') + ').' : pre ? 'Nothing. PayPal was never contacted.' : 'Nothing. The authorization was voided; no capture exists.'}</div>
      <div><b>What did not move</b><br>${cap ? 'No second capture is possible; key ' + esc(d.idempotency_key) : 'No funds were captured.'}</div></div>
      <p class="muted" style="margin:10px 0 0">${esc(d.paypal_action)}${d.idempotency_key ? ` · key <code>${esc(d.idempotency_key)}</code> · HTTP ${esc(d.paypal_response_status)}` : ''} · adapter ${esc(d.adapter_mode)}${d.replayed && !v.replay ? ' · stored decision returned (no new PayPal call)' : ''}</p>`;
  } else box.style.display = 'none';
  $('freshBadge').textContent = v.freshText;
  $('evKv').innerHTML = kv(v.kvs);
  assertDetailMap = Object.fromEntries(v.assertions.map((a) => [a.assertion_id, a]));
  $('assertDetail').textContent = 'Click an assertion row for its explanation.';
  setGrid('assert', 'assertGrid', {
    columnDefs: [
      { field: 'assertion_id', headerName: 'Assertion', width: 170, pinned: 'left' },
      { field: 'stage', width: 110 },
      { field: 'status', width: 100, cellRenderer: statusCell },
      { field: 'expected', flex: 1, minWidth: 160 },
      { field: 'actual', flex: 1, minWidth: 160, cellClass: (p) => (p.data.status === 'FAIL' ? 'fail-cell' : '') },
      { field: 'blocking', width: 100, valueFormatter: (p) => (p.value ? 'blocking' : 'display') },
      { field: 'source', width: 140 }, { field: 'explanation', flex: 2, minWidth: 220 },
    ],
    getRowStyle: (p) => (p.data.status === 'FAIL' ? { background: '#fdecea' } : undefined),
    defaultColDef: { sortable: true, filter: true, resizable: true },
    onRowClicked: (e) => { const a = e.data; $('assertDetail').textContent = `${a.assertion_id}: ${a.status} — ${a.explanation}. Expected ${a.expected}; PayPal reported ${a.actual}. Source: ${a.source}.`; },
    overlayNoRowsTemplate: 'Awaiting gate evaluation',
  }, v.assertions);
  applyFilter(currentFilter);
  const tabs = $('tabs'); tabs.innerHTML = '';
  Object.entries(v.tabs).forEach(([name, val], i) => {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = name;
    b.onclick = () => { $('tabBody').textContent = JSON.stringify(val, null, 2); };
    tabs.appendChild(b); if (i === 0) $('tabBody').textContent = JSON.stringify(val, null, 2);
  });
  setGrid('events', 'eventGrid', {
    columnDefs: [
      { field: 'time', width: 120, valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
      { field: 'source', width: 150 }, { field: 'event', width: 220 }, { field: 'detail', flex: 1, minWidth: 300, tooltipField: 'detail' },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: true },
  }, v.rows.sort((a, b) => new Date(a.time) - new Date(b.time)));
  $('evidenceCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let currentFilter = 'all';
function applyFilter(f) {
  currentFilter = f;
  grids.assert?.setFilterModel(f === 'all' ? null : { status: { filterType: 'text', type: 'equals', filter: f === 'fail' ? 'FAIL' : 'PASS' } });
  document.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
}
document.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => applyFilter(b.dataset.f); });

async function loadReplay() {
  const rows = await api('GET', '/api/replay');
  setGrid('replay', 'replayGrid', {
    columnDefs: [
      { field: 'id', width: 80 }, { field: 'title', flex: 2, minWidth: 260 },
      { field: 'decision', width: 120, cellRenderer: (p) => `<span class="${p.value === 'VOID' ? 'fail-cell' : 'pass-cell'}">${esc(p.value)}</span>` },
      { field: 'reason_codes', headerName: 'Mismatch reasons', flex: 2, minWidth: 220, valueFormatter: (p) => (p.value || []).join(', ') || '—' },
      { field: 'fixture', width: 130, valueFormatter: (p) => (p.value ? 'TEST FIXTURE' : 'matching') },
      { field: 'reproduced', headerName: 'Reproduced', width: 120, valueFormatter: (p) => (p.value ? 'yes' : 'NO') },
      { field: 'model', width: 250 },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: true },
    onRowClicked: (e) => showReplay(e.data.id), rowStyle: { cursor: 'pointer' },
  }, rows);
}

function setupRunsGrid() {
  setGrid('runs', 'runGrid', {
    columnDefs: [
      { field: 'created_at', headerName: 'Created', width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
      { field: 'id', headerName: 'Run', width: 150 },
      { field: 'final_decision', headerName: 'Decision', width: 120, cellRenderer: (p) => p.value ? `<span class="${p.value === 'CAPTURE' ? 'pass-cell' : 'fail-cell'}">${esc(p.value)}</span>` : '—' },
      { field: 'status', width: 130 },
      { field: 'scenario', width: 150, valueFormatter: (p) => (p.value === 'happy' ? 'normal' : 'FIXTURE: ' + p.value) },
      { field: 'reason_codes', headerName: 'Reasons', flex: 1, minWidth: 200, valueFormatter: (p) => (p.value || []).join(', ') },
      { field: 'mode', width: 170 }, { field: 'request_text', headerName: 'Request', flex: 1, minWidth: 220 },
    ],
    defaultColDef: { sortable: true, filter: true, resizable: true },
    onRowClicked: (e) => showEvidence(e.data.id),
    rowStyle: { cursor: 'pointer' },
  }, []);
}
async function loadRuns() { grids.runs.setGridOption('rowData', await api('GET', '/api/runs')); }
$('refresh').onclick = loadRuns;
init().catch((e) => { $('banner').textContent = 'Failed to load: ' + e.message; });
