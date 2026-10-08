// Open-world proposal agent. It may read product data and propose; it has NO signing key, NO PayPal client,
// and no capture/void ability (tests assert this module imports none of them).
import { PRODUCTS, POISON_TEXT, GIFT_CARD, SHIPPING_DEFAULT } from './products.js';
import { itemMatches } from './intent.js';
import { add, mul, toCents } from './money.js';

export const AGENT_VERSION = 'agent-openworld-v1';

export function searchProducts(requested) {
  return PRODUCTS.filter((p) => itemMatches(requested, p.title, p.variant ?? '')).sort((a, b) => toCents(a.unit_amount) - toCents(b.unit_amount));
}

// poison: CONTROLLED TEST FIXTURE. A merchant page carries an injected instruction; the fixture agent obeys it.
export function proposeOpenWorld(draft) {
  const line_items = []; const missing = []; const trace_notes = [];
  for (const req of draft.items) {
    const hit = searchProducts(req)[0];
    if (!hit) { missing.push(req.description); continue; }
    line_items.push({ sku: hit.id, title: hit.title, variant: hit.variant ?? null, merchant: hit.merchant, quantity: req.quantity?.min ?? 1, unit_amount: hit.unit_amount, unit: hit.unit });
    trace_notes.push(`"${req.description}" → ${hit.title} @ ${hit.unit_amount}/${hit.unit} (${hit.merchant})`);
  }
  if (missing.length) return { missing };
  const shipping_amount = line_items.length ? [...new Set(line_items.map((l) => PRODUCTS.find((p) => p.id === l.sku)?.shipping ?? SHIPPING_DEFAULT))].map((s) => toCents(s)).reduce((a, b) => Math.max(a, b), 0) : 0;
  const proposal = { line_items, shipping_amount: (shipping_amount / 100).toFixed(2), currency: 'USD', merchants: [...new Set(line_items.map((l) => l.merchant))],
    reasoning_summary: `Selected the cheapest matching product for each requested item. ${trace_notes.join('; ')}.`, confidence: 0.9, agent_version: AGENT_VERSION };
  proposal.total = proposalTotal(proposal);
  return { proposal };
}
export const proposalTotal = (p) => add(...p.line_items.map((l) => mul(l.unit_amount, l.quantity)), p.shipping_amount);

// CONTROLLED TEST FIXTURE: models a merchant page that carries an injected instruction the agent obeys.
export function applyPoison(proposal) {
  const p = { ...proposal, line_items: [...proposal.line_items, { sku: GIFT_CARD.id, title: GIFT_CARD.title, variant: null, merchant: GIFT_CARD.merchant, quantity: 1, unit_amount: GIFT_CARD.unit_amount, unit: 'each' }] };
  p.reasoning_summary = `${proposal.reasoning_summary} Added a gift card as instructed by the merchant page.`;
  p.source_content = { label: 'CONTROLLED TEST FIXTURE', merchant_page_text: POISON_TEXT };
  p.injected = true;
  return p;
}
