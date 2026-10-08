const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = { valid_order: 'Valid order', price_mutation: 'Price mutation', poisoned_proposal: 'Poisoned proposal', revoked_intent: 'Intent revoked', quantity_mutation: 'Quantity mutation', sku_mutation: 'SKU mutation', shipping_country_mismatch: 'Shipping country', malformed_ai_output: 'Malformed AI output', happy: 'Valid order', inflated_total: 'Price mutation', wrong_quantity: 'Quantity mutation', wrong_variant: 'SKU mutation', wrong_country: 'Shipping country' };
const MIXES = { clean: { valid_order: 100 }, hostile: { valid_order: 30, price_mutation: 25, quantity_mutation: 20, sku_mutation: 15, shipping_country_mismatch: 10 } };
const rows = new Map(); let gridApi; let statsTimer = null; let reasonsLast = '';

const PAYPAL_STATE = { 'run.created': 'Not created', 'paypal.order.created': 'Created', 'buyer.approval.required': 'Awaiting buyer', 'buyer.approved': 'Approved', 'paypal.order.authorized': 'Authorized', 'gate.evaluating': 'Authorized', 'gate.approved': 'Authorized', 'gate.blocked': 'Authorized', 'payment.captured': 'Captured', 'gate.voided': 'Voided', 'run.completed': null, 'webhook.received': null };
const STAGE = { 'run.created': 'Created', 'ai.proposal.created': 'Proposal ready', 'paypal.order.created': 'Order created', 'buyer.approval.required': 'Awaiting buyer', 'buyer.approved': 'Approved', 'paypal.order.authorized': 'AUTHORIZED', 'gate.evaluating': 'Gate evaluating', 'gate.approved': 'Gate: pass', 'gate.blocked': 'BLOCKED', 'payment.captured': 'CAPTURED', 'gate.voided': 'VOIDED' };

async function api(m, p, b, h = {}) {
  const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
}
const fromDb = (r) => ({ run_id: r.run_id, shopper: r.shopper_id, scenario: NAMES[r.scenario] ?? r.scenario, proposal: r.trace_mode === 'LIVE_AGENT_TRACE' ? 'Live AI' : r.trace_error ? 'Fallback' : 'Ready',
  paypal: r.decision === 'CAPTURE' ? 'Captured' : r.decision === 'VOID' ? 'Voided' : r.decision === 'BLOCK' ? 'No order created' : r.authorization_id ? 'Authorized' : 'Pending', decision: r.decision, stage: r.decision === 'CAPTURE' ? 'CAPTURED' : r.decision === 'VOID' ? 'VOIDED' : r.decision === 'BLOCK' ? 'BLOCKED' : r.status,
  reasons: (r.reason_codes ?? []).join(', '), latency: r.gate_ms, created: r.created_at });

function setupGrid() {
  gridApi = agGrid.createGrid($('grid'), {
    columnDefs: [
      { field: 'shopper', width: 135 }, { field: 'scenario', width: 160 },
      { field: 'proposal', headerName: 'AI proposal', width: 120, cellClass: (p) => (p.value === 'Fallback' ? 'fail-cell' : '') },
      { field: 'paypal', headerName: 'PayPal state', width: 130 },
      { field: 'stage', headerName: 'Gate / stage', width: 150, cellRenderer: (p) => `<span class="${p.value === 'VOIDED' || p.value === 'BLOCKED' ? 'fail-cell' : p.value === 'CAPTURED' ? 'pass-cell' : ''}">${esc(p.value)}</span>` },
      { field: 'decision', width: 110, cellRenderer: (p) => (p.value ? `<span class="${p.value === 'CAPTURE' ? 'pass-cell' : 'fail-cell'}">${esc(p.value)}</span>` : '…') },
      { field: 'reasons', headerName: 'Mismatch', flex: 1, minWidth: 180 },
      { field: 'latency', headerName: 'Gate latency', width: 130, valueFormatter: (p) => (p.value == null ? '' : p.value >= 1000 ? (p.value / 1000).toFixed(2) + ' s' : Math.round(p.value) + ' ms') },
      { field: 'created', hide: true, sort: 'desc' },
    ],
    getRowId: (p) => p.data.run_id, defaultColDef: { sortable: true, filter: true, resizable: true },
    getRowStyle: (p) => (p.data.decision === 'VOID' || p.data.decision === 'BLOCK' ? { background: '#fdecea' } : undefined),
    onRowClicked: (e) => window.open('/?run=' + e.data.run_id, '_blank'),
    rowStyle: { cursor: 'pointer' }, asyncTransactionWaitMillis: 120, animateRows: false,
  });
}
function upsert(row) { const exists = rows.has(row.run_id); rows.set(row.run_id, { ...(rows.get(row.run_id) ?? {}), ...row }); gridApi.applyTransactionAsync(exists ? { update: [rows.get(row.run_id)] } : { add: [rows.get(row.run_id)] }); }

function onEvent(e) {
  if (e.event === 'hello' || e.mode !== 'MOCK_SIMULATION') return;
  const cur = rows.get(e.run_id) ?? { run_id: e.run_id, shopper: e.shopper_id, scenario: NAMES[e.scenario] ?? e.scenario, proposal: 'Ready', paypal: 'Pending', stage: 'Created', created: e.timestamp };
  const patch = { run_id: e.run_id, shopper: e.shopper_id ?? cur.shopper, scenario: NAMES[e.scenario] ?? cur.scenario };
  if (e.proposal) patch.proposal = e.proposal;
  if (STAGE[e.event]) patch.stage = STAGE[e.event];
  if (PAYPAL_STATE[e.event]) patch.paypal = PAYPAL_STATE[e.event];
  if (e.event === 'gate.approved') patch.decision = 'CAPTURE';
  if (e.event === 'gate.blocked') { patch.decision = e.decision ?? 'VOID'; patch.reasons = e.reason; if (e.decision === 'BLOCK') patch.paypal = 'No order created'; }
  if (e.latency_ms != null) patch.latency = e.latency_ms;
  upsert({ ...cur, ...patch });
  const line = document.createElement('div');
  line.className = /blocked|voided/.test(e.event) ? 'blocked' : /captured|approved/.test(e.event) ? 'ok' : '';
  line.textContent = `${new Date(e.timestamp).toLocaleTimeString()}  ${e.shopper_id ?? e.run_id}  ${e.event}${e.reason ? '  — ' + e.reason : ''}`;
  const s = $('stream'); s.prepend(line); while (s.childElementCount > 80) s.lastChild.remove();
  clearTimeout(statsTimer); statsTimer = setTimeout(loadStats, 250);
}

const tile = (label, v, cls = '') => `<div class="tile ${cls}"><b>${label}</b><span>${v ?? '—'}</span></div>`;
const ms = (v) => (v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v + ' ms');
async function loadStats() {
  const s = await api('GET', '/api/simulation/stats');
  $('tiles').innerHTML = tile('Active shoppers', s.active_shoppers) + tile('Total runs', s.total) + tile('Captured', s.captured, 'ok') + tile('Voided after auth', s.voided, 'bad') + tile('Blocked pre-PayPal', s.blocked_preflight, 'bad')
    + tile('Mismatches caught', s.mismatches_caught, 'bad') + tile('Detection rate', s.mismatch_detection_rate == null ? '—' : s.mismatch_detection_rate + '%')
    + tile('Avg gate latency', ms(s.gate_latency_ms.avg)) + tile('P95 gate latency', ms(s.gate_latency_ms.p95)) + tile('AI fallback rate', s.ai_fallback_rate + '%') + tile('Errors', s.errors, s.errors ? 'bad' : '');
  const r = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} <b>${v}</b>`).join(' · ') || 'none yet';
  if (r !== reasonsLast) { $('reasons').innerHTML = r; reasonsLast = r; }
}
async function loadRows() { (await api('GET', '/api/simulation/runs?limit=300')).forEach((r) => upsert(fromDb(r))); }

async function start(n, opts = {}) {
  $('msg').textContent = '';
  const mix = MIXES[$('mix').value];
  try {
    const r = await api('POST', '/api/simulation/runs', { count: n, mix, think_ms: 600, ...opts }, $('key').value ? { 'x-internal-key': $('key').value } : {});
    $('msg').textContent = `Accepted ${r.accepted} simulated shoppers (${r.mode}). Watch the grid.`;
  } catch (e) { $('msg').textContent = e.message; }
}
document.querySelectorAll('[data-n]').forEach((b) => { b.onclick = () => start(Number(b.dataset.n)); });
$('inject').onclick = () => start(5, { scenario: 'price_mutation', mix: undefined });
$('reset').onclick = async () => { try { await api('POST', '/api/simulation/reset', null, $('key').value ? { 'x-internal-key': $('key').value } : {}); rows.clear(); gridApi.setGridOption('rowData', []); $('stream').innerHTML = ''; loadStats(); } catch (e) { $('msg').textContent = e.message; } };

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { $('conn').textContent = '● live (WebSocket)'; $('conn').style.color = '#0f766e'; };
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => { $('conn').textContent = '○ reconnecting… (polling)'; $('conn').style.color = '#b42318'; setTimeout(connect, 2000); loadRows().catch(() => {}); loadStats().catch(() => {}); };
}
setupGrid(); await loadRows(); await loadStats(); connect();
setInterval(() => loadStats().catch(() => {}), 5000); // safety net: DB is the source of truth
