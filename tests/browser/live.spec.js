import { test, expect } from '@playwright/test';

// Five browsers, five simultaneous shoppers. All share one server; each also sees the others' runs over WebSocket.
for (let i = 1; i <= 5; i++) {
  test(`browser shopper ${i}: live rows, block + capture, no page refresh`, async ({ page }) => {
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
    await page.goto('/live.html');
    await expect(page.locator('#badge')).toContainText('MOCK');
    await expect(page.locator('#conn')).toContainText('live (WebSocket)');
    // every browser starts its own mutations AND its own clean purchases, so it observes both outcomes on its own stream
    await page.getByRole('button', { name: /Inject price mutation/ }).click();
    await page.selectOption('#mix', 'clean'); await page.getByRole('button', { name: 'Start 5' }).click();
    const rows = page.locator('#grid .ag-center-cols-container .ag-row');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 }); // a row appears without a reload
    await expect(page.locator('#grid')).toContainText('VOIDED', { timeout: 40_000 });
    await expect(page.locator('#grid')).toContainText('CAPTURED', { timeout: 40_000 });
    await expect(page.locator('#tiles')).toContainText('Mismatches caught');
    await expect(page.locator('#stream')).toContainText('gate.blocked', { timeout: 20_000 });
    await expect(page.locator('#stream')).toContainText('payment.captured', { timeout: 20_000 });
    expect(navigations).toBe(1); // the page was never reloaded
  });
}

test('evidence trace opens from a row and shows the MOCK label, fresh fetch and failed assertion', async ({ page, context }) => {
  await page.goto('/live.html');
  await page.selectOption('#mix', 'hostile');
  await page.getByRole('button', { name: 'Start 5' }).click();
  await expect(page.locator('#grid')).toContainText('VOIDED', { timeout: 40_000 });
  const popup = context.waitForEvent('page');
  await page.locator('#grid .ag-center-cols-container .ag-row', { hasText: 'VOIDED' }).first().click();
  const ev = await popup; await ev.waitForLoadState();
  await expect(ev.locator('#evBanner')).toContainText('MOCK', { timeout: 20_000 });
  await expect(ev.locator('#decision')).toContainText('VOIDED');
  await expect(ev.locator('#freshBadge')).toContainText('Fresh fetch from PayPal');
  await expect(ev.locator('#assertGrid')).toContainText('FAIL');
});
