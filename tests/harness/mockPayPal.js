// Local HTTP mock that preserves PayPal response shapes and PayPal-Request-Id idempotency.
import http from 'node:http';

export async function startMockPayPal(opts = {}) {
  const orders = new Map(); const idem = new Map(); const log = [];
  const state = { failNext: {}, sigResult: 'SUCCESS', ...opts };
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
    const rid = req.headers['paypal-request-id'];
    log.push({ method: req.method, url: req.url, rid, auth: req.headers.authorization?.split(' ')[0], body });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'paypal-debug-id': 'dbg' + ++n }); res.end(obj ? JSON.stringify(obj) : ''); };
    const key = rid && `${req.method} ${req.url} ${rid}`;
    if (key && idem.has(key)) return send(...idem.get(key));
    const done = (code, obj) => { if (key && code < 300) idem.set(key, [code, obj]); send(code, obj); }; // PayPal does not replay failures
    const u = req.url;
    if (u === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3000 });
    if (u === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: state.sigResult });
    if (req.method === 'POST' && u === '/v2/checkout/orders') {
      if (state.failNext.create) { delete state.failNext.create; return done(500, { name: 'INTERNAL_SERVICE_ERROR' }); }
      const id = 'MOCKORD' + ++n;
      orders.set(id, { id, intent: body.intent, status: 'CREATED', purchase_units: body.purchase_units });
      return done(201, orders.get(id));
    }
    let m;
    if ((m = /^\/v2\/checkout\/orders\/(\w+)$/.exec(u)) && req.method === 'GET') return orders.has(m[1]) ? send(200, orders.get(m[1])) : send(404, { name: 'RESOURCE_NOT_FOUND' });
    if ((m = /^\/v2\/checkout\/orders\/(\w+)\/authorize$/.exec(u))) {
      const o = orders.get(m[1]);
      if (state.failNext.authorize) { delete state.failNext.authorize; return done(422, { name: 'INSTRUMENT_DECLINED' }); }
      if (!o || o.status !== 'APPROVED') return done(422, { name: 'ORDER_NOT_APPROVED' });
      o.status = 'COMPLETED';
      o.purchase_units[0].shipping ??= { address: { country_code: 'US' } };
      o.purchase_units[0].payments = { authorizations: [{ id: 'MOCKAUTH' + ++n, status: 'CREATED' }] };
      return done(201, o);
    }
    if ((m = /^\/v2\/payments\/authorizations\/(\w+)\/(capture|void)$/.exec(u))) {
      const act = m[2];
      const o = [...orders.values()].find((x) => x.purchase_units[0].payments?.authorizations?.[0]?.id === m[1]);
      if (state.failNext[act]) { delete state.failNext[act]; return done(503, { name: 'SERVICE_UNAVAILABLE' }); }
      if (!o) return done(404, { name: 'RESOURCE_NOT_FOUND' });
      const a = o.purchase_units[0].payments.authorizations[0];
      if (a.status !== 'CREATED') return done(422, { name: 'AUTHORIZATION_ALREADY_' + a.status });
      a.status = act === 'capture' ? 'CAPTURED' : 'VOIDED';
      return done(act === 'capture' ? 201 : 204, act === 'capture' ? { id: 'MOCKCAP' + ++n, status: 'COMPLETED' } : null);
    }
    send(404, { name: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, log, state, orders,
    approve: (id) => { orders.get(id).status = 'APPROVED'; },
    close: () => server.close(),
  };
}
