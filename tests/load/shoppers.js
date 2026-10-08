// k6 load test for the simulation API. MOCK PayPal only: it never touches real PayPal Sandbox.
//   k6 run -e BASE_URL=http://localhost:3000 -e PROFILE=demo tests/load/shoppers.js
// Profiles: smoke(5) demo(25) normal(100) stress(250) spike(500) soak(50 for 10m)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const PROFILES = {
  smoke: [{ duration: '5s', target: 5 }, { duration: '15s', target: 5 }, { duration: '5s', target: 0 }],
  demo: [{ duration: '10s', target: 25 }, { duration: '30s', target: 25 }, { duration: '5s', target: 0 }],
  normal: [{ duration: '15s', target: 100 }, { duration: '45s', target: 100 }, { duration: '10s', target: 0 }],
  stress: [{ duration: '20s', target: 250 }, { duration: '40s', target: 250 }, { duration: '10s', target: 0 }],
  spike: [{ duration: '3s', target: 500 }, { duration: '20s', target: 500 }, { duration: '5s', target: 0 }],
  soak: [{ duration: '30s', target: 50 }, { duration: '9m', target: 50 }, { duration: '30s', target: 0 }],
};
const profile = __ENV.PROFILE || 'smoke';
export const options = {
  scenarios: { shoppers: { executor: 'ramping-vus', startVUs: 0, stages: PROFILES[profile], gracefulRampDown: '5s' } },
  thresholds: { http_req_failed: ['rate<0.02'], http_req_duration: ['p(95)<1500'], accepted: ['count>0'] },
};
const accepted = new Counter('accepted');
const SCENARIOS = ['valid_order', 'valid_order', 'valid_order', 'valid_order', 'valid_order', 'valid_order', 'valid_order', 'price_mutation', 'price_mutation', 'quantity_mutation', 'sku_mutation', 'shipping_country_mismatch', 'poisoned_proposal', 'revoked_intent', 'malformed_ai_output'];

export default function () {
  const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const res = http.post(`${__ENV.BASE_URL}/api/simulation/runs`, JSON.stringify({ scenario, think_ms: 150 }), {
    headers: { 'Content-Type': 'application/json', 'X-Test-Run': 'k6' },
  });
  const ok = check(res, { 'simulation accepted (202)': (r) => r.status === 202 });
  if (ok) accepted.add(1);
  sleep(Math.random() * 2 + 1);
}
