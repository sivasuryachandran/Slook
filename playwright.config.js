import { defineConfig } from '@playwright/test';
// Real-browser coverage: 5 concurrent shoppers on the Live Runs page. Uses the installed Chrome (no browser download).
export default defineConfig({
  testDir: 'tests/browser', workers: 5, fullyParallel: true, timeout: 90_000, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3555', channel: 'chrome', headless: true },
  webServer: { command: 'node src/server.js', url: 'http://127.0.0.1:3555/healthz', reuseExistingServer: false, timeout: 30_000,
    env: { PORT: '3555', LIVE_PAYPAL: 'false', REPLAY_MODE: 'true', NODE_ENV: 'test', RATE_LIMIT_PER_MIN: '5000' } },
});
