import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const { createApp } = await import('./app.js');
const app = await createApp();
const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Slook listening on :${port} (LIVE_PAYPAL=${process.env.LIVE_PAYPAL || 'false'})`));
app.attachWebSocket(server);
