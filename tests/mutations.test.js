import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { runMutations } from './harness/mutations.js';

test('all 15 adversarial mutations are detected, contained, evidenced and deterministic', { timeout: 120_000 }, async () => {
  const results = await runMutations();
  writeFileSync(new URL('../reports/mutation-results.json', import.meta.url), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  for (const r of results) {
    assert.ok(r.detected, `${r.id} ${r.name}: not detected (${JSON.stringify(r.reasonCodes)})`);
    assert.ok(r.capturePrevented, `${r.id}: capture not prevented`);
    assert.ok(r.evidenceStored, `${r.id}: evidence missing`);
    assert.ok(r.explained, `${r.id}: no explanation`);
    assert.ok(r.deterministic, `${r.id}: nondeterministic`);
    if (r.kind === 'order' || r.kind === 'fault' || r.kind === 'scenario' || r.kind === 'caller') assert.equal(r.voided, true, `${r.id}: not voided`);
  }
});
