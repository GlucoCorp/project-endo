import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
  MAX_PENDING_TRANSACTIONS,
  OidcError,
  RefreshRejectedError,
  SeenTokenIds,
  TRANSACTION_TTL_MS,
  TransactionStore,
  authorizationUrl,
  codeChallenge,
  exchangeCode,
  logoutUrl,
  refreshSession,
  validateIdToken,
  validateLogoutToken,
  type OidcConfig,
} from './oidc.ts';

const ISSUER = 'https://kc.test/realms/endo';
const CONFIG: OidcConfig = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/auth`,
  tokenEndpoint: `${ISSUER}/token`,
  clientId: 'bff-patient',
  clientSecret: 'secret',
  redirectUri: 'https://app.test/auth/callback',
  requiredAcr: '1',
  endSessionEndpoint: `${ISSUER}/logout`,
  postLogoutRedirectUri: 'https://app.test/',
};
const NOW = new Date('2026-11-11T12:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }],
  });
  const sign = (claims: Record<string, unknown>, typ?: string) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', ...(typ ? { typ } : {}) })
      .setIssuer(ISSUER)
      .setAudience('bff-patient')
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + 300)
      .sign(privateKey);
  return { jwks, sign };
}

describe('ADR-0019, ADR-0021 OIDC client', () => {
  it('builds the authorisation request with PKCE S256, fresh login, and extra parameters that cannot override', () => {
    const tx = new TransactionStore(() => NOW.getTime()).create('binding');
    const url = new URL(authorizationUrl(CONFIG, tx, { endo_handoff: 'ref', state: 'evil' }));
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe(CONFIG.authorizationEndpoint);
    expect(p.get('code_challenge')).toBe(
      createHash('sha256').update(tx.verifier).digest('base64url'),
    );
    expect(p.get('code_challenge')).toBe(codeChallenge(tx));
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe(tx.state);
    expect(p.get('prompt')).toBe('login');
    expect(p.get('endo_handoff')).toBe('ref');
  });

  it('consumes a transaction once, for its own browser, before it expires', () => {
    let t = NOW.getTime();
    const store = new TransactionStore(() => t);
    const tx = store.create('b1');
    expect(() => store.consume('b2', tx.state)).toThrow(OidcError);
    expect(() => store.consume(null, tx.state)).toThrow(OidcError);
    expect(store.consume('b1', tx.state)).toBe(tx);
    expect(() => store.consume('b1', tx.state)).toThrow(OidcError);
    const old = store.create('b1');
    t += TRANSACTION_TTL_MS + 1;
    expect(() => store.consume('b1', old.state)).toThrow(OidcError);
    expect(store.size).toBe(0);
  });

  it('RISK-D01 drops expired attempts oldest first, keeping live ones', () => {
    let t = NOW.getTime();
    const store = new TransactionStore(() => t);
    store.create('old-1');
    store.create('old-2');
    t += TRANSACTION_TTL_MS / 2;
    const live = store.create('live');
    t += TRANSACTION_TTL_MS / 2 + 1;
    // The two oldest have expired; the newer one has not.
    store.create('new');
    expect(store.size).toBe(2);
    expect(store.consume('live', live.state)).toBe(live);
  });

  it('refuses new transactions beyond the cap', () => {
    const store = new TransactionStore(() => NOW.getTime());
    for (let i = 0; i < MAX_PENDING_TRANSACTIONS; i++) store.create('b');
    expect(() => store.create('b')).toThrow(OidcError);
  });

  it('exchanges the code with client authentication and the verifier', async () => {
    const tx = new TransactionStore(() => NOW.getTime()).create('b');
    let sent: RequestInit | undefined;
    const ok = await exchangeCode(CONFIG, 'c1', tx, (_u, init) => {
      sent = init;
      return Promise.resolve(json(200, { id_token: 'i', refresh_token: 'r' }));
    });
    expect(ok).toEqual({ idToken: 'i', refreshToken: 'r' });
    const body = new URLSearchParams(sent?.body as string);
    expect(body.get('code_verifier')).toBe(tx.verifier);
    expect((sent?.headers as Record<string, string>)['authorization']).toMatch(/^Basic /);
    await expect(
      exchangeCode(CONFIG, 'c', tx, () => Promise.resolve(json(400, {}))),
    ).rejects.toThrow(OidcError);
    await expect(
      exchangeCode(CONFIG, 'c', tx, () => Promise.resolve(json(200, {}))),
    ).rejects.toThrow(OidcError);
  });

  it('refreshes, telling an ended session from an outage', async () => {
    expect(
      await refreshSession(CONFIG, 'r', () => Promise.resolve(json(200, { refresh_token: 'r2' }))),
    ).toEqual({
      refreshToken: 'r2',
    });
    await expect(refreshSession(CONFIG, 'r', () => Promise.resolve(json(400, {})))).rejects.toThrow(
      RefreshRejectedError,
    );
    await expect(refreshSession(CONFIG, 'r', () => Promise.resolve(json(503, {})))).rejects.toThrow(
      OidcError,
    );
    await expect(refreshSession(CONFIG, 'r', () => Promise.resolve(json(200, {})))).rejects.toThrow(
      OidcError,
    );
    await expect(
      refreshSession(CONFIG, 'r', () => Promise.reject(new Error('down'))),
    ).rejects.toThrow(OidcError);
  });

  it('validates the ID token: signature, nonce, acr, freshness and azp', async () => {
    const { jwks, sign } = await keys();
    const tx = new TransactionStore(() => NOW.getTime()).create('b');
    const good = { sub: 'user-1', nonce: tx.nonce, auth_time: nowS - 5, acr: '1', sid: 's1' };
    expect(await validateIdToken(CONFIG, await sign(good), tx, jwks, () => NOW)).toEqual({
      issuer: ISSUER,
      subject: 'user-1',
      sid: 's1',
    });
    for (const bad of [
      { ...good, nonce: 'other' },
      { ...good, acr: '0' },
      { ...good, auth_time: nowS - 3600 },
      { ...good, azp: 'other-client' },
      { ...good, sub: '' },
    ])
      await expect(validateIdToken(CONFIG, await sign(bad), tx, jwks, () => NOW)).rejects.toThrow(
        OidcError,
      );
    await expect(validateIdToken(CONFIG, 'not-a-jwt', tx, jwks, () => NOW)).rejects.toThrow(
      OidcError,
    );
  });

  it('validates back-channel logout tokens once', async () => {
    const { jwks, sign } = await keys();
    const seen = new SeenTokenIds(() => NOW.getTime());
    const events = { 'http://schemas.openid.net/event/backchannel-logout': {} };
    const token = await sign({ jti: 'j1', events, sid: 's1' }, 'logout+jwt');
    expect(await validateLogoutToken(CONFIG, token, jwks, seen, () => NOW)).toEqual({ sid: 's1' });
    await expect(validateLogoutToken(CONFIG, token, jwks, seen, () => NOW)).rejects.toThrow(
      OidcError,
    );
    const withNonce = await sign({ jti: 'j2', events, sub: 'u', nonce: 'n' });
    await expect(validateLogoutToken(CONFIG, withNonce, jwks, seen, () => NOW)).rejects.toThrow(
      OidcError,
    );
    const noEvent = await sign({ jti: 'j3', events: {}, sub: 'u' });
    await expect(validateLogoutToken(CONFIG, noEvent, jwks, seen, () => NOW)).rejects.toThrow(
      OidcError,
    );
    expect(
      await validateLogoutToken(
        CONFIG,
        await sign({ jti: 'j4', events, sub: 'u' }),
        jwks,
        seen,
        () => NOW,
      ),
    ).toEqual({
      sub: 'u',
    });
  });

  it('builds the logout URL with the ID token hint', () => {
    const u = new URL(logoutUrl(CONFIG, 'id-token'));
    expect(u.searchParams.get('id_token_hint')).toBe('id-token');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe(CONFIG.postLogoutRedirectUri);
  });
});
