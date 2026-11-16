import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { JWTVerifyGetKey } from 'jose';
import {
  ProblemError,
  WEB_SECURITY_HEADERS,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerAppShell,
  type AppShell,
  registerProblemHandlers,
  securityTxt,
  requestIdFrom,
} from '@endo/service-kit';
import {
  OidcError,
  TRANSACTION_TTL_MS,
  RefreshRejectedError,
  authorizationUrl,
  logoutUrl,
  refreshSession,
  validateLogoutToken,
  type SeenTokenIds,
  newBinding,
  exchangeCode,
  validateIdToken,
  type OidcConfig,
  type TransactionStore,
} from './oidc.ts';
import type { EnvelopeSealer } from '@endo/crypto';
import type { Membership, Resolver } from './resolve.ts';
import {
  OIDC_COOKIE,
  REVALIDATE_AFTER_MS,
  SESSION_COOKIE,
  readCookie,
  type ClinicSession,
  type InMemoryClinicSessions,
} from './sessions.ts';
import { registerClinicEpisodeRoutes } from './episodes.ts';
import { registerClinicEnrolmentRoutes, type ClinicEnrolmentDeps } from './enrolments.ts';

/** The clinic portal's page paths (its router's routes). */
export const PORTAL_PATHS = [
  '/',
  '/enrolments',
  '/reviews',
  '/admin',
  '/join',
  '/dashboard',
] as const;

/**
 * REQ-010 staff invitation in progress: the SHA-256 of the link token, for 10 minutes, until the
 * sign-in callback claims it. Lax: Keycloak's return is a cross-site navigation.
 */
export const JOIN_COOKIE = '__Host-endo_join';

/** Invitation hashes per sign-in attempt (its `state`), for as long as an attempt lives. */
export class PendingJoins {
  readonly #m = new Map<string, { hash: string; at: number }>();
  readonly #now: () => number;
  readonly #max: number;
  #prunedAt = Number.NEGATIVE_INFINITY;
  constructor(now: () => number, max = 10_000) {
    this.#now = now;
    this.#max = max;
  }
  add(state: string, hash: string): void {
    const t = this.#now();
    // Pruned at most once a second, so a burst of sign-ins costs no more than the bound.
    if (t - this.#prunedAt >= 1000) {
      for (const [k, v] of this.#m) if (t - v.at > TRANSACTION_TTL_MS) this.#m.delete(k);
      this.#prunedAt = t;
    }
    if (this.#m.size >= this.#max) return; // bounded: an attempt without a join still signs in
    this.#m.set(state, { hash, at: t });
  }
  take(state: string): string | null {
    const v = this.#m.get(state);
    this.#m.delete(state);
    return v && this.#now() - v.at <= TRANSACTION_TTL_MS ? v.hash : null;
  }
}

/** Every route declares how it is reached (spec 2.5); the service will not start otherwise. */
export type ClinicAuth =
  | {
      readonly kind: 'public';
      readonly reason: 'liveness' | 'app-shell' | 'join' | 'security-txt';
    }
  | { readonly kind: 'oidc'; readonly step: 'start' | 'callback' }
  /** Keycloak's back-channel logout: server-to-server, authenticated by the signed logout token. */
  | { readonly kind: 'backchannel' }
  /**
   * A signed-in clinician. Unless `allowPending`, the session must have an active organisation;
   * a `pending-org` session may only see its state, choose, or sign out (ADR-0019 section 5).
   */
  | { readonly kind: 'session'; readonly allowPending?: boolean };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: ClinicAuth;
  }
  interface FastifyRequest {
    session: ClinicSession | null;
    /** The current session id, so a route can rotate it. */
    sessionToken: string | null;
  }
}

export function isClinicAuth(value: unknown): value is ClinicAuth {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ClinicAuth> & { step?: unknown; reason?: unknown };
  if (v.kind === 'public')
    return (
      v.reason === 'liveness' ||
      v.reason === 'app-shell' ||
      v.reason === 'join' ||
      v.reason === 'security-txt'
    );
  if (v.kind === 'oidc') return v.step === 'start' || v.step === 'callback';
  if (v.kind === 'backchannel') return true;
  if (v.kind !== 'session') return false;
  const allow = (v as { allowPending?: unknown }).allowPending;
  return allow === undefined || typeof allow === 'boolean';
}

export interface ClinicBffDeps {
  readonly logLevel: string;
  readonly oidc: OidcConfig;
  /** Keycloak's signing keys, from the configured JWKS URL (never from a token). */
  readonly keys: JWTVerifyGetKey;
  readonly transactions: TransactionStore;
  /** Logout-token ids already used (replay protection). */
  readonly logoutTokens: SeenTokenIds;
  readonly sessions: InMemoryClinicSessions;
  readonly resolver: Resolver;
  /** Seals the Keycloak refresh token held in each session. */
  readonly sealer: EnvelopeSealer;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** Exact origin of the portal, e.g. `https://clinic.example`; state-changing requests must match. */
  readonly portalOrigin: string;
  readonly logStream?: { write(msg: string): void };
  readonly rateLimitPerMinute?: number;
  /** The built clinic portal (apps/clinic-web), served from this origin. */
  readonly appShell?: AppShell;
  /** Clinic enrolment (ADR-0021 slice 3). Without it those routes do not exist. */
  readonly enrolment?: ClinicEnrolmentDeps;
  /** Spec 12.7: where vulnerability reports go (`mailto:` or `https:`); no route without it. */
  readonly securityContact?: { readonly contact: string; readonly policy?: string | null } | null;
}

const oidcCookie = (value: string, maxAgeSeconds: number) =>
  `${OIDC_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
const sessionCookie = (value: string) =>
  `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;

/** Binds a sealed refresh token to its Keycloak user, so it cannot be moved to another session. */
const refreshContext = (issuer: string, subject: string) =>
  ['bff-clinic', 'refresh', issuer, subject].join(':');

/** Constant-time comparison of two secrets of possibly different length. */
function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * Generic refusal: never says which check failed (ADR-0019 section 4). The binding cookie is left
 * alone, so other tabs' sign-in attempts in this browser can still complete.
 */
function refuse(): never {
  throw new ProblemError(
    401,
    'authn.sign_in_failed',
    'Sign-in did not complete. Please try again.',
  );
}

/**
 * Backend-for-frontend for the standalone clinic portal (spec 8.2, 8.4; ADR-0019). Tokens never
 * reach the browser; it holds only HttpOnly cookies.
 */
export async function buildClinicBff(deps: ClinicBffDeps): Promise<FastifyInstance> {
  const joins = new PendingJoins(() => deps.now().getTime());
  const app = Fastify({
    logger: loggerOptions('bff-clinic', deps.logLevel, deps.logStream),
    bodyLimit: 16 * 1024,
    trustProxy: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], false),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
    ajv: { customOptions: { removeAdditional: false } },
  });

  // In-flight revalidations, so concurrent requests on one session refresh only once.
  const inFlight = new Map<string, Promise<'ok' | 'ended' | 'unavailable'>>();
  const revalidate = (token: string, session: ClinicSession) => {
    const running = inFlight.get(token);
    if (running) return running;
    const work = (async (): Promise<'ok' | 'ended' | 'unavailable'> => {
      const context = refreshContext(session.issuer, session.subject);
      try {
        const current = await deps.sealer.open(session.refresh, context);
        const { refreshToken } = await refreshSession(deps.oidc, current, deps.fetch);
        await deps.sessions.recordRevalidation(
          token,
          await deps.sealer.seal(refreshToken, context),
        );
        return 'ok';
      } catch (error) {
        if (error instanceof RefreshRejectedError) {
          await deps.sessions.revoke(token);
          return 'ended';
        }
        return 'unavailable';
      } finally {
        inFlight.delete(token);
      }
    })();
    inFlight.set(token, work);
    return work;
  };

  app.decorateRequest('session', null);
  app.decorateRequest('sessionToken', null);
  // Only the back-channel logout route receives a form body (no new dependency for one field).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8 * 1024 },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  enforceRouteDeclarations(app, 'auth', isClinicAuth);
  registerProblemHandlers(app);

  app.addHook('onRequest', async (_request, reply) => {
    void reply.headers(WEB_SECURITY_HEADERS);
  });

  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 120,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    // Liveness only: the app shell is public but still rate limited.
    const auth = request.routeOptions.config.auth;
    if (auth?.kind === 'public' && auth.reason === 'liveness') return;
    await limit.call(this, request, reply);
  });

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.auth?.kind !== 'session') return;
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    // Background polling checks the session without counting as activity (ADR-0019 section 5).
    const touch = request.headers['x-endo-background'] !== '1'; // BACKGROUND_HEADER
    const session = token ? await deps.sessions.resolve(token, { touch }) : null;
    if (!session) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
    // Narrowed above: this is a session route.
    if (session.state !== 'active' && request.routeOptions.config.auth.allowPending !== true) {
      throw new ProblemError(403, 'authz.organisation_required', 'Choose an organisation first.');
    }
    // Keycloak session still alive? (ADR-0019 section 6.) Refresh at most every few minutes; one
    // refresh per session at a time, because Keycloak rotates refresh tokens and refuses reuse.
    if (deps.now().getTime() - session.validatedAt > REVALIDATE_AFTER_MS) {
      const outcome = await revalidate(token as string, session);
      if (outcome === 'ended') {
        throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      }
      if (outcome === 'unavailable') {
        throw new ProblemError(503, 'upstream.unavailable', 'Please try again shortly.');
      }
    }
    // CSRF (ADR-0019 section 8): state-changing requests need the exact portal Origin (missing or
    // `null` refused) AND this session's synchronizer token. GETs never change state.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers.origin !== deps.portalOrigin) {
        throw new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.');
      }
      const sent = request.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !sameSecret(sent, session.csrfToken)) {
        throw new ProblemError(403, 'csrf.token_invalid', 'Request refused.');
      }
    }
    request.session = session;
    request.sessionToken = token;
  });

  /**
   * REQ-010: the join page posts the invitation token from its link's fragment; only its hash is
   * kept, in a short-lived cookie, and the page then starts the ordinary staff sign-in.
   */
  app.post(
    '/v1/join',
    {
      config: { auth: { kind: 'public', reason: 'join' } },
      bodyLimit: 256,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['token'],
          properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
        },
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== deps.portalOrigin)
        throw new ProblemError(403, 'csrf.origin_mismatch', 'Request refused.');
      const { token } = request.body as { token: string };
      const hash = createHash('sha256').update(token).digest('hex');
      return reply
        .header(
          'set-cookie',
          `${JOIN_COOKIE}=${hash}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
        )
        .header('cache-control', 'no-store')
        .code(204)
        .send();
    },
  );

  app.get(
    '/.well-known/security.txt',
    { config: { auth: { kind: 'public', reason: 'security-txt' } } },
    (_request, reply) => {
      const c = deps.securityContact;
      if (!c) throw new ProblemError(404, 'not_found', 'Not found.');
      return reply
        .type('text/plain; charset=utf-8')
        .send(securityTxt({ contact: c.contact, policy: c.policy ?? null, now: deps.now() }));
    },
  );

  app.get('/healthz', { config: { auth: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));

  // Start: a new transaction bound to this browser by a cookie, then off to Keycloak.
  app.get(
    '/auth/login',
    {
      config: { auth: { kind: 'oidc', step: 'start' } },
      schema: { querystring: { type: 'object', additionalProperties: false, maxProperties: 0 } },
    },
    async (request, reply) => {
      // One binding per browser, shared by its tabs; each attempt has its own state.
      const binding = readCookie(request.headers.cookie, OIDC_COOKIE) ?? newBinding();
      const tx = deps.transactions.create(binding);
      // REQ-010: an invitation this browser brought belongs to THIS sign-in attempt only. Moved
      // from the cookie into server-side state keyed by the attempt, and the cookie is cleared.
      const join = readCookie(request.headers.cookie, JOIN_COOKIE);
      const cookies = [oidcCookie(binding, TRANSACTION_TTL_MS / 1000)];
      if (join) {
        if (/^[0-9a-f]{64}$/.test(join)) joins.add(tx.state, join);
        cookies.push(`${JOIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      }
      return reply.header('set-cookie', cookies).redirect(authorizationUrl(deps.oidc, tx), 302);
    },
  );

  // Callback: the cookie AND the state must match one live transaction, consumed once.
  app.get(
    '/auth/callback',
    {
      config: { auth: { kind: 'oidc', step: 'callback' } },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', maxLength: 2048 },
            state: { type: 'string', maxLength: 256 },
            session_state: { type: 'string', maxLength: 256 },
            iss: { type: 'string', maxLength: 512 },
            error: { type: 'string', maxLength: 256 },
            error_description: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { code?: string; state?: string; error?: string; iss?: string };
      try {
        const tx = deps.transactions.consume(
          readCookie(request.headers.cookie, OIDC_COOKIE),
          q.state ?? null,
        );
        // RFC 9207: if the provider names itself, it must be ours.
        if (q.error || !q.code || (q.iss !== undefined && q.iss !== deps.oidc.issuer)) {
          throw new OidcError();
        }
        const { idToken, refreshToken } = await exchangeCode(deps.oidc, q.code, tx, deps.fetch);
        const who = await validateIdToken(deps.oidc, idToken, tx, deps.keys, deps.now);
        const refresh = await deps.sealer.seal(
          refreshToken,
          refreshContext(who.issuer, who.subject),
        );
        const personId = await deps.resolver.person(who.issuer, who.subject);
        if (!personId) refuse();
        // REQ-010: a staff invitation this browser brought is claimed for the person who signed
        // in, before memberships are read. A link that cannot be used changes nothing.
        const join = joins.take(tx.state);
        if (join && deps.resolver.claimStaff) await deps.resolver.claimStaff(join, personId);
        const memberships = await deps.resolver.memberships(personId);
        if (memberships.length === 0) refuse();
        let token = await deps.sessions.create({
          personId,
          issuer: who.issuer,
          subject: who.subject,
          sid: who.sid,
          idToken,
          refresh,
          memberships,
        });
        // Exactly one organisation: activate it now, through the same path as an explicit
        // choice: re-read the membership, take its CURRENT role, rotate the session id.
        if (memberships.length === 1) {
          const chosen = memberships[0];
          const current = (await deps.resolver.memberships(personId)).find(
            (m) => m.orgId === chosen?.orgId,
          );
          const rotated = current ? await deps.sessions.activate(token, current) : null;
          if (!rotated) {
            await deps.sessions.revoke(token);
            refuse();
          }
          token = rotated;
        }
        // A same-origin page completes the navigation, so the Strict session cookie is sent on
        // the next request (the callback itself arrives cross-site).
        return await reply
          .header('set-cookie', sessionCookie(token))
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">' +
              '<title>Signing in</title><p><a href="/">Continue</a></p>',
          );
      } catch (error) {
        if (error instanceof ProblemError) throw error;
        return refuse();
      }
    },
  );

  /** What the portal renders: state, organisations and its CSRF token; never identity data. */
  const view = (s: ClinicSession) => ({
    state: s.state,
    organisations: s.candidates.map((m, index) => ({ index, org_id: m.orgId, role: m.role })),
    active: s.active ? { org_id: s.active.orgId, role: s.active.role } : null,
    // Delivered in this same-origin, no-store response body: never in a cookie or URL.
    csrf_token: s.csrfToken,
  });

  app.get('/v1/session', { config: { auth: { kind: 'session', allowPending: true } } }, (request) =>
    view(request.session as ClinicSession),
  );

  // The active organisation and role, for the portal header. Requires an active organisation.
  app.get('/v1/context', { config: { auth: { kind: 'session' } } }, (request) => {
    const active = (request.session as ClinicSession).active as Membership;
    return { org_id: active.orgId, role: active.role };
  });

  // Choose, or switch, the organisation (ADR-0019 section 5). The browser sends only an index into
  // the server-side candidate list; the membership is re-read and its CURRENT role used; the
  // session id and CSRF token rotate, so tabs holding the old id stop working.
  app.post(
    '/v1/session/organisation',
    {
      config: { auth: { kind: 'session', allowPending: true } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['index'],
          properties: { index: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const session = request.session as ClinicSession;
      const oldToken = request.sessionToken as string;
      const { index } = request.body as { index: number };
      const candidate = session.candidates.at(index);
      if (!candidate) throw new ProblemError(400, 'request.invalid', 'Unknown organisation.');
      const current = (await deps.resolver.memberships(session.personId)).find(
        (m) => m.orgId === candidate.orgId,
      );
      if (!current) {
        throw new ProblemError(
          403,
          'authz.membership_inactive',
          'That organisation is not available.',
        );
      }
      const touch = request.headers['x-endo-background'] !== '1';
      const next = await deps.sessions.activate(oldToken, current, { touch });
      if (!next) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      const rotated = await deps.sessions.resolve(next, { touch });
      if (!rotated) throw new ProblemError(401, 'authn.session_required', 'Sign in to continue.');
      return reply.header('set-cookie', sessionCookie(next)).send(view(rotated));
    },
  );

  // Sign out (ADR-0019 section 6): CSRF-protected POST. Revoke locally FIRST, clear the cookie,
  // then send the browser to Keycloak to end its session too.
  app.post(
    '/auth/logout',
    { config: { auth: { kind: 'session', allowPending: true } } },
    async (request, reply) => {
      const session = request.session as ClinicSession;
      await deps.sessions.revoke(request.sessionToken as string);
      return reply
        .header(
          'set-cookie',
          `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
        )
        .send({ logout_url: logoutUrl(deps.oidc, session.idToken) });
    },
  );

  // Keycloak tells us a session ended: revoke every matching portal session. Idempotent.
  app.post(
    '/auth/backchannel-logout',
    {
      config: { auth: { kind: 'backchannel' } },
      schema: {
        // Unknown parameters must be ignored, not refused (Back-Channel Logout 1.0, section 2.5).
        body: {
          type: 'object',
          required: ['logout_token'],
          properties: { logout_token: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (request, reply) => {
      const { logout_token } = request.body as { logout_token: string };
      let match: { sid?: string; sub?: string };
      try {
        match = await validateLogoutToken(
          deps.oidc,
          logout_token,
          deps.keys,
          deps.logoutTokens,
          deps.now,
        );
      } catch {
        throw new ProblemError(400, 'authn.logout_token_invalid', 'Invalid logout token.');
      }
      await deps.sessions.revokeMatching(deps.oidc.issuer, match);
      return reply.code(200).send();
    },
  );

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'request.completed',
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  if (deps.enrolment) registerClinicEnrolmentRoutes(app, deps.enrolment);
  // REQ-002: drafting treatment episodes (same API and signer as enrolment).
  if (deps.enrolment) registerClinicEpisodeRoutes(app, deps.enrolment);
  if (deps.appShell)
    registerAppShell(app, deps.appShell, {
      paths: PORTAL_PATHS,
      config: { auth: { kind: 'public', reason: 'app-shell' } },
    });

  await app.ready();
  return app;
}
