// Slook web app. One page, hash-routed views. Everything shown comes from the server's real records.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => USD.format(Number(n ?? 0));
const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const clock = (t) => (t ? new Date(t).toLocaleTimeString() : '—');
const REASONS = { 'amount.total': 'Total exceeded the signed limit', 'items.unrequested': 'Item you never asked for', 'intent.revoked': 'Intent revoked before capture', 'intent.fresh': 'Intent expired', 'intent.signature': 'Signature check failed',
  'items.quantity': 'Quantity outside the signed range', 'items.sku': 'Product differs from the approved one', 'items.variant': 'Variant differs', 'items.unit_amount': 'Unit price above the approved price', 'shipping.country': 'Ship-to country not allowed',
  'policy.substitution': 'Unapproved substitution', 'catalog.price': 'Price differs from catalog', 'link.custom_id': 'Order not linked to this intent', 'paypal.state': 'Unexpected PayPal state', 'amount.currency': 'Currency mismatch', 'items.coverage': 'A requested item is missing', 'shipping.amount': 'Shipping above the approved amount' };
const reasonText = (c) => REASONS[c] ?? c;
let cfg = null; const grids = {};

async function api(method, path, body, headers = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('toasts').appendChild(t); setTimeout(() => t.remove(), 3500); }
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });

function statusOf(r) {
  if (r.final_decision === 'CAPTURE') return { cls: 'ok', label: 'Captured' };
  if (r.final_decision === 'VOID') return { cls: 'bad', label: 'Voided' };
  if (r.final_decision === 'BLOCK') return { cls: 'bad', label: 'Blocked' };
  if (r.status === 'AUTHORIZED' || r.status === 'VERIFYING') return { cls: 'info', label: 'Authorized' };
  if (r.status === 'APPROVAL_PENDING') return { cls: 'warn', label: 'Awaiting approval' };
  return { cls: 'muted', label: 'Draft' };
}
const chip = (s) => `<span class="chip ${s.cls}">${esc(s.label)}</span>`;
const kv = (pairs) => pairs.filter(Boolean).map(([k, v, mono]) => `<div><b>${esc(k)}</b>${mono ? `<code class="mono">${esc(v)}</code>` : `<span>${esc(v)}</span>`}</div>`).join('');
const copyable = (v) => (v ? `<code class="mono">${esc(v)}</code><button class="copy" data-copy="${esc(v)}" aria-label="Copy">copy</button>` : '—');

/* =============================== router =============================== */
const ROUTES = { overview: ['Overview', loadOverview], new: ['New purchase', showNew], activity: ['Activity', showActivity], run: ['Receipt', null], security: ['Security', showSecurity] };
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/'); const key = ROUTES[name || 'overview'] ? (name || 'overview') : 'overview';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'v-' + key));
  document.querySelectorAll('.nav a').forEach((a) => (a.getAttribute('data-route') === (key === 'run' ? 'activity' : key) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('pageTitle').textContent = ROUTES[key][0]; document.title = `${ROUTES[key][0]} · Slook`;
  $('side').classList.remove('open'); $('menuBtn').setAttribute('aria-expanded', 'false'); window.scrollTo(0, 0);
  if (key === 'run') showReceipt(arg); else ROUTES[key][1]?.();
}
window.addEventListener('hashchange', route);
$('menuBtn').onclick = () => { const o = $('side').classList.toggle('open'); $('menuBtn').setAttribute('aria-expanded', String(o)); };

/* =============================== overview =============================== */
let overviewTimer;
async function loadOverview() {
  try {
    const [d, runs] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/runs?limit=8')]);
    const s = (cls, label, value, sub) => `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
    $('stats').innerHTML = s('ok', 'Captured', money(d.captured.amount), `${d.captured.count} purchase${d.captured.count === 1 ? '' : 's'} settled`)
      + s('bad', 'Voided after authorization', d.voided.count, `${money(d.voided.amount)} released, nothing captured`)
      + s('bad', 'Blocked before PayPal', d.blocked.count, `${money(d.blocked.amount)} never reached PayPal`)
      + s('info', 'Value stopped', money(d.value_stopped), `${d.total} purchase${d.total === 1 ? '' : 's'} · ${d.in_progress.count} in progress`);
    const seg = [['Captured', d.captured.count, 'var(--ok)'], ['Voided', d.voided.count, 'var(--bad)'], ['Blocked', d.blocked.count, '#e08a8a'], ['In progress', d.in_progress.count, '#9db4d6']].filter((x) => x[1] > 0);
    $('mix').innerHTML = d.total ? `<div class="bar" role="img" aria-label="Outcome mix">${seg.map(([, n, c]) => `<i style="width:${(100 * n) / d.total}%;background:${c}"></i>`).join('')}</div><div class="legend">${seg.map(([l, n, c]) => `<span style="--c:${c}"><b>${n}</b> ${l}</span>`).join('')}</div>` : '<div class="small muted">No purchases yet.</div>';
    $('reasons').innerHTML = d.top_reasons.length ? `<table class="t"><tbody>${d.top_reasons.map((r) => `<tr><td>${esc(reasonText(r.c))}<div class="small muted mono">${esc(r.c)}</div></td><td class="num"><b>${r.n}</b></td></tr>`).join('')}</tbody></table>` : 'No stopped payments yet.';
    $('recent').innerHTML = runs.length ? `<table class="t click"><thead><tr><th>When</th><th>Request</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${runs.map((r) => `<tr data-run="${esc(r.id)}"><td class="small muted">${when(r.created_at)}</td><td>${esc((r.request_text || '').slice(0, 62))}${(r.request_text || '').length > 62 ? '…' : ''}</td><td class="num">${money(r.total)}</td><td>${chip(statusOf(r))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><b>No purchases yet</b>Start your first sandbox purchase to see it recorded here.<div style="margin-top:12px"><a class="btn primary" href="#/new">New purchase</a></div></div>';
    $('recent').querySelectorAll('tr[data-run]').forEach((tr) => { tr.onclick = () => { location.hash = '#/run/' + tr.dataset.run; }; });
  } catch (e) { $('stats').innerHTML = `<div class="banner bad">Could not load the overview: ${esc(e.message)}</div>`; }
}
const refreshOverview = () => { clearTimeout(overviewTimer); overviewTimer = setTimeout(() => { if (!$('v-overview').classList.contains('hidden')) loadOverview(); if (grids.act) loadActivity(); }, 350); };

/* =============================== new purchase =============================== */
let runId = null; let orderId = null; let holdGate = false; let pendingConfirm = false; let paypalMounted = null;
const EXAMPLES = ['Buy 12 donuts and 3 kg of grapes for Friday morning under $80.', 'Buy biryani tonight under $25.', 'Find a suitable birthday cake under $60.', 'Buy one black travel backpack under $90 delivered'];
function fillExamples() { for (const id of ['examples', 'newExamples']) { $(id).innerHTML = EXAMPLES.map((t) => `<button class="chipbtn" type="button" data-ex="${esc(t)}">${esc(t.length > 52 ? t.slice(0, 50) + '…' : t)}</button>`).join(''); } }
document.addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (!b) return; $('req').value = b.dataset.ex; if (location.hash !== '#/new') location.hash = '#/new'; setTimeout(() => $('req').focus(), 50); });
function showNew() { /* state persists between visits */ }
function setStep(n, state = 'now') {
  document.querySelectorAll('#stepper li').forEach((li) => { const i = Number(li.dataset.s); li.className = i < n ? 'done' : i === n ? state : ''; });
  if (state === 'done') document.querySelectorAll('#stepper li').forEach((li) => { li.className = 'done'; });
}
const intentItems = (c) => c.items.map((i) => `${i.quantity ? (i.quantity.min === i.quantity.max ? i.quantity.min : i.quantity.min + '–' + i.quantity.max) : '?'}${i.unit ? ' ' + i.unit : ''} × ${i.description}${Object.keys(i.attributes ?? {}).length ? ' (' + Object.values(i.attributes).join(', ') + ')' : ''}`).join(' · ');

$('go').onclick = async () => {
  $('err').textContent = cfg?.ai?.enabled ? 'The agent is working (model calls can take 5–10 seconds)…' : ''; $('go').disabled = true; $('assume').classList.add('hidden');
  try {
    const headers = $('opkey').value ? { 'x-internal-key': $('opkey').value } : {};
    const r = await api('POST', '/api/runs', { request_text: $('req').value, scenario: $('scenario').value, confirm: pendingConfirm }, headers);
    pendingConfirm = false;
    if (r.status === 'NEEDS_INFORMATION') { $('err').textContent = 'I need more information: ' + r.questions.join(' '); return; }
    if (r.status === 'REQUIRE_APPROVAL') { $('assume').classList.remove('hidden'); $('assumeText').textContent = r.assumptions.join(' '); pendingConfirm = true; $('err').textContent = ''; return; }
    $('err').textContent = '';
    runId = r.run_id; orderId = null; holdGate = r.hold; paypalMounted = null;
    $('flow').classList.remove('hidden'); $('decision').innerHTML = ''; $('afterAuth').classList.add('hidden'); $('paypal-buttons').classList.add('hidden'); $('paypal-buttons').innerHTML = ''; $('approveBtn').classList.add('hidden'); $('orderBtn').classList.add('hidden'); $('status').textContent = '';
    const p = r.proposal, c = r.contract;
    $('intentKv').innerHTML = kv([['Request', c.request_text], ['Signed intent', intentItems(c)], ['Maximum total', `${c.max_total} ${c.currency}`], ['Expires', new Date(c.expires_at).toLocaleTimeString()],
      ['Delivery', (c.delivery.countries ?? []).join(', ') + (c.delivery.deadline ? ' · ' + c.delivery.deadline : '')], ['Signature', `Ed25519 · ${c.key_id}`, true], ['Contract hash', c.contract_hash.slice(0, 24) + '…', true], ['Run', runId, true]]);
    $('proposalTable').innerHTML = `<table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead><tbody>${p.line_items.map((l) => `<tr><td>${esc(l.title)}${l.variant ? ' <span class="muted">(' + esc(l.variant) + ')</span>' : ''}<div class="small muted">${esc(l.merchant)}</div></td><td class="num">${esc(l.quantity)}</td><td class="num">${money(l.unit_amount)}</td><td class="num">${money(Number(l.unit_amount) * l.quantity)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3" class="muted" style="font-weight:500">Shipping</td><td class="num" style="font-weight:500">${money(p.shipping_amount)}</td></tr><tr><td colspan="3">Proposed total</td><td class="num">${money(p.total)}</td></tr></tfoot></table>`;
    $('reasoning').textContent = 'Agent: ' + p.reasoning_summary + (r.trace_error ? ' — ' + r.trace_error : '');
    const ai = r.ai;
    $('aiNote').textContent = ai?.model
      ? `AI: ${ai.model} · intent: ${ai.compile?.used === 'model' ? 'model-assisted (' + ai.compile.agreement + ' with the deterministic parser)' : 'deterministic parser (model output not used)'}${ai.compile?.latency_ms ? ' · ' + ai.compile.latency_ms + ' ms' : ''} · product choice: ${ai.select?.used === 'model' ? 'model' : 'deterministic fallback'}${ai.select?.latency_ms ? ' · ' + ai.select.latency_ms + ' ms' : ''}. Prices always come from product data; the signed intent and gate decide.`
      : 'AI: the model is off on this server; the deterministic agent proposed this order.';
    $('poison').classList.toggle('hidden', !p.source_content);
    if (p.source_content) { const f = p.source_content.model_followed_injection; $('poisonText').textContent = `${p.source_content.label}: merchant page said — “${p.source_content.merchant_page_text}”` + (f === true ? ' The model obeyed this instruction on its own (a real model failure).' : f === false ? ' The model declined it; the test fixture added the gift card so the block can be demonstrated.' : ''); }
    const pf = r.preflight; const blocked = pf.decision === 'BLOCK';
    $('preflight').className = 'banner ' + (blocked ? 'bad' : 'ok');
    $('preflight').innerHTML = blocked
      ? `<b>PREFLIGHT: BLOCKED</b> — ${esc(pf.reason_codes.map(reasonText).join('; '))}.${pf.assertions.filter((a) => a.status === 'FAIL').map((a) => `<br>• <b>${esc(a.id)}</b>: expected ${esc(a.expected)}; the proposal had ${esc(a.actual)}`).join('')}<br><b>No PayPal order was created and PayPal was never contacted.</b>`
      : '<b>PREFLIGHT: PASSED</b> — the proposal stays inside your signed intent. Next: approve the payment with PayPal.';
    $('approveCard').classList.toggle('hidden', blocked);
    if (blocked) { setStep(2, 'fail'); await showDecision(runId); }
    else {
      setStep(3);
      if (cfg.replay) { $('orderBtn').classList.remove('hidden'); $('orderBtn').disabled = false; $('status').textContent = 'Demo mode: PayPal is simulated on this server. Create the order, then simulate the buyer approval.'; }
      else await mountPayPal();
    }
    $('flow').scrollIntoView({ behavior: 'smooth', block: 'start' }); refreshOverview();
  } catch (e) { $('err').textContent = e.message; } finally { $('go').disabled = false; }
};
$('confirmBtn').onclick = () => { $('assume').classList.add('hidden'); $('go').click(); };

$('orderBtn').onclick = async () => {
  $('orderBtn').disabled = true;
  try { const o = await api('POST', `/api/runs/${runId}/paypal/order`); orderId = o.id; $('orderBtn').classList.add('hidden'); $('approveBtn').classList.remove('hidden'); $('status').textContent = `Order ${orderId} created. Waiting for the buyer's approval.`; }
  catch (e) { $('status').textContent = 'Error: ' + e.message; $('orderBtn').disabled = false; }
};
async function mountPayPal() {
  if (!window.paypal) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&intent=authorize&currency=USD`; s.onload = res; s.onerror = () => rej(new Error('PayPal SDK failed to load')); document.head.appendChild(s); });
  }
  const thisRun = runId; paypalMounted = thisRun;
  $('paypal-buttons').classList.remove('hidden');
  window.paypal.Buttons({
    style: { layout: 'vertical', shape: 'rect', label: 'pay' },
    createOrder: async () => { const o = await api('POST', `/api/runs/${thisRun}/paypal/order`); orderId = o.id; return o.id; },
    onApprove: async (data) => { await authorize(data.orderID); },
    onError: (e) => { $('status').textContent = 'PayPal error: ' + (e?.message || e); },
    onCancel: () => { $('status').textContent = 'Approval cancelled. Nothing was authorized.'; },
  }).render('#paypal-buttons');
  $('status').textContent = 'Approve with your PayPal Sandbox buyer account. Test money only.';
}
$('approveBtn').onclick = async () => {
  $('approveBtn').disabled = true;
  try { await api('POST', `/api/runs/${runId}/replay/approve`); await authorize(orderId); } catch (e) { $('status').textContent = 'Error: ' + e.message; $('approveBtn').disabled = false; }
};
async function authorize(oid) {
  $('approveBtn').classList.add('hidden'); $('paypal-buttons').classList.add('hidden');
  try {
    if (holdGate) {
      $('status').textContent = 'Authorizing…';
      await api('POST', `/api/runs/${runId}/paypal/authorize`, { orderID: oid, defer_gate: true });
      setStep(4); $('afterAuth').classList.remove('hidden');
      $('status').textContent = 'PayPal authorized this order. Funds are NOT captured. Revoke the intent, then run the gate.'; return;
    }
    setStep(4); $('status').textContent = 'Authorized. The gate is fetching the order from PayPal and checking it against your signed intent…';
    await api('POST', `/api/runs/${runId}/paypal/authorize`, { orderID: oid });
    await showDecision(runId);
  } catch (e) { $('status').textContent = 'Error: ' + e.message; }
}
$('revokeBtn').onclick = async () => {
  try { await api('POST', `/api/runs/${runId}/intent/revoke`, { reason: 'user revoked before capture' }); $('revokeBtn').disabled = true; $('status').textContent = 'Intent revoked (signed record). Now run the gate: it will fetch the order from PayPal and void.'; }
  catch (e) { $('status').textContent = 'Error: ' + e.message; }
};
$('gateBtn').onclick = async () => {
  try { $('status').textContent = 'Gate evaluating…'; await api('POST', `/api/runs/${runId}/evaluate`); $('afterAuth').classList.add('hidden'); await showDecision(runId); } catch (e) { $('status').textContent = 'Error: ' + e.message; }
};
async function showDecision(id) {
  const ev = await api('GET', `/api/runs/${id}/evidence`);
  const d = ev.decision?.record; if (!d) return;
  const cap = d.decision === 'CAPTURE'; const pre = d.decision === 'BLOCK';
  setStep(5, cap ? 'done' : 'fail'); if (!cap) document.querySelectorAll('#stepper li').forEach((li) => { if (Number(li.dataset.s) < (pre ? 3 : 5)) li.className = 'done'; });
  const sim = ev.mode !== 'LIVE_SANDBOX';
  $('decision').innerHTML = `<div class="result-card ${cap ? 'ok' : 'bad'}"><h4>${cap ? 'Captured: the order matched your signed intent' : pre ? 'Blocked before PayPal: no order was created' : 'Voided: authorization released, nothing captured'}</h4>
    <div>${cap ? 'Signature, expiry and every blocking check passed against a fresh PayPal fetch.' : (pre ? 'The proposal exceeded your signed intent: ' : 'The gate refused capture: ') + '<b>' + esc(d.reason_codes.map(reasonText).join('; ')) + '</b>.'}</div>
    <div class="moved"><div><b>What moved</b><br>${cap ? (sim ? 'Simulated capture (demo mode). No real or test funds.' : 'Sandbox test funds were captured from the authorization.') : pre ? 'Nothing. PayPal was never contacted.' : 'Nothing. The authorization was voided; no capture exists.'}</div><div><b>What did not move</b><br>${cap ? 'No second capture is possible (idempotency key ' + esc(d.idempotency_key) + ').' : 'No funds were captured.'}</div></div>
    <div class="row noprint" style="margin-top:12px"><a class="btn primary" href="#/run/${esc(id)}">View receipt &amp; evidence</a><a class="btn" href="#/new" id="again">New purchase</a></div></div>`;
  $('again').onclick = (e) => { e.preventDefault(); $('flow').classList.add('hidden'); setStep(1); window.scrollTo(0, 0); };
  $('status').textContent = '';
  refreshOverview();
}

/* ---- optional voice input: Web Speech API -> text box ONLY. No other code path reads speech. */
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

/* =============================== activity =============================== */
let actFilter = 'All'; let actRows = [];
const actStatus = (r) => statusOf(r).label;
function showActivity() {
  if (!grids.act) {
    $('filters').innerHTML = ['All', 'Captured', 'Voided', 'Blocked', 'In progress'].map((f) => `<button class="chipbtn${f === 'All' ? ' on' : ''}" data-f="${f}">${f}</button>`).join('');
    $('filters').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; actFilter = b.dataset.f; document.querySelectorAll('#filters .chipbtn').forEach((x) => x.classList.toggle('on', x === b)); grids.act.onFilterChanged(); };
    $('search').oninput = (e) => grids.act.setGridOption('quickFilterText', e.target.value);
    grids.act = agGrid.createGrid($('actGrid'), {
      columnDefs: [
        { field: 'created_at', headerName: 'When', width: 150, valueFormatter: (p) => when(p.value), sort: 'desc' },
        { field: 'request_text', headerName: 'Request', flex: 2, minWidth: 260, tooltipField: 'request_text' },
        { field: 'merchants', headerName: 'Merchant', width: 170, valueFormatter: (p) => (p.value ?? []).join(', ') },
        { field: 'total', headerName: 'Amount', width: 120, type: 'rightAligned', valueFormatter: (p) => money(p.value) },
        { headerName: 'Status', width: 150, valueGetter: (p) => actStatus(p.data), cellRenderer: (p) => chip(statusOf(p.data)) },
        { headerName: 'Reason', flex: 1, minWidth: 200, valueGetter: (p) => (p.data.reason_codes ?? []).map(reasonText).join('; ') },
        { field: 'paypal_order_id', headerName: 'PayPal order', width: 170, valueFormatter: (p) => p.value ?? '—' },
      ],
      rowData: [], getRowId: (p) => p.data.id, defaultColDef: { sortable: true, filter: true, resizable: true }, animateRows: false,
      isExternalFilterPresent: () => actFilter !== 'All', doesExternalFilterPass: (n) => { const s = actStatus(n.data); return actFilter === 'In progress' ? !['Captured', 'Voided', 'Blocked'].includes(s) : s === actFilter; },
      onRowClicked: (e) => { location.hash = '#/run/' + e.data.id; }, rowStyle: { cursor: 'pointer' },
      overlayNoRowsTemplate: '<div class="empty"><b>No transactions yet</b>Start a purchase to see it here.</div>',
    });
  }
  loadActivity();
}
async function loadActivity() { try { actRows = await api('GET', '/api/runs?limit=300'); grids.act.setGridOption('rowData', actRows); } catch (e) { toast('Could not load activity: ' + e.message); } }

/* =============================== receipt =============================== */
const TL = { CONTRACT_FROZEN: ['Intent signed', 'info'], ORDER_CREATED: ['PayPal order created', 'info'], BUYER_APPROVED: ['Buyer approved in PayPal', 'info'], AUTHORIZED: ['PayPal authorized the order (no funds captured)', 'info'], INTENT_REVOKED: ['Intent revoked by the principal', 'warn'], GATE_EVALUATING: ['Gate fetched the order from PayPal and checked it', 'info'] };
async function showReceipt(id) {
  const el = $('receipt'); el.innerHTML = '<div class="skeleton" style="height:180px"></div>'; grids.rcpt?.destroy(); grids.rcpt = null;
  try {
    const ev = await api('GET', `/api/runs/${id}/evidence`); const run = ev.run; const st = statusOf(run);
    const d = ev.decision?.record; const prop = ev.approved_proposal; const c = ev.contract;
    const fresh = ev.snapshots.find((s) => s.kind === 'GATE_FRESH_GET'); const paid = fresh?.body?.purchase_units?.[0]?.amount?.value;
    const mode = ev.mode === 'LIVE_SANDBOX' ? ['info', 'Sandbox · real PayPal'] : ev.mode === 'MOCK_SIMULATION' ? ['warn', 'Mock harness'] : ['warn', 'Demo mode · simulated PayPal'];
    const cap = d?.decision === 'CAPTURE'; const pre = d?.decision === 'BLOCK';
    const tl = [];
    for (const e of ev.events) {
      if (e.kind === 'PREFLIGHT') tl.push([e.created_at, e.detail?.decision === 'BLOCK' ? 'Preflight blocked the proposal: ' + (e.detail.reason_codes ?? []).map(reasonText).join('; ') : 'Preflight passed: proposal inside the signed intent', e.detail?.decision === 'BLOCK' ? 'bad' : 'ok', '']);
      else if (e.kind === 'DECISION') tl.push([e.created_at, e.detail.decision === 'CAPTURE' ? 'Captured' : e.detail.decision === 'VOID' ? 'Voided: ' + (e.detail.reason_codes ?? []).map(reasonText).join('; ') : 'Decision: blocked before PayPal', e.detail.decision === 'CAPTURE' ? 'ok' : 'bad', d?.paypal_action ?? '']);
      else if (e.kind === 'WEBHOOK') tl.push([e.created_at, `PayPal webhook received: ${e.detail?.event_type}`, 'ok', e.detail?.event_id]);
      else if (TL[e.kind]) tl.push([e.created_at, TL[e.kind][0], TL[e.kind][1], e.kind === 'AUTHORIZED' ? e.detail?.authorization_id : e.kind === 'ORDER_CREATED' ? e.detail?.paypal_order_id : '']);
    }
    el.innerHTML = `
      <div class="card"><div class="receipt-head"><div><div class="small muted">Receipt · ${esc(when(run.created_at))}</div><div class="amount">${money(paid ?? prop?.total)}</div>
        <div class="row" style="margin-top:6px">${chip(st)}<span class="chip ${mode[0]} plain">${mode[1]}</span>${run.scenario !== 'happy' && run.scenario ? `<span class="chip warn plain">Test scenario: ${esc(run.scenario)}</span>` : ''}</div></div>
        <div style="max-width:440px"><div class="small muted">Request</div><div>${esc(run.request_text)}</div></div></div></div>
      ${d ? `<div class="result-card ${cap ? 'ok' : 'bad'}" style="margin-top:16px"><h4>${cap ? 'Captured: matched the signed intent' : pre ? 'Blocked before PayPal' : 'Voided: capture refused'}</h4>
        <div>${cap ? 'Every blocking check passed against a fresh PayPal fetch.' : '<b>' + esc(d.reason_codes.map(reasonText).join('; ')) + '</b>'}</div>
        <div class="moved"><div><b>What moved</b><br>${cap ? (ev.mode === 'LIVE_SANDBOX' ? 'Sandbox test funds were captured.' : 'Simulated capture. No funds.') : 'Nothing. ' + (pre ? 'PayPal was never contacted.' : 'The authorization was voided.')}</div><div><b>PayPal action</b><br><span class="small">${esc(d.paypal_action)}${d.idempotency_key ? ` · key <span class="mono">${esc(d.idempotency_key)}</span>` : ''}</span></div></div></div>` : '<div class="banner info" style="margin-top:16px">This purchase has not been decided yet.</div>'}
      <div class="grid g-main" style="margin-top:16px">
        <div class="stack">
          <div class="card"><h3>Line items</h3><table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead><tbody>${(prop?.line_items ?? []).map((l) => `<tr><td>${esc(l.title)}<div class="small muted">${esc(l.merchant)}${l.unverified_product ? ' · unverified product' : ''}</div></td><td class="num">${esc(l.quantity)}</td><td class="num">${money(l.unit_amount)}</td><td class="num">${money(Number(l.unit_amount) * l.quantity)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td colspan="3" class="muted" style="font-weight:500">Shipping</td><td class="num" style="font-weight:500">${money(prop?.shipping_amount)}</td></tr><tr><td colspan="3">Proposed total</td><td class="num">${money(prop?.total)}</td></tr>${paid && paid !== prop?.total ? `<tr><td colspan="3" style="color:var(--bad)">Total PayPal actually held (differs from the approved total)</td><td class="num" style="color:var(--bad)">${money(paid)}</td></tr>` : ''}</tfoot></table></div>
          <div class="card"><h3>Verification: expected vs. what PayPal reported</h3><div id="rcptGrid"></div><p class="small muted" id="assertDetail" style="margin:8px 0 0">Click a row for its explanation.</p></div>
        </div>
        <div class="stack">
          <div class="card"><h3>Your signed intent</h3><div class="kv" style="grid-template-columns:1fr">${kv([['Authorized by you', intentItems(c)], ['Maximum total', `${c.max_total} ${c.currency}`], ['Expires', when(c.expires_at)], ['Signature', ev.signature_check?.ok ? `Valid · ${ev.key_id}` : 'INVALID · ' + (ev.signature_check?.reason ?? ''), true], ['Revocation', ev.revocation ? 'Revoked ' + clock(ev.revocation.revoked_at) : 'Not revoked']])}</div></div>
          <div class="card"><h3>PayPal</h3><div class="kv" style="grid-template-columns:1fr"><div><b>Order ID</b>${copyable(run.paypal_order_id)}</div><div><b>Authorization ID</b>${copyable(run.authorization_id)}</div>${kv([['Fresh fetch by the gate', fresh ? `${clock(fresh.created_at)} · HTTP ${fresh.http_status}` : pre ? 'Not needed: blocked before PayPal' : 'Pending'], ['Webhooks', ev.webhooks.length ? ev.webhooks.map((w) => w.event_type + (w.verified ? ' ✓ verified' : ' ✗ unverified')).join(', ') : 'None received'], ['Ledger integrity', ev.integrity.ok ? `Hash chain verified (${ev.integrity.events} events)` : 'BROKEN at event ' + ev.integrity.broken_at], ['AI', ev.trace ? `${ev.trace.model} · ${ev.trace.trace_mode}` : '—'], ['Run', run.id, true]])}</div></div>
          <div class="card"><h3>Timeline</h3><ul class="timeline">${tl.map(([t, label, cls, ref]) => `<li class="${cls}"><b>${esc(label)}</b><small>${esc(clock(t))}${ref ? ' · <span class="mono">' + esc(ref) + '</span>' : ''}</small></li>`).join('')}</ul></div>
        </div>
      </div>
      <div class="card noprint" style="margin-top:16px"><h3>Raw evidence</h3><div class="chips" id="rawTabs"></div><pre class="json" id="rawBody"></pre></div>`;
    const raw = { 'Signed intent': c, 'Agent proposal': prop, 'PayPal order (redacted)': fresh?.body ?? 'not fetched', 'AI trace': ev.trace, 'Webhooks': ev.webhooks, 'Decision record': d };
    const showRaw = (k) => { $('rawBody').textContent = JSON.stringify(raw[k], null, 2); document.querySelectorAll('#rawTabs .chipbtn').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); };
    $('rawTabs').innerHTML = Object.keys(raw).map((k) => `<button class="chipbtn" data-k="${esc(k)}">${esc(k)}</button>`).join(''); $('rawTabs').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) showRaw(b.dataset.k); }; showRaw('Signed intent');
    const rows = ev.assertions.filter((a) => a.status !== 'INFO');
    grids.rcpt = agGrid.createGrid($('rcptGrid'), {
      columnDefs: [
        { field: 'assertion_id', headerName: 'Check', width: 160, wrapText: true, autoHeight: true }, { field: 'stage', width: 120, valueFormatter: (p) => (p.value === 'PREFLIGHT' ? 'Preflight' : 'Gate') },
        { field: 'status', width: 100, cellRenderer: (p) => `<span class="chip ${p.value === 'PASS' ? 'ok' : 'bad'}">${esc(p.value)}</span>`, cellStyle: { display: 'flex', alignItems: 'center' } },
        { field: 'expected', flex: 1, minWidth: 170, wrapText: true, autoHeight: true }, { field: 'actual', flex: 1, minWidth: 170, wrapText: true, autoHeight: true, cellStyle: (p) => (p.data.status === 'FAIL' ? { color: 'var(--bad)', fontWeight: 650 } : null) },
      ], rowData: rows, domLayout: 'autoHeight', defaultColDef: { resizable: true, sortable: true },
      getRowStyle: (p) => (p.data.status === 'FAIL' ? { background: '#fdecec' } : undefined),
      onRowClicked: (e) => { const a = e.data; $('assertDetail').textContent = `${a.assertion_id} (${a.stage}): ${a.status}. ${a.explanation}. Expected ${a.expected}; reported ${a.actual}.`; },
    });
    $('printBtn').onclick = () => window.print(); $('copyLink').onclick = () => copy(location.href);
  } catch (e) { el.innerHTML = `<div class="empty"><b>Receipt not found</b>${esc(e.message)}<div style="margin-top:12px"><a class="btn" href="#/activity">Back to activity</a></div></div>`; }
}

/* =============================== security =============================== */
function showSecurity() {
  const s = cfg.security; const live = cfg.mode === 'LIVE_SANDBOX';
  const row = (label, ok, text) => `<tr><td>${esc(label)}</td><td>${ok === null ? '<span class="chip muted">n/a</span>' : `<span class="chip ${ok ? 'ok' : 'warn'}">${ok ? 'Active' : 'Attention'}</span>`}</td><td class="small muted">${text}</td></tr>`;
  $('secBody').innerHTML = `<div class="grid g2"><div class="card"><h3>Workspace</h3><table class="t"><tbody>
    ${row('Environment', true, live ? 'PayPal Sandbox. Test accounts and test money only.' : 'Demo mode: PayPal is simulated on this server. No PayPal calls are made.')}
    ${row('Intent signing', !s.ephemeralKey, `${esc(s.algorithm)} · key <span class="mono">${esc(s.keyId)}</span>${s.ephemeralKey ? ' · ephemeral key: contracts will not verify after a restart' : ''}`)}
    ${row('PayPal webhooks', live ? s.webhookConfigured : null, live ? (s.webhookConfigured ? 'Signed events are verified through PayPal before they are trusted.' : 'No webhook ID configured: events cannot be verified.') : 'Not applicable in demo mode.')}
    ${row('AI model', cfg.ai.enabled, cfg.ai.enabled ? `${esc(cfg.ai.model)}: proposes intent and products; never decides.` : 'Off: the deterministic agent is used.')}
    ${row('Database', true, esc(s.db))}</tbody></table></div>
    <div class="card"><h3>What holds, always</h3><ul class="small" style="margin:0;padding-left:18px;line-height:1.7">
      <li>Your request is signed (Ed25519) <b>before</b> any PayPal order exists.</li>
      <li>A proposal outside the signed intent is blocked with <b>zero PayPal calls</b>.</li>
      <li>The gate re-fetches the order from PayPal itself and ignores browser-supplied amounts, items and IDs.</li>
      <li>Only the gate can capture or void, once, under a stable idempotency key.</li>
      <li>Revoked or expired intent grants no authority, even after PayPal authorized.</li>
      <li>Every step is written to a hash-chained ledger.</li></ul></div></div>
    <div class="card" style="margin-top:16px"><h3>What this is not</h3><ul class="small muted" style="margin:0;padding-left:18px;line-height:1.7">
      <li>Not escrow, not fraud scoring, and not a replacement for PayPal's merchant-side cart validation.</li>
      <li>Sandbox only. There is no production mode and no way to enter real card or bank details.</li>
      <li>The merchants and products shown are demo data, not live stores. Payments are real Sandbox transactions, not real money.</li>
      <li>"Agent-independent" means the AI has no keys, no PayPal credentials and no capture/void endpoint. The gate runs in the same server process.</li>
      <li>The ledger is tamper-evident, not tamper-proof.</li></ul></div>`;
}

/* =============================== boot =============================== */
function connectWs() {
  const dot = $('liveDot');
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { dot.className = 'chip ok'; dot.textContent = 'Live'; };
  ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.event && e.event !== 'hello' && e.mode === cfg.mode) refreshOverview(); } catch {} };
  ws.onclose = () => { dot.className = 'chip warn'; dot.textContent = 'Reconnecting…'; setTimeout(connectWs, 2500); };
}
async function init() {
  fillExamples();
  cfg = await api('GET', '/api/config');
  const live = cfg.mode === 'LIVE_SANDBOX';
  $('envPill').textContent = live ? 'Sandbox' : 'Demo mode'; $('envPill').className = 'chip ' + (live ? 'info' : 'warn');
  $('envBanner').className = 'env-banner ' + (live ? 'sandbox' : 'demo');
  $('envBanner').textContent = cfg.killSwitch ? 'Live PayPal actions are disabled (kill switch).' : live ? 'PayPal Sandbox: real Sandbox orders, test money only. Never use a real card or real PayPal login.' : 'Demo mode: PayPal is simulated on this server and no funds move. Configure Sandbox credentials for real PayPal.';
  $('footMode').textContent = live ? 'PayPal Sandbox' : 'Demo mode'; $('footKey').textContent = cfg.security.keyId;
  $('scenario').innerHTML = Object.entries(cfg.scenarios).map(([k, v]) => `<option value="${esc(k)}">${k === 'happy' ? 'Standard purchase' : (v.startsWith('Path') ? '' : 'Test fixture · ') + esc(v)}</option>`).join('');
  $('keyrow').classList.toggle('hidden', !cfg.fixturesNeedKey);
  const q = new URLSearchParams(location.search);
  if (q.get('run') && q.get('token')) { // PayPal redirect fallback
    try { await api('POST', `/api/runs/${q.get('run')}/paypal/authorize`, { orderID: q.get('token') }); } catch (e) { toast(e.message); }
    history.replaceState(null, '', '/#/run/' + q.get('run'));
  } else if (q.get('run')) history.replaceState(null, '', '/#/run/' + q.get('run'));
  route(); connectWs();
}
init().catch((e) => { $('view').innerHTML = `<div class="view"><div class="banner bad">Slook could not start: ${esc(e.message)}</div></div>`; });
