#!/usr/bin/env node
// Prints a Kubernetes Secret manifest ("app-keys") with fresh workload and service-token key pairs
// for every application service, and the VAPID key pair (spec 12.5, ADR-0034). The keys go
// straight to the cluster and never into OpenTofu state, the repository or a file:
//
//   node tools/app-keys.mjs --namespace endo-platform | kubectl apply -f -
//
// Re-running replaces every key: restart the app deployments afterwards
// (kubectl -n endo-platform rollout restart deployment -l endo.glucorp.health/app). The output is
// refused on a terminal so private keys are not shown on screen.
import { generateKeyPairSync } from 'node:crypto';

const args = process.argv.slice(2);
const at = args.indexOf('--namespace');
const namespace = at >= 0 ? args[at + 1] : undefined;
if (!namespace || !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) {
  console.error('usage: node tools/app-keys.mjs --namespace <ns> | kubectl apply -f -');
  process.exit(2);
}
if (process.stdout.isTTY) {
  console.error('app-keys: refusing to print private keys to a terminal; pipe into kubectl apply.');
  process.exit(2);
}

// Ed25519 pairs: workload keys (one per caller) and the BFFs' service-token keys.
const ED25519 = [
  'api',
  'jobs',
  'identity',
  'bff-patient',
  'bff-patient-service',
  'bff-clinic',
  'bff-clinic-service',
  'integration',
  'keycloak',
];

const data = new Map();
for (const name of ED25519) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  data.set(`${name}.private`, JSON.stringify(privateKey.export({ format: 'jwk' })));
  data.set(`${name}.public`, JSON.stringify(publicKey.export({ format: 'jwk' })));
}
// VAPID (Web Push, RFC 8292): the API signs with the private JWK; the patient app subscribes with
// the uncompressed public point, base64url.
const vapid = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const vapidJwk = vapid.privateKey.export({ format: 'jwk' });
data.set('vapid.private', JSON.stringify(vapidJwk));
data.set(
  'vapid.public',
  Buffer.concat([
    Buffer.from([4]),
    Buffer.from(vapidJwk.x, 'base64url'),
    Buffer.from(vapidJwk.y, 'base64url'),
  ]).toString('base64url'),
);

const lines = [
  'apiVersion: v1',
  'kind: Secret',
  'type: Opaque',
  'metadata:',
  '  name: app-keys',
  `  namespace: ${namespace}`,
  '  labels:',
  '    endo.glucorp.health/keys: app',
  'data:',
];
for (const [k, v] of data) lines.push(`  ${k}: ${Buffer.from(v).toString('base64')}`);
process.stdout.write(`${lines.join('\n')}\n`);
