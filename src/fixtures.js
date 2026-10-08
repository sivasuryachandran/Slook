// Test catalog, policy and controlled-fault scenarios. Sandbox/demo data only.
export const CATALOG = {
  id: 'catalog_2026_10_08_001',
  currency: 'USD',
  items: [
    { sku: 'PACK-BLK-20L', title: '20L travel backpack', variant: 'black', unit_amount: '72.00' },
    { sku: 'PACK-NVY-20L', title: '20L travel backpack', variant: 'navy', unit_amount: '72.00' },
    { sku: 'PACK-BLK-30L', title: '30L expedition backpack', variant: 'black', unit_amount: '95.00' },
  ],
  shipping: '18.00',
};
export const POLICY = {
  id: 'policy_default_v1',
  rules: { allow_substitutions: false, require_catalog_sku: true, require_currency_match: true },
};
export const catalogBySku = (sku) => CATALOG.items.find((i) => i.sku === sku);

// Controlled faults. `order` scenarios alter only what is sent to PayPal AFTER preflight passed (the draft is
// {items:[{sku,title,variant,quantity,unit_amount}], shipping_amount, currency}). Every non-happy scenario is a
// CONTROLLED TEST FIXTURE, never an organic agent failure.
const first = (d, f) => ({ ...d, items: d.items.map((it, n) => (n === 0 ? f(it) : it)) });
export const SCENARIOS = {
  happy: { label: 'Matching order', apply: (d) => d },
  poisoned_proposal: { label: 'Path A · Poisoned proposal (gift-card injection) → blocked before PayPal', poison: true, apply: (d) => d },
  revoke_before_capture: { label: 'Path B · Authorize, then revoke intent → void', hold: true, apply: (d) => d },
  demo_mismatch: { label: 'Navy variant + $108 total (demo)', apply: (d) => first(d, (i) => ({ ...i, sku: 'PACK-NVY-20L', variant: 'navy', unit_amount: '90.00' })) },
  wrong_variant: { label: 'Wrong variant (navy)', apply: (d) => first(d, (i) => ({ ...i, sku: 'PACK-NVY-20L', variant: 'navy' })) },
  inflated_total: { label: 'Inflated unit price', apply: (d) => first(d, (i) => ({ ...i, unit_amount: '90.00' })) },
  wrong_country: { label: 'Ship-to country CA instead of US', apply: (d) => ({ ...d, ship_country: 'CA' }) },
  wrong_quantity: { label: 'Quantity 2 instead of 1', apply: (d) => first(d, (i) => ({ ...i, quantity: 2 })) },
};
