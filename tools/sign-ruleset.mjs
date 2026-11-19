#!/usr/bin/env node
// Spec 18.5: signs a clinical rule set after the clinical lead's approval.
//   node tools/sign-ruleset.mjs <ruleset.json> <private-key.jwk.json> <key-id>
// Writes <ruleset.json>.sig.json. The private key never enters the repository or CI; the matching
// public key goes into ENDO_RULESET_PUBLIC_KEYS. Refuses a rule set that is not complete.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRuleset, signRuleset } from '../packages/verdict/src/index.ts';

const [rulesetPath, keyPath, keyId] = process.argv.slice(2);
if (!rulesetPath || !keyPath || !keyId || !/^[a-z0-9-]{1,64}$/.test(keyId)) {
  console.error(
    'usage: node tools/sign-ruleset.mjs <ruleset.json> <private-key.jwk.json> <key-id>',
  );
  process.exit(2);
}
const ruleset = JSON.parse(readFileSync(rulesetPath, 'utf8'));
const check = parseRuleset(ruleset);
if (!check.ok) {
  console.error(`Refusing to sign: the rule set is incomplete (${check.missing.join(', ')}).`);
  process.exit(1);
}
const signature = signRuleset(ruleset, keyId, JSON.parse(readFileSync(keyPath, 'utf8')));
writeFileSync(`${rulesetPath}.sig.json`, `${JSON.stringify(signature, null, 2)}\n`);
console.log(`Signed ${rulesetPath} with ${keyId}.`);
