import { createHash, randomBytes } from 'node:crypto';
import { add, mul } from './money.js';

export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export function hashContract(contract) {
  const { contract_hash, ...rest } = contract;
  return 'sha256:' + createHash('sha256').update(canonicalize(rest)).digest('hex');
}
export const newRunId = () => 'run_' + randomBytes(6).toString('hex');
export const customIdFor = (runId, hash) => `sl:${runId}:h_${hash.replace('sha256:', '').slice(0, 6)}`;

// Freeze a validated proposal + shopper constraints into the immutable intent contract.
export function buildContract({ runId, requestText, proposal, maxTotal, catalog, policy, now = new Date(), ttlMin = 60 }) {
  const expectedTotal = add(mul(proposal.unit_amount, proposal.quantity), proposal.shipping_amount);
  const contract = {
    run_id: runId,
    request_text: requestText,
    currency: proposal.currency,
    max_total: maxTotal,
    expected_total: expectedTotal,
    items: [{
      sku: proposal.sku,
      title: proposal.title,
      variant: proposal.variant,
      quantity: proposal.quantity,
      max_unit_amount: proposal.unit_amount,
    }],
    allowed_shipping: { max_amount: proposal.shipping_amount, countries: ['US'] },
    policy: { ...policy.rules },
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
    catalog_snapshot_id: catalog.id,
    policy_snapshot_id: policy.id,
  };
  contract.contract_hash = hashContract(contract);
  return contract;
}
