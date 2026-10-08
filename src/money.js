// Decimal-safe money: all arithmetic is on integer minor units (cents).
export function toCents(v) {
  if (typeof v === 'number') throw new Error('money must be a string, not a float');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v).trim());
  if (!m) throw new Error(`invalid money value: ${v}`);
  const c = parseInt(m[2], 10) * 100 + parseInt((m[3] || '').padEnd(2, '0') || '0', 10);
  return m[1] ? -c : c;
}
export function fromCents(c) {
  const s = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${s}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
export const eq = (a, b) => toCents(a) === toCents(b);
export const lte = (a, b) => toCents(a) <= toCents(b);
export const mul = (v, q) => fromCents(toCents(v) * q);
export const add = (...vs) => fromCents(vs.reduce((s, v) => s + toCents(v), 0));
