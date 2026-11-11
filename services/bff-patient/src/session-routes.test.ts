import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@endo/domain';
import { ServiceTokenSigner, generateServiceKeyPair } from '@endo/service-kit';
import { buildBff } from './app.ts';
import { APP_LOCK_IDLE_MS, DevSessionStore, SESSION_COOKIE } from './sessions.ts';

async function setup() {
  let t = Date.parse('2026-11-11T12:00:00Z');
  const sessions = new DevSessionStore('test', () => t);
  const keys = await generateServiceKeyPair();
  const app = await buildBff({
    logLevel: 'silent',
    sessions,
    signer: new ServiceTokenSigner(keys.privateJwk, 'bff-patient'),
    apiBaseUrl: 'http://api.internal',
    fetch: () => Promise.reject(new Error('the API is not called while locked')),
  });
  const token = sessions.create({
    sub: uuidv7(),
    role: 'patient',
    org_id: uuidv7(),
    patient_id: uuidv7(),
  });
  const cookie = `${SESSION_COOKIE}=${token}`;
  const post = (url: string, payload: object = {}, type = 'application/json') =>
    app.inject({ method: 'POST', url, headers: { cookie, 'content-type': type }, payload });
  const state = async () =>
    (await app.inject({ url: '/v1/session', headers: { cookie } })).json<Record<string, unknown>>();
  const hello = async () => app.inject({ url: '/v1/hello', headers: { cookie } });
  return {
    app,
    sessions,
    token,
    post,
    state,
    hello,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('spec 10.1, RISK-S02 app lock for shared phones', () => {
  it('locks only when she turned it on; locked, nothing but the lock screen answers', async () => {
    const s = await setup();
    expect(await s.state()).toEqual({ signed_in: true, locked: false, app_lock: false });
    // Off: leaving the app does not lock it.
    expect((await s.post('/v1/session/lock')).statusCode).toBe(204);
    expect(await s.state()).toMatchObject({ locked: false });

    expect((await s.post('/v1/session/app-lock', { enabled: true })).json()).toEqual({
      app_lock: true,
    });
    expect((await s.post('/v1/session/lock')).statusCode).toBe(204);
    expect(await s.state()).toEqual({ signed_in: true, locked: true, app_lock: true });
    const refused = await s.hello();
    expect(refused.statusCode).toBe(401);
    expect(refused.json<{ type: string }>().type).toMatch(/authn\.locked$/);
    // Locked, she cannot simply turn the lock off: she signs in again.
    expect((await s.post('/v1/session/app-lock', { enabled: false })).statusCode).toBe(401);
    expect(await s.state()).toMatchObject({ locked: true });
  });

  it('locks itself after five minutes unused, with app lock on', async () => {
    const s = await setup();
    await s.post('/v1/session/app-lock', { enabled: true });
    s.advance(APP_LOCK_IDLE_MS - 1_000);
    expect(await s.state()).toMatchObject({ locked: false });
    s.advance(APP_LOCK_IDLE_MS + 1_000);
    expect(await s.state()).toMatchObject({ locked: true });

    // Without app lock, the same pause leaves it open.
    const off = await setup();
    off.advance(APP_LOCK_IDLE_MS + 1_000);
    expect(await off.state()).toMatchObject({ locked: false });
  });

  it('needs a JSON body to change anything, and a session at all', async () => {
    const s = await setup();
    expect((await s.post('/v1/session/lock', {}, 'text/plain')).statusCode).toBe(415);
    expect((await s.post('/v1/session/app-lock', { enabled: true }, 'text/plain')).statusCode).toBe(
      415,
    );
    expect((await s.post('/v1/session/app-lock', { enabled: 'yes' })).statusCode).toBe(400);
    expect((await s.app.inject({ url: '/v1/session' })).statusCode).toBe(401);
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/session/lock',
          headers: { 'content-type': 'application/json' },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});
