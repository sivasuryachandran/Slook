import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, add, mul, eq, lte } from '../src/money.js';
import { hashContract, buildContract, customIdFor } from '../src/contract.js';
import { runAssertions, normalizeOrder } from '../src/gate.js';
import { CATALOG, POLICY } from '../src/fixtures.js';
import { replayProposal, validateProposal } from '../src/proposal.js';

const proposal = replayProposal('Buy one black travel backpack under $90 delivered');
const contract = buildContract({ runId: 'run_t1', requestText: 'x', proposal, maxTotal: '90.00', catalog: CATALOG, policy: POLICY });
const goodOrder = () => normalizeOrder({
  id: 'O1', intent: 'AUTHORIZE', status: 'COMPLETED',
  purchase_units: [{ custom_id: customIdFor('run_t1', contract.contract_hash),
    amount: { currency_code: 'USD', value: '90.00', breakdown: { shipping: { value: '18.00' } } },
    shipping: { address: { country_code: 'US' } },
    items: [{ sku: 'PACK-BLK-20L', name: 'p', description: 'variant=black', quantity: '1', unit_amount: { value: '72.00' } }],
    payments: { authorizations: [{ id: 'A1', status: 'CREATED' }] } }],
});
const run = { authorization_id: 'A1' };
const meta = { httpStatus: 200, insideGate: true, ageMs: 5 };
const evalWith = (mut) => { const o = goodOrder(); mut?.(o); return runAssertions({ contract, order: o, run, fetchMeta: meta, proposal }); };
const failing = (r) => r.filter((a) => a.blocking && a.status === 'FAIL').map((a) => a.id);

test('money is decimal-safe', () => {
  assert.equal(toCents('0.10') + toCents('0.20'), 30);
  assert.equal(add('72.00', '18.00'), '90.00');
  assert.equal(mul('19.99', 3), '59.97');
  assert.equal(fromCents(5), '0.05');
  assert.throws(() => toCents(72.5));
  assert.ok(eq('90', '90.00') && lte('89.99', '90.00') && !lte('90.01', '90.00'));
});
test('contract hash is stable and key-order independent', () => {
  const h = hashContract(contract);
  assert.equal(h, contract.contract_hash);
  const shuffled = Object.fromEntries(Object.entries(contract).reverse());
  assert.equal(hashContract(shuffled), h);
  assert.notEqual(hashContract({ ...contract, max_total: '91.00' }), h);
});
test('replay proposal validates against catalog', () => assert.deepEqual(validateProposal(proposal), []));
test('matching order passes every blocking assertion', () => assert.deepEqual(failing(evalWith()), []));
test('wrong sku fails', () => assert.ok(failing(evalWith((o) => { o.items[0].sku = 'PACK-NVY-20L'; })).includes('items.sku')));
test('wrong variant fails', () => assert.deepEqual(failing(evalWith((o) => { o.items[0].variant = 'navy'; })), ['items.variant']));
test('wrong quantity fails', () => assert.ok(failing(evalWith((o) => { o.items[0].quantity = 2; })).includes('items.quantity')));
test('total above max fails', () => assert.ok(failing(evalWith((o) => { o.total = '108.00'; })).includes('amount.total')));
test('currency mismatch fails', () => assert.ok(failing(evalWith((o) => { o.currency = 'EUR'; })).includes('amount.currency')));
test('shipping above max fails', () => assert.ok(failing(evalWith((o) => { o.shipping = '25.00'; })).includes('shipping.amount')));
test('missing shipping fails', () => assert.ok(failing(evalWith((o) => { o.shipping = null; })).includes('shipping.amount')));
test('unit price above max fails', () => assert.ok(failing(evalWith((o) => { o.items[0].unit = '90.00'; })).includes('items.unit_amount')));
test('custom_id mismatch fails', () => assert.ok(failing(evalWith((o) => { o.customId = 'sl:run_other:h_000000'; })).includes('link.custom_id')));
test('unexpected PayPal state fails', () => {
  assert.ok(failing(evalWith((o) => { o.authorization.status = 'VOIDED'; })).includes('paypal.state'));
  assert.ok(failing(evalWith((o) => { o.authorization.id = 'OTHER'; })).includes('paypal.state'));
});
test('stale/non-gate fetch fails freshness', () => {
  const r = runAssertions({ contract, order: goodOrder(), run, fetchMeta: { httpStatus: 200, insideGate: false, ageMs: 1 }, proposal });
  assert.ok(failing(r).includes('freshness.snapshot'));
});
test('missing AI explanation never changes the decision', () => {
  const r = runAssertions({ contract, order: goodOrder(), run, fetchMeta: meta, proposal: null });
  assert.deepEqual(failing(r), []);
  assert.equal(r.find((a) => a.id === 'explanation').blocking, false);
});
