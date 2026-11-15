import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';
import { canonical } from './engine.ts';

/**
 * Rule set signatures (spec 18.5; RISK-T01). Ed25519 (Node's crypto) over a domain-separated
 * canonical form of the rule set: the bytes are `endo-ruleset-v1\n` followed by the canonical JSON
 * (sorted keys, no whitespace) of the parsed file, so formatting changes never matter and nothing
 * else can be passed off as a rule set. Services verify at startup against public keys pinned in
 * configuration, and run the exact content that was verified.
 */
export const RULESET_SIGNATURE_DOMAIN = 'endo-ruleset-v1\n';

const bytes = (ruleset: unknown) =>
  Buffer.from(RULESET_SIGNATURE_DOMAIN + canonical(ruleset), 'utf8');

export interface SignatureFile {
  readonly key_id: string;
  readonly signature: string;
}

/** Signs a parsed rule set with a private Ed25519 JWK. Used by the release tool, never by services. */
export function signRuleset(
  ruleset: unknown,
  keyId: string,
  privateJwk: JsonWebKey,
): SignatureFile {
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('rule sets are signed with Ed25519');
  return { key_id: keyId, signature: sign(null, bytes(ruleset), key).toString('base64url') };
}

export type RulesetVerification =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: 'malformed' | 'unknown_key' | 'bad_signature' };

/** Verifies a rule set (parsed JSON) against its signature file and the pinned public keys. */
export function verifyRuleset(
  ruleset: unknown,
  signatureFile: unknown,
  trusted: ReadonlyMap<string, JsonWebKey>,
): RulesetVerification {
  const f = signatureFile as Partial<SignatureFile> | null;
  if (
    typeof f?.key_id !== 'string' ||
    typeof f.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(f.signature)
  )
    return { ok: false, reason: 'malformed' };
  const signature = Buffer.from(f.signature, 'base64url');
  // Exactly 64 bytes, in canonical base64url (no stray trailing bits).
  if (signature.length !== 64 || signature.toString('base64url') !== f.signature)
    return { ok: false, reason: 'malformed' };
  const jwk = trusted.get(f.key_id);
  if (!jwk) return { ok: false, reason: 'unknown_key' };
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'unknown_key' };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'unknown_key' };
  let content: Buffer;
  try {
    content = bytes(ruleset);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  return verify(null, content, key, signature)
    ? { ok: true, keyId: f.key_id }
    : { ok: false, reason: 'bad_signature' };
}
