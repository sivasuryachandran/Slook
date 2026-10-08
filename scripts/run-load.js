// Runs a k6 profile against a freshly spawned server, waits for every run to settle, and writes reports/load-<profile>.json.
//   node scripts/run-load.js <smoke|demo|normal|stress|spike|soak>
import { spawn, execFileSync } from 'node:child_process';
const runK6 = (args) => new Promise((resolve) => { const c = spawn('k6', args, { stdio: ['ignore', 'ignore', 'inherit'] }); c.on('close', (code) => resolve(code ?? 1)); }); // async: a sync exec would freeze the resource sampler
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const profile = process.argv[2] || 'smoke';
const port = 3400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), LIVE_PAYPAL: 'false', REPLAY_MODE: 'true', SIM_RATE_LIMIT: '100000000', SIM_MAX_ACTIVE: '5000', NODE_ENV: 'production' };
delete env.NVIDIA_API_KEY; delete env.PAYPAL_CLIENT_SECRET; // load tests never need credentials
const srv = spawn('node', ['src/server.js'], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(base + p)).json();
const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(srv.pid)]).toString().trim()) / 1024;
const cpu = () => Number(execFileSync('ps', ['-o', '%cpu=', '-p', String(srv.pid)]).toString().trim());
for (let i = 0; i < 60; i++) { try { await j('/healthz'); break; } catch { await sleep(250); } }
mkdirSync('reports', { recursive: true });
const rss0 = rss(); const rssSeries = []; let rssPeak = rss0, cpuPeak = 0, inflightPeak = 0, activePeak = 0;
let tick = 0;
const sampler = setInterval(async () => { try { if (++tick % 30 === 0) rssSeries.push(Math.round(rss())); rssPeak = Math.max(rssPeak, rss()); cpuPeak = Math.max(cpuPeak, cpu()); const s = await j('/api/simulation/stats'); inflightPeak = Math.max(inflightPeak, s.in_flight); activePeak = Math.max(activePeak, s.active_shoppers); } catch {} }, 1000);
const summaryFile = `reports/k6-${profile}.summary.json`;
const t0 = Date.now();
let k6exit = 0;
k6exit = await runK6(['run', '--quiet', '-e', `BASE_URL=${base}`, '-e', `PROFILE=${profile}`, '--summary-trend-stats', 'avg,med,p(90),p(95),p(99)', '--summary-export', summaryFile, 'tests/load/shoppers.js']);
const loadSeconds = (Date.now() - t0) / 1000;
let drain = 0; let s;
for (let i = 0; i < 600; i++) { s = await j('/api/simulation/stats'); if (s.in_flight === 0 && s.active_shoppers === 0) break; await sleep(500); drain += 0.5; }
await sleep(1500); s = await j('/api/simulation/stats'); // let webhooks land
clearInterval(sampler);
const k6 = JSON.parse(readFileSync(summaryFile, 'utf8')).metrics;
const out = {
  generated_at: new Date().toISOString(), profile, adapter: 'MOCK_SIMULATION (never real PayPal)', db: 'PGlite in-process (single connection) — not Postgres on Render',
  k6_threshold_exit_code: k6exit, load_seconds: Math.round(loadSeconds), drain_seconds_after_load: drain,
  peak_virtual_users: k6.vus_max?.value, http: { requests: k6.http_reqs?.count, req_per_s: Math.round(k6.http_reqs?.rate * 10) / 10, failed_rate: k6.http_req_failed?.value, duration_ms: { avg: Math.round(k6.http_req_duration?.avg), p50: Math.round(k6.http_req_duration?.med), p95: Math.round(k6.http_req_duration?.['p(95)']), p99: k6.http_req_duration?.['p(99)'] ? Math.round(k6.http_req_duration['p(99)']) : null } },
  runs_accepted_by_k6: k6.accepted?.count, stats: s,
  resources: { server_rss_mb_start: Math.round(rss0), server_rss_mb_peak: Math.round(rssPeak), server_cpu_percent_peak: cpuPeak, peak_in_flight_runs: inflightPeak, peak_active_shoppers: activePeak, rss_mb_every_30s: rssSeries },
};
writeFileSync(`reports/load-${profile}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ profile, vus: out.peak_virtual_users, accepted: out.runs_accepted_by_k6, decided: s.decided, captured: s.captured, voided: s.voided, errors: s.errors, mutations_missed: s.mutations_missed, false_blocks: s.false_blocks, http_p95: out.http.duration_ms.p95, failed_rate: out.http.failed_rate, gate_p95: s.gate_latency_ms.p95, e2e_p95: s.end_to_end_ms.p95, drain_s: drain, rss_peak_mb: out.resources.server_rss_mb_peak, k6_exit: k6exit }));
srv.kill(); process.exit(0);
