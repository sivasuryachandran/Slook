// REPLAY / simulated adapter. Mimics PayPal's response shapes and idempotency.
// Never labelled "live": mode is REPLAY_SIMULATION and the UI says no funds moved.
import { randomBytes } from 'node:crypto';

export function createFakePayPal({ onWebhook, faults = {}, mode = 'REPLAY_SIMULATION' } = {}) {
  const orders = new Map();
  const staleCopies = new Map(); // pre-authorization snapshots served when faults.staleGet is on
  const idem = new Map(); // `${path}:${requestId}` -> response
  const id = (p) => p + randomBytes(5).toString('hex').toUpperCase();
  const res = (status, body) => ({ status, ok: status < 300, body, debugId: 'sim-' + randomBytes(4).toString('hex') });

  function once(key, fn) {
    if (key && idem.has(key)) return idem.get(key);
    const r = fn();
    if (key) idem.set(key, r);
    return r;
  }
  function emit(type, resource) {
    if (onWebhook) setTimeout(() => onWebhook({ id: 'WH-SIM-' + randomBytes(5).toString('hex'), event_type: type, resource }), 20);
  }

  return {
    mode,
    faults,
    // test hook: mutate the stored PayPal order after creation (simulates PayPal-side drift / tampering)
    tamper(orderId, fn) { const o = orders.get(orderId); if (o) fn(o); return !!o; },
    orders,
    simulateApproval(orderId) { const o = orders.get(orderId); if (o) { o.status = 'APPROVED'; staleCopies.set(orderId, JSON.parse(JSON.stringify(o))); } return !!o; },
    async createOrder(order, requestId) {
      return once('create:' + requestId, () => {
        if (faults.createFail) return res(500, { name: 'INTERNAL_SERVICE_ERROR' });
        const oid = id('SIM-ORD-');
        orders.set(oid, { id: oid, intent: order.intent, status: 'CREATED', purchase_units: JSON.parse(JSON.stringify(order.purchase_units)) });
        return res(201, { id: oid, status: 'CREATED', links: [{ rel: 'approve', href: 'about:blank#simulated' }] });
      });
    },
    async getOrder(oid) {
      const o = orders.get(oid);
      if (faults.staleGet && staleCopies.has(oid)) return res(200, JSON.parse(JSON.stringify(staleCopies.get(oid))));
      return o ? res(200, JSON.parse(JSON.stringify(o))) : res(404, { name: 'RESOURCE_NOT_FOUND' });
    },
    async authorizeOrder(oid, requestId) {
      return once('authorize:' + requestId, () => {
        const o = orders.get(oid);
        if (faults.authorizeFail) return res(422, { name: 'INSTRUMENT_DECLINED' });
        if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
        if (o.status !== 'APPROVED') return res(422, { name: 'ORDER_NOT_APPROVED' });
        const aid = id('SIM-AUTH-');
        o.status = 'COMPLETED';
        o.purchase_units[0].shipping ??= { address: { country_code: 'US', admin_area_1: 'CA', admin_area_2: 'San Jose', postal_code: '95112', address_line_1: '1 Sandbox Way' } };
        o.purchase_units[0].payments = { authorizations: [{ id: aid, status: 'CREATED', amount: o.purchase_units[0].amount }] };
        return res(201, JSON.parse(JSON.stringify(o)));
      });
    },
    async captureAuthorization(aid, requestId) {
      return once('capture:' + requestId, () => {
        if (faults.captureFail) return res(422, { name: 'CAPTURE_FAILED' });
        const o = [...orders.values()].find((x) => x.purchase_units[0].payments?.authorizations?.[0]?.id === aid);
        const a = o?.purchase_units[0].payments.authorizations[0];
        if (!a) return res(404, { name: 'RESOURCE_NOT_FOUND' });
        if (a.status !== 'CREATED') return res(422, { name: 'AUTHORIZATION_NOT_CAPTURABLE', status: a.status });
        a.status = 'CAPTURED';
        const cap = { id: id('SIM-CAP-'), status: 'COMPLETED', amount: a.amount, custom_id: o.purchase_units[0].custom_id,
          supplementary_data: { related_ids: { order_id: o.id, authorization_id: aid } } };
        emit('PAYMENT.CAPTURE.COMPLETED', cap);
        return res(201, cap);
      });
    },
    async voidAuthorization(aid, requestId) {
      return once('void:' + requestId, () => {
        if (faults.voidFail) return res(422, { name: 'VOID_FAILED' });
        const o = [...orders.values()].find((x) => x.purchase_units[0].payments?.authorizations?.[0]?.id === aid);
        const a = o?.purchase_units[0].payments.authorizations[0];
        if (!a) return res(404, { name: 'RESOURCE_NOT_FOUND' });
        if (a.status !== 'CREATED') return res(422, { name: 'AUTHORIZATION_NOT_VOIDABLE', status: a.status });
        a.status = 'VOIDED';
        emit('PAYMENT.AUTHORIZATION.VOIDED', { id: aid, status: 'VOIDED', custom_id: o.purchase_units[0].custom_id,
          supplementary_data: { related_ids: { order_id: o.id } } });
        return res(204, null);
      });
    },
    async verifyWebhook(headers, event) {
      return { verified: event.id?.startsWith('WH-SIM-'), detail: 'SIMULATED (replay adapter; not a PayPal signature check)' };
    },
  };
}
