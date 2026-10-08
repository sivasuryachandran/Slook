import { test, expect } from '@playwright/test';

// A mocked SpeechRecognition: start() "hears" whatever the test put in window.__heard, interim first, then final.
const MOCK = () => {
  class MockSR {
    start() { this.onstart?.(); const heard = window.__heard ?? ''; const words = heard.split(' ');
      setTimeout(() => { this.onresult?.({ results: [[{ transcript: words.slice(0, 2).join(' ') }]] }); }, 20);
      setTimeout(() => { this.onresult?.({ results: [[{ transcript: heard }]] }); this.onend?.(); }, 60); }
    stop() { this.onend?.(); }
  }
  window.SpeechRecognition = MockSR; window.__heard = '';
};

test('voice: mic button is visible and labelled as optional voice input, not an assistant', async ({ page }) => {
  await page.addInitScript(MOCK); await page.goto('/');
  const mic = page.getByRole('button', { name: 'Optional voice input' });
  await expect(mic).toBeVisible();
  await expect(page.locator('#voiceNote')).toContainText('cannot approve or pay');
});

test('voice: transcript lands in the input, is editable, and follows the normal signed-intent path', async ({ page }) => {
  await page.addInitScript(MOCK);
  const posts = []; page.on('request', (r) => { if (r.method() === 'POST') posts.push({ url: new URL(r.url()).pathname, body: r.postDataJSON?.() }); });
  await page.goto('/');
  await page.evaluate(() => { window.__heard = 'buy 12 donuts and 3 kg of grapes for friday morning under $80'; });
  await page.getByRole('button', { name: 'Optional voice input' }).click();
  await expect(page.locator('#req')).toHaveValue('buy 12 donuts and 3 kg of grapes for friday morning under $80');
  await expect(page.locator('#micBtn')).not.toHaveClass(/on/); // recognition ended
  await page.locator('#req').fill('Buy 12 donuts and 3 kg of grapes for Friday morning under $75'); // the user edits the transcript
  await page.getByRole('button', { name: 'Ask the agent' }).click();
  await expect(page.locator('#intentKv')).toContainText('12 × donuts');
  await expect(page.locator('#intentKv')).toContainText('75.00 USD'); // the EDITED text was signed, not the raw transcript
  await expect(page.locator('#intentKv')).toContainText('Ed25519');
  await expect(page.locator('#preflight')).toContainText('PREFLIGHT: PASSED');
  const runPost = posts.find((p) => p.url === '/api/runs');
  expect(Object.keys(runPost.body).sort()).toEqual(['confirm', 'request_text', 'scenario']); // identical request shape to typed input: no voice-specific field
  expect(posts.every((p) => p.url === '/api/runs')).toBe(true); // nothing else was triggered
});

test('voice: typed and spoken text compile to the identical signed intent', async ({ page, request }) => {
  await page.addInitScript(MOCK); await page.goto('/');
  const text = 'Find a suitable birthday cake under $60.';
  await page.evaluate((t) => { window.__heard = t; }, text);
  await page.getByRole('button', { name: 'Optional voice input' }).click();
  await expect(page.locator('#req')).toHaveValue(text);
  const [spoken] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/runs') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Ask the agent' }).click()]);
  const typed = await request.post('/api/runs', { data: { request_text: text, scenario: 'happy' } });
  const a = (await spoken.json()).contract, b = (await typed.json()).contract;
  expect(a.items).toEqual(b.items); expect(a.max_total).toBe(b.max_total); expect(a.delivery).toEqual(b.delivery); expect(a.signature).toBeTruthy();
});

test('voice: "yes, pay" cannot approve, capture or void anything', async ({ page, request }) => {
  await page.addInitScript(MOCK);
  const posts = []; page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
  await page.goto('/');
  await page.fill('#req', 'Buy biryani tonight under $25.'); // a draft the user is working on
  await page.evaluate(() => { window.__heard = 'yes, pay'; });
  await page.getByRole('button', { name: 'Optional voice input' }).click();
  await expect(page.locator('#micBtn')).not.toHaveClass(/on/);
  await expect(page.locator('#voiceNote')).toContainText('Voice cannot approve or pay');
  await expect(page.locator('#req')).toHaveValue('Buy biryani tonight under $25.'); // the phrase was not inserted
  await page.evaluate(() => { window.__heard = 'approve payment'; });
  await page.getByRole('button', { name: 'Optional voice input' }).click();
  await expect(page.locator('#micBtn')).not.toHaveClass(/on/);
  await expect(page.locator('#voiceNote')).toContainText('cannot approve');
  // even if the phrase is typed and submitted, the server treats it as "not a purchase request"
  await page.fill('#req', 'yes, pay'); await page.getByRole('button', { name: 'Ask the agent' }).click();
  await expect(page.locator('#err')).toContainText('not a purchase request');
  expect(posts.every((p) => p === '/api/runs')).toBe(true);
  expect(posts.some((p) => /paypal|evaluate|capture|void|revoke/.test(p))).toBe(false);
  for (const route of ['/api/capture', '/api/void', '/api/voice/approve']) expect((await request.post(route)).status()).toBe(404); // no such routes exist
});

test('voice: unsupported browser shows a clear message and typing still works', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true }); Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Optional voice input' }).click();
  await expect(page.locator('#voiceNote')).toContainText('not supported in this browser');
  await page.fill('#req', 'Buy biryani tonight under $25.');
  await page.getByRole('button', { name: 'Ask the agent' }).click();
  await expect(page.locator('#preflight')).toContainText('PREFLIGHT: PASSED');
});
