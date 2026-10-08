// Open-world intent compiler + signed intent contract. No SKU or catalog is required to create an intent.
// History may only SUGGEST defaults; a suggestion never enters the contract unless the user confirms it.
import { randomBytes, createHash } from 'node:crypto';
import { canonicalize } from './contract.js';
import { verifySignature } from './signing.js';
import { toCents } from './money.js';

export const SCHEMA = 'slook.intent/2'; // an application-specific, AP2-inspired contract (not AP2-compliant)
const NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };
const UNITS = '(?:kg|kgs|g|lb|lbs|oz|l|ml|pack|packs|box|boxes|dozen|rolls?|pieces?|units?|bottles?|bags?)';
const STOP = new Set(['buy', 'order', 'get', 'purchase', 'find', 'me', 'a', 'an', 'the', 'some', 'for', 'of', 'please', 'under', 'below', 'within', 'max', 'maximum', 'total', 'budget', 'up', 'to', 'less', 'than', 'delivered', 'delivery', 'with', 'shipping', 'tonight', 'today', 'tomorrow', 'morning', 'evening', 'friday', 'monday', 'tuesday', 'wednesday', 'thursday', 'saturday', 'sunday', 'suitable', 'good', 'nice', 'best', 'cheap']);
const VAGUE = /\b(something|anything|stuff|things|whatever|surprise me)\b/;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const COLORS = ['black', 'navy', 'red', 'green', 'blue', 'white', 'grey', 'gray', 'brown', 'pink', 'yellow', 'chocolate', 'vanilla'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=[^s])s$/, ''));

export function parseBudget(text) {
  const m = /\$\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:usd|dollars)/i.exec(text);
  const v = m?.[1] ?? m?.[2];
  return v ? (v.includes('.') ? v.padEnd(v.indexOf('.') + 3, '0') : v + '.00') : null;
}

// Returns the draft intent plus a status: OK | NEEDS_INFORMATION | REQUIRE_APPROVAL. Never consults a catalog.
export function compileIntent(text, { history = [] } = {}) {
  const raw = String(text ?? '').trim().slice(0, 400);
  const t = raw.toLowerCase();
  const clean = (x) => x.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const questions = []; const assumptions = []; const suggestions = [];
  // Words like "yes, pay" are not purchase requests and never approve anything: payment authority only comes from a signed intent + the gate.
  if (/^\s*(yes|yeah|yep|ok|okay|sure|confirm|approve|pay|capture|void|go ahead|do it)\b(?:[\s,.!]+(?:pay|it|now|please|the|this|that|payment|order|purchase|capture|approve|confirm|yes))*[\s,.!]*$/i.test(raw)) {
    return { status: 'NEEDS_INFORMATION', questions: ['That is not a purchase request. Describe what to buy and your maximum total. Typed or spoken words cannot approve payments.'], assumptions, suggestions };
  }
  if (!raw) return { status: 'NEEDS_INFORMATION', questions: ['What would you like to buy?'], assumptions, suggestions };
  if (VAGUE.test(t)) questions.push('What specifically should I buy?');
  const maxTotal = parseBudget(raw);
  if (!maxTotal) questions.push('What is the maximum total you will pay?');

  // strip budget / deadline phrases, then split into item clauses
  let body = t.replace(/\$\s?\d+(?:\.\d{1,2})?/g, ' ').replace(/(?:under|below|within|up to|max(?:imum)?(?: of)?|less than|budget(?: of)?)\s*(?:\d+(?:\.\d{1,2})?\s*(?:usd|dollars))?/g, ' ')
    .replace(/\b(please|delivered|with shipping|all[- ]in|including shipping)\b/g, ' ');
  let deadline = null;
  const day = DAYS.find((d) => new RegExp(`\\b${d}\\b`).test(body));
  const when = /\b(tonight|today|tomorrow)\b/.exec(body)?.[1];
  const part = /\b(morning|evening|afternoon)\b/.exec(body)?.[1];
  if (day || when) deadline = [day ?? when, part].filter(Boolean).join(' ');
  body = body.replace(/\bfor\s+(?:friday|monday|tuesday|wednesday|thursday|saturday|sunday)\s*(?:morning|evening|afternoon)?\b/g, ' ').replace(/\b(tonight|today|tomorrow)\b/g, ' ');
  body = body.replace(/^\s*(?:buy|order|get|purchase|find|i (?:need|want))\s*(?:me)?\s*/, '');
  const clauses = body.split(/\s*(?:,|\band\b|&|\+)\s*/).map((c) => c.trim()).filter(Boolean);

  const items = [];
  for (const c of clauses) {
    let rest = c.replace(/^(?:a|an|the|some)\s+/, '').trim();
    let qty = null; let unit = null;
    const q = new RegExp(`^(\\d+(?:\\.\\d+)?|${Object.keys(NUMS).join('|')})\\s*(${UNITS})?\\s*(?:of\\s+)?`).exec(rest);
    if (q) { qty = NUMS[q[1]] ?? Number(q[1]); unit = q[2] ?? null; rest = rest.slice(q[0].length).trim(); }
    rest = clean(rest).replace(/^(?:a|an|the|some|suitable|good|nice)\s+/, '').replace(/\b(suitable|good|nice)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const descTokens = rest.split(' ').filter((w) => w && !STOP.has(w));
    if (!descTokens.length) continue;
    const attributes = {}; const color = descTokens.find((w) => COLORS.includes(w)); if (color) attributes.color = color;
    const size = /\b(\d+)\s?l\b/.exec(rest); if (size) attributes.size = size[1] + 'L';
    const desc = descTokens.join(' ');
    const plural = /s$/.test(descTokens[descTokens.length - 1]) && !/(ss|us)$/.test(descTokens[descTokens.length - 1]);
    if (qty == null) {
      if (plural && !unit) { questions.push(`How many ${desc}?`); }
      else qty = 1;
    }
    items.push({ description: desc, attributes, quantity: qty == null ? null : { min: qty, max: qty }, unit: unit ?? null });
  }
  if (!items.length) questions.push('What would you like to buy?');

  // history only suggests; it never silently becomes authority
  for (const it of items) {
    if (it.quantity) continue;
    const past = history.filter((h) => h.description && tokens(h.description).join(' ') === tokens(it.description).join(' ')).slice(0, 3);
    if (past.length) suggestions.push({ item: it.description, field: 'quantity', value: past[0].quantity, basis: `your previous ${past.length} order(s)`, needs_confirmation: true });
  }
  // a history suggestion turns "how many?" into a confirmation request; it is NOT applied silently
  for (const sg of suggestions) {
    const it = items.find((i) => i.description === sg.item);
    const qi = questions.indexOf(`How many ${sg.item}?`);
    if (it && qi >= 0) { questions.splice(qi, 1); it.quantity = { min: sg.value, max: sg.value }; assumptions.push(`Based on ${sg.basis}, I inferred quantity ${sg.value} for ${sg.item}. Confirm?`); }
  }
  if (questions.length) return { status: 'NEEDS_INFORMATION', questions: [...new Set(questions)], assumptions, suggestions, items: items.map((i) => ({ ...i })), max_total: maxTotal };

  const draft = {
    items, max_total: maxTotal, currency: 'USD', merchant: null, delivery: { countries: ['US'], deadline },
    allow_substitutions: /\b(or similar|substitut|any brand|equivalent)\b/.test(t), request_text: raw,
  };
  return { status: assumptions.length ? 'REQUIRE_APPROVAL' : 'OK', draft, assumptions, suggestions, questions: [] };
}

// ---- signed contract
export function buildSignedIntent({ runId, draft, principal = { type: 'PERSONAL', id: 'demo-user' }, purpose = 'AI-assisted purchase', catalog, policy, ttlMin = 60, now = new Date(), assumptionsConfirmed = [], signer }) {
  const body = {
    schema_version: SCHEMA, run_id: runId, principal, purpose, request_text: draft.request_text,
    items: draft.items.map((i) => ({ description: i.description, category: i.category ?? null, attributes: i.attributes ?? {}, quantity: i.quantity, unit: i.unit ?? null,
      ...(i.sku ? { sku: i.sku, variant: i.variant, max_unit_amount: i.max_unit_amount } : {}) })),
    currency: draft.currency, max_total: draft.max_total, merchant: draft.merchant, delivery: draft.delivery,
    allow_substitutions: !!draft.allow_substitutions, assumptions_confirmed: assumptionsConfirmed,
    policy: { ...policy.rules }, catalog_snapshot_id: catalog?.id ?? null, policy_snapshot_id: policy.id,
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + ttlMin * 60_000).toISOString(),
    nonce: randomBytes(12).toString('hex'), key_id: signer.keyId,
  };
  const canonical = canonicalize(body);
  const contract_hash = 'sha256:' + sha(canonical);
  return { ...body, contract_hash, signature: signer.sign(canonical) };
}

export function verifyIntent(contract, publicPem) {
  if (!contract?.signature) return { ok: false, reason: 'unsigned' };
  const { signature, contract_hash, ...body } = contract;
  const canonical = canonicalize(body);
  if ('sha256:' + sha(canonical) !== contract_hash) return { ok: false, reason: 'hash mismatch (contract was modified)' };
  if (!publicPem) return { ok: false, reason: 'unknown key id' };
  return verifySignature(publicPem, canonical, signature) ? { ok: true } : { ok: false, reason: 'signature invalid' };
}

export function signRevocation({ runId, contractHash, reason = 'user revoked', now = new Date(), signer }) {
  const body = { run_id: runId, contract_hash: contractHash, revoked_at: now.toISOString(), reason, key_id: signer.keyId };
  return { ...body, signature: signer.sign(canonicalize(body)) };
}
export function verifyRevocation(rev, publicPem, contractHash) {
  if (!rev) return { revoked: false };
  const { signature, ...body } = rev;
  const ok = publicPem && verifySignature(publicPem, canonicalize(body), signature) && body.contract_hash === contractHash;
  return { revoked: true, valid: !!ok, at: rev.revoked_at };
}

// Deterministic item matching: used by BOTH preflight and the final gate. Independent of the AI.
export function itemMatches(requested, title, extraText = '') {
  const hay = new Set(tokens(`${title} ${extraText}`));
  const need = tokens(requested.description);
  if (!need.length || !need.every((w) => hay.has(w))) return false;
  for (const [, v] of Object.entries(requested.attributes ?? {})) if (!tokens(String(v)).every((w) => hay.has(w))) return false;
  return true;
}
export const moneyOk = (v) => { try { toCents(v); return true; } catch { return false; } };
