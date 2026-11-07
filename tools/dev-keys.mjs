#!/usr/bin/env node
// Prints a fresh Ed25519 service-token key pair as shell exports for LOCAL DEVELOPMENT ONLY.
// Deployed environments load keys from the secrets manager (spec 12.5). Never commit the output.
// Usage (bash): eval "$(node tools/dev-keys.mjs)"
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = JSON.stringify(privateKey.export({ format: 'jwk' }));
const pub = JSON.stringify(publicKey.export({ format: 'jwk' }));
console.log(`export BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK='${priv}'`);
console.log(`export API_SERVICE_TOKEN_PUBLIC_KEY_JWK='${pub}'`);
