// Intent signing. The ONLY module that touches the private key. The AI/agent modules never import this file
// (enforced by tests/spine.test.js). Ed25519 over the canonical contract bytes.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';

export function createSigner(env = process.env) {
  let privateKey; let ephemeral = false;
  if (env.INTENT_SIGNING_KEY) privateKey = createPrivateKey({ key: Buffer.from(env.INTENT_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  else { privateKey = generateKeyPairSync('ed25519').privateKey; ephemeral = true; }
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = 'ed25519:' + createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return {
    keyId, publicPem, ephemeral,
    sign: (canonicalString) => sign(null, Buffer.from(canonicalString), privateKey).toString('base64'),
  };
}
export function verifySignature(publicPem, canonicalString, signatureB64) {
  try { return verify(null, Buffer.from(canonicalString), createPublicKey(publicPem), Buffer.from(signatureB64, 'base64')); } catch { return false; }
}
// Helper for operators: node -e "import('./src/signing.js').then(m=>console.log(m.generateKeyB64()))"
export function generateKeyB64() { return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'); }
