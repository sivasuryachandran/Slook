// Preflight gate: runs BEFORE any PayPal order exists. Deterministic; compares the agent proposal to the signed intent.
import { itemMatches } from './intent.js';
import { catalogBySku } from './fixtures.js';
import { eq, lte } from './money.js';
import { proposalTotal } from './agent.js';

export const PREFLIGHT_VERSION = 'preflight-v1';
const safe = (f) => { try { return f(); } catch { return false; } };

export function runPreflight({ contract, proposal, signature, revoked = false, now = new Date() }) {
  const out = [];
  const A = (id, pass, expected, actual, explanation, source = 'AGENT_PROPOSAL') =>
    out.push({ id, stage: 'PREFLIGHT', status: pass ? 'PASS' : 'FAIL', blocking: true, expected: String(expected), actual: String(actual ?? 'missing'), source, explanation });
  const items = proposal.line_items ?? [];
  A('intent.signature', signature.ok, 'valid Ed25519 signature', signature.ok ? 'valid' : signature.reason, 'The signed intent must verify before anything else is trusted', 'CONTRACT');
  A('intent.fresh', now.getTime() <= Date.parse(contract.expires_at), `before ${contract.expires_at}`, now.toISOString(), 'Intent must not be expired', 'CONTRACT');
  A('intent.revoked', !revoked, 'not revoked', revoked ? 'revoked' : 'not revoked', 'A revoked intent grants no authority', 'CONTRACT');

  const unmatched = items.filter((l) => !contract.items.some((r) => itemMatches(r, l.title, l.variant ?? '')));
  A('items.unrequested', unmatched.length === 0, 'only items the buyer asked for', unmatched.length ? unmatched.map((l) => `${l.title} (${l.unit_amount} × ${l.quantity})`).join('; ') : 'none',
    'Every proposed line item must match something the signed intent requested');
  const missing = contract.items.filter((r) => !items.some((l) => itemMatches(r, l.title, l.variant ?? '')));
  A('items.coverage', missing.length === 0, 'every requested item present', missing.length ? `missing: ${missing.map((r) => r.description).join(', ')}` : 'complete', 'Every requested item must be covered');
  const qtyBad = items.filter((l) => { const r = contract.items.find((x) => itemMatches(x, l.title, l.variant ?? '')); return r?.quantity && !(l.quantity >= r.quantity.min && l.quantity <= r.quantity.max); });
  A('items.quantity', qtyBad.length === 0, contract.items.map((r) => `${r.description}: ${r.quantity?.min}-${r.quantity?.max}`).join('; '), items.map((l) => `${l.title}: ${l.quantity}`).join('; '), 'Quantities must stay inside the signed range');
  const total = proposalTotal(proposal);
  A('amount.total', safe(() => lte(total, contract.max_total)), `<= ${contract.max_total}`, total, 'Proposed total (items + shipping) must stay within the signed maximum');
  A('amount.currency', proposal.currency === contract.currency, contract.currency, proposal.currency, 'Currency must match the signed intent');
  if (contract.merchant?.allowed?.length) A('merchant.allowed', (proposal.merchants ?? []).every((m) => contract.merchant.allowed.includes(m)), contract.merchant.allowed.join(','), (proposal.merchants ?? []).join(','), 'Merchant must be allowed by the intent');
  const badCatalog = items.filter((l) => { const c = catalogBySku(l.sku); return c && !safe(() => eq(l.unit_amount, c.unit_amount)); });
  A('catalog.price', badCatalog.length === 0, 'catalog price where a catalog SKU exists', badCatalog.length ? badCatalog.map((l) => `${l.sku}@${l.unit_amount}`).join(',') : 'ok', 'When catalog data exists, the proposed price must equal it (optional assertion)', 'CATALOG');
  const failed = out.filter((a) => a.status === 'FAIL').map((a) => a.id);
  return { decision: failed.length ? 'BLOCK' : 'PASS', reason_codes: failed, assertions: out, version: PREFLIGHT_VERSION };
}
