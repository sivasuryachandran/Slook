import { test, expect } from '@playwright/test';

// Real-time Activity: five browsers watch the ledger while real runs complete on the server (demo-mode PayPal adapter in CI).
async function makeRun(request, text, scenario = 'happy', { revoke = false } = {}) {
  const run = await (await request.post('/api/runs', { data: { request_text: text, scenario, confirm: true } })).json();
  if (run.status !== 'READY') return run;
  const o = await (await request.post(`/api/runs/${run.run_id}/paypal/order`)).json();
  await request.post(`/api/runs/${run.run_id}/replay/approve`);
  await request.post(`/api/runs/${run.run_id}/paypal/authorize`, { data: { orderID: o.id, ...(revoke ? { defer_gate: true } : {}) } });
  if (revoke) { await request.post(`/api/runs/${run.run_id}/intent/revoke`, { data: { reason: 'e2e' } }); await request.post(`/api/runs/${run.run_id}/evaluate`); }
  return run;
}

for (let i = 1; i <= 5; i++) {
  test(`browser ${i}: Activity updates live (captured, voided, blocked) without a page reload`, async ({ page, request }) => {
    let navigations = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    await page.goto('/#/activity');
    await expect(page.locator('#liveDot')).toContainText('Live');
    await makeRun(request, `Buy biryani tonight under $${25 + i}.`);
    await makeRun(request, `Buy biryani tonight under $${35 + i}.`, 'happy', { revoke: true });
    await makeRun(request, `Find a suitable birthday cake under $${60 + i}.`, 'poisoned_proposal');
    const grid = page.locator('#actGrid');
    await expect(grid).toContainText('Captured', { timeout: 20_000 });
    await expect(grid).toContainText('Voided', { timeout: 20_000 });
    await expect(grid).toContainText('Blocked', { timeout: 20_000 });
    expect(navigations).toBe(1);
  });
}

test('purchase flow in the UI: request, signed intent, approval, verification, captured receipt', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.locator('#envBanner')).toContainText('Demo mode');
  await page.fill('#req', 'Buy biryani tonight under $25.');
  await page.getByRole('button', { name: 'Ask the agent' }).click();
  await expect(page.locator('#preflight')).toContainText('PREFLIGHT: PASSED');
  await expect(page.locator('#intentKv')).toContainText('Ed25519');
  await expect(page.locator('#proposalTable')).toContainText('Chicken biryani family tray');
  await page.getByRole('button', { name: 'Create PayPal order' }).click();
  await page.getByRole('button', { name: /Simulate buyer approval/ }).click();
  await expect(page.locator('#decision')).toContainText('Captured', { timeout: 15_000 });
  await page.getByRole('link', { name: /View receipt/ }).click();
  await expect(page.locator('#receipt')).toContainText('Captured: matched the signed intent');
  await expect(page.locator('#receipt')).toContainText('Valid');
  await expect(page.locator('#rcptGrid')).toContainText('PASS');
  await expect(page.locator('#receipt .timeline')).toContainText('Intent signed');
});

test('poisoned proposal in the UI: blocked before PayPal, no order button, receipt shows the failed checks', async ({ page }) => {
  await page.goto('/#/new');
  await page.fill('#req', 'Find a suitable birthday cake under $60.');
  await page.locator('details.adv summary').click();
  await page.selectOption('#scenario', 'poisoned_proposal');
  await page.getByRole('button', { name: 'Ask the agent' }).click();
  await expect(page.locator('#preflight')).toContainText('PREFLIGHT: BLOCKED');
  await expect(page.locator('#preflight')).toContainText('PayPal was never contacted');
  await expect(page.getByRole('button', { name: 'Create PayPal order' })).toBeHidden();
  await expect(page.locator('#decision')).toContainText('Blocked before PayPal');
  await page.getByRole('link', { name: /View receipt/ }).click();
  await expect(page.locator('#rcptGrid')).toContainText('FAIL');
  await expect(page.locator('#receipt')).toContainText('Item you never asked for');
});

test('overview shows real totals, navigation works, and the security page is honest about limits', async ({ page, request }) => {
  await makeRun(request, 'Buy biryani tonight under $27.');
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('Captured');
  await expect(page.locator('#recent')).toContainText('biryani');
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.locator('#secBody')).toContainText('Ed25519');
  await expect(page.locator('#secBody')).toContainText('Sandbox only');
  await expect(page.locator('#secBody')).toContainText('not escrow'.replace('not', 'Not'));
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.locator('#actGrid')).toContainText('biryani');
});

test('mobile layout: menu opens, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#side')).toHaveClass(/open/);
  await page.getByRole('link', { name: 'New purchase' }).first().click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
