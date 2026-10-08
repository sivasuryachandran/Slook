// Real PayPal Sandbox adapter. Sandbox only: refuses any non-sandbox base URL.
const SANDBOX = 'https://api-m.sandbox.paypal.com';

export function createRealPayPal({ clientId, clientSecret, webhookId, env = 'sandbox', baseUrl }) {
  if (env !== 'sandbox') throw new Error('Slook is Sandbox-only (PAYPAL_ENV must be "sandbox")');
  // The only permitted override is a loopback mock used by contract tests.
  if (baseUrl && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) throw new Error('baseUrl override must be loopback');
  const BASE = baseUrl ?? SANDBOX;
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 30_000) return token;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status})`);
    token = body.access_token;
    tokenExp = Date.now() + body.expires_in * 1000;
    return token;
  }

  async function call(method, path, { body, requestId } = {}) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, ok: res.ok, body: parsed, debugId: res.headers.get('paypal-debug-id') };
  }

  return {
    mode: baseUrl ? 'CONTRACT_MOCK' : 'LIVE_SANDBOX',
    createOrder: (order, requestId) => call('POST', '/v2/checkout/orders', { body: order, requestId }),
    getOrder: (id) => call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`),
    authorizeOrder: (id, requestId) => call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/authorize`, { body: {}, requestId }),
    captureAuthorization: (id, requestId) => call('POST', `/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, { body: { final_capture: true }, requestId }),
    voidAuthorization: (id, requestId) => call('POST', `/v2/payments/authorizations/${encodeURIComponent(id)}/void`, { requestId }),
    async verifyWebhook(headers, event) {
      if (!webhookId) return { verified: false, detail: 'PAYPAL_WEBHOOK_ID not configured' };
      const r = await call('POST', '/v1/notifications/verify-webhook-signature', {
        body: {
          auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event,
        },
      });
      return { verified: r.ok && r.body?.verification_status === 'SUCCESS', detail: r.body?.verification_status ?? `HTTP ${r.status}` };
    },
  };
}
