// AI proposal service. Proposes only; it has no handle on capture/void.
import { CATALOG, catalogBySku } from './fixtures.js';
import { toCents } from './money.js';

export const PROMPT_VERSION = 'proposal-v1';
const NUMS = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5 };

export function parseConstraints(text) {
  const t = text.toLowerCase();
  const m = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(t);
  return { maxTotal: m ? (m[1].includes('.') ? m[1].padEnd(m[1].indexOf('.') + 3, '0') : m[1] + '.00') : null };
}

// Replay "agent": deterministic reading of the request against the catalog.
export function replayProposal(text) {
  const t = text.toLowerCase();
  const variant = CATALOG.items.some((i) => t.includes(i.variant)) ? CATALOG.items.find((i) => t.includes(i.variant)).variant : 'black';
  const size = /30\s?l/.test(t) ? '30L' : '20L';
  const item = CATALOG.items.find((i) => i.variant === variant && i.title.startsWith(size)) ?? CATALOG.items[0];
  const q = /\b(\d+|one|two|three|four|five)\b\s+(?:unit|units|x\b|black|navy|travel|backpack|pack)/.exec(t);
  const quantity = q ? (NUMS[q[1]] ?? parseInt(q[1], 10)) : 1;
  return {
    sku: item.sku, title: item.title, variant: item.variant, quantity,
    unit_amount: item.unit_amount, shipping_amount: CATALOG.shipping, currency: CATALOG.currency,
    reasoning_summary: `Matched "${item.variant}" ${item.title} at ${item.unit_amount} each plus ${CATALOG.shipping} shipping.`,
    confidence: 0.9,
  };
}

const ALLOWED_KEYS = ['sku', 'title', 'variant', 'quantity', 'unit_amount', 'shipping_amount', 'currency', 'reasoning_summary', 'confidence'];

// Deterministic cross-check of the model's choice against what the shopper literally asked for.
export function checkRequestConsistency(text, p) {
  const t = text.toLowerCase();
  const errs = [];
  const asked = CATALOG.items.map((i) => i.variant).filter((v, n, a) => a.indexOf(v) === n && new RegExp(`\\b${v}\\b`).test(t));
  if (asked.length === 1 && p.variant !== asked[0]) errs.push(`requested variant "${asked[0]}" but proposal has "${p.variant}"`);
  const COLORS = ['red', 'green', 'blue', 'yellow', 'pink', 'purple', 'orange', 'white', 'grey', 'gray', 'brown', 'silver', 'gold'];
  const offCatalog = COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  if (offCatalog) errs.push(`no catalog item in color "${offCatalog}"`);
  if (!/(pack|bag)/.test(t)) errs.push('request is not for a catalog product');
  const country = /\b(canada|mexico|uk|united kingdom|germany|france|india|australia|japan|china|europe)\b/.exec(t);
  if (country) errs.push(`ship-to "${country[1]}" is outside the allowed countries (US)`);
  const size = /\b(\d+)\s?l\b/.exec(t);
  if (size && !String(p.title).toLowerCase().startsWith(size[1] + 'l')) errs.push(`requested ${size[1]}L but proposal is "${p.title}"`);
  const q = /\b(\d+|one|two|three|four|five)\b\s+(?:unit|units|x\b|black|navy|travel|backpack|pack)/.exec(t);
  const wanted = q ? (NUMS[q[1]] ?? parseInt(q[1], 10)) : 1;
  if (p.quantity !== wanted) errs.push(`requested quantity ${wanted} but proposal has ${p.quantity}`);
  return errs;
}

export function validateProposal(p) {
  const errs = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['proposal is not an object'];
  const extra = Object.keys(p).filter((k) => !ALLOWED_KEYS.includes(k));
  if (extra.length) errs.push(`unexpected fields: ${extra.join(',')}`);
  for (const k of ALLOWED_KEYS.filter((k) => k !== 'confidence')) if (p[k] === undefined || p[k] === null) errs.push(`missing field: ${k}`);
  if (errs.length) return errs;
  const item = p && catalogBySku(p.sku);
  if (!item) errs.push('sku not in catalog');
  else {
    if (p.variant !== item.variant) errs.push('variant does not match catalog sku');
    if (p.unit_amount !== item.unit_amount) errs.push('unit_amount does not match catalog');
  }
  if (!Number.isInteger(p?.quantity) || p.quantity < 1 || p.quantity > 10) errs.push('quantity invalid');
  if (p?.currency !== CATALOG.currency) errs.push('currency invalid');
  try { toCents(p.shipping_amount); toCents(p.unit_amount); } catch { errs.push('money fields must be decimal strings'); }
  if (p.shipping_amount !== CATALOG.shipping) errs.push('shipping_amount does not match catalog');
  if (typeof p?.reasoning_summary !== 'string') errs.push('reasoning_summary missing');
  return errs;
}

const SYSTEM = `You are a shopping agent. Choose ONE item from this catalog for the shopper's request. Reply with ONLY a JSON object with keys: sku,title,variant,quantity(integer),unit_amount(string like "72.00"),shipping_amount(string),currency,reasoning_summary,confidence(0-1). Do not invent items. Catalog: ${JSON.stringify(CATALOG)}`;

export async function liveProposal(text, env) {
  const nvidia = env.AI_PROVIDER === 'nvidia';
  const url = nvidia ? `${env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions` : 'https://api.anthropic.com/v1/messages';
  const temperature = Number(env.AI_TEMPERATURE ?? 0);
  const headers = nvidia
    ? { Authorization: `Bearer ${env.NVIDIA_API_KEY}`, 'content-type': 'application/json' }
    : { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  const body = nvidia
    ? { model: env.NVIDIA_MODEL, temperature, max_tokens: 600, chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }] }
    : { model: env.AI_MODEL, temperature, max_tokens: 600, system: SYSTEM, messages: [{ role: 'user', content: text }] };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS || 20_000)) });
  const j = await res.json();
  if (!res.ok) throw new Error(`model API ${res.status}`);
  const raw = nvidia ? j.choices?.[0]?.message?.content ?? '' : j.content?.map((c) => c.text ?? '').join('') ?? '';
  let parsed = null;
  try { parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? 'null'); } catch { parsed = null; }
  return { raw, proposal: parsed, model: nvidia ? env.NVIDIA_MODEL : env.AI_MODEL };
}

export async function propose(text, env, llm) {
  const base = { provider: 'replay', model: 'deterministic-replay', prompt_version: PROMPT_VERSION,
    input: { text, temperature: Number(env.AI_TEMPERATURE ?? 0), provider: env.AI_PROVIDER ?? null }, error: null };
  if (llm) { // test-only injected model; same validation path as a real model
    let raw = null;
    try {
      raw = await llm(text);
      let parsed = null;
      try { parsed = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? 'null'); } catch { parsed = null; }
      const errs = [...validateProposal(parsed), ...(parsed && typeof parsed === 'object' ? checkRequestConsistency(text, parsed) : [])];
      if (errs.length) throw new Error(errs.join('; '));
      return { ...base, provider: 'test-stub', model: 'test-stub', raw_output: raw, proposal: parsed, trace_mode: 'LIVE_AGENT_TRACE' };
    } catch (e) {
      const p = replayProposal(text);
      return { ...base, provider: 'test-stub', model: 'test-stub', raw_output: JSON.stringify(p), rejected_model_output: raw, proposal: p, trace_mode: 'REPLAY_AGENT_TRACE', error: `live agent output rejected, deterministic fallback used: ${e.message}` };
    }
  }
  const hasKey = (env.AI_PROVIDER === 'nvidia' && env.NVIDIA_API_KEY) || (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY);
  if (hasKey && env.REPLAY_MODE !== 'true') {
    let rejectedRaw = null;
    try {
      const { raw, proposal, model } = await liveProposal(text, env).catch((e) => { throw e; });
      rejectedRaw = raw;
      const errs = [...validateProposal(proposal), ...(proposal && typeof proposal === 'object' ? checkRequestConsistency(text, proposal) : [])];
      if (errs.length) throw new Error('invalid proposal: ' + errs.join('; '));
      return { ...base, provider: env.AI_PROVIDER, model, raw_output: raw, proposal, trace_mode: 'LIVE_AGENT_TRACE' };
    } catch (e) {
      const p = replayProposal(text);
      return { ...base, raw_output: JSON.stringify(p), rejected_model_output: rejectedRaw, proposal: p, trace_mode: 'REPLAY_AGENT_TRACE', error: `live agent output rejected, deterministic fallback used: ${e.message}` };
    }
  }
  const p = replayProposal(text);
  return { ...base, raw_output: JSON.stringify(p), proposal: p, trace_mode: 'REPLAY_AGENT_TRACE' };
}
