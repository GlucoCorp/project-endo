import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError, type ServiceTokenSigner } from '@endo/service-kit';
import { readCookie } from './sessions.ts';

/** A record system allowed to launch the portal (spec 16.2), with the client id it gave us. */
export interface SmartIssuer {
  readonly iss: string;
  readonly clientId: string;
  /**
   * Origins its authorize and token endpoints may be on (default: the issuer's own origin).
   * Discovery metadata naming any other host is refused (SSRF, open redirect: Codex r8).
   */
  readonly endpointOrigins?: readonly string[];
}

export interface SmartDeps {
  readonly issuers: readonly SmartIssuer[];
  readonly portalOrigin: string;
  readonly apiBaseUrl: string;
  readonly signer: ServiceTokenSigner;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Launch attempts held at once (default 10 000); a full store refuses new launches. */
  readonly maxPending?: number;
}

/** Binds a launch to the browser that started it (Lax: the record system returns cross-site). */
export const SMART_COOKIE = '__Host-endo_smart';
const TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const b64url = (b: Buffer) => b.toString('base64url');

/** Short-lived entries with a bound (launch attempts, launch contexts). */
export class Expiring<T> {
  readonly #m = new Map<string, { value: T; at: number }>();
  readonly #now: () => number;
  readonly #max: number;
  #prunedAt = Number.NEGATIVE_INFINITY;
  constructor(now: () => number, max = 10_000) {
    this.#now = now;
    this.#max = max;
  }
  add(key: string, value: T): boolean {
    const t = this.#now();
    // Pruned at most once a second, so a burst of launches costs no more than the bound.
    if (t - this.#prunedAt >= 1000) {
      for (const [k, v] of this.#m) if (t - v.at > TTL_MS) this.#m.delete(k);
      this.#prunedAt = t;
    }
    if (this.#m.size >= this.#max) return false;
    this.#m.set(key, { value, at: t });
    return true;
  }
  get(key: string): T | null {
    const v = this.#m.get(key);
    return v && this.#now() - v.at <= TTL_MS ? v.value : null;
  }
  take(key: string): T | null {
    const v = this.get(key);
    this.#m.delete(key);
    return v;
  }
}

interface Attempt {
  readonly binding: string;
  readonly iss: string;
  readonly clientId: string;
  readonly verifier: string;
  readonly tokenEndpoint: string;
}

/**
 * SMART App Launch 2.x, EHR launch with PKCE (spec 16.2). The BFF completes the OAuth flow
 * server-side: the record system's tokens never reach the browser and are not kept. From the
 * launch it learns only the patient in context, keeps SHA-256(issuer | patient id) behind a
 * 10-minute opaque handle, and opens the desk. There the signed-in clinician (their own passkey
 * session) sees the linked patient, or links this record to one of their patients once.
 * Only allowlisted issuers are contacted (SSRF, spec 12.3).
 */
export function registerSmartRoutes(app: FastifyInstance, deps: SmartDeps): void {
  const attempts = new Expiring<Attempt>(deps.now, deps.maxPending);
  const contexts = new Expiring<{ linkHash: string; binding: string }>(deps.now);
  const redirectUri = `${deps.portalOrigin}/smart/callback`;
  const fail = (): never => {
    throw new ProblemError(400, 'smart.launch_failed', 'The launch did not complete. Try again.');
  };
  const getJson = async (url: string, init?: RequestInit) => {
    try {
      const res = await deps.fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const allowedEndpoint = (url: unknown, issuer: SmartIssuer): url is string => {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      const origins = issuer.endpointOrigins ?? [new URL(issuer.iss).origin];
      return origins.includes(u.origin) && (u.protocol === 'https:' || u.hostname === 'localhost');
    } catch {
      return false;
    }
  };
  const launch = { auth: { kind: 'public', reason: 'smart-launch' } } as const;

  app.get(
    '/smart/launch',
    {
      config: launch,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['iss', 'launch'],
          properties: {
            iss: { type: 'string', maxLength: 512 },
            launch: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { iss: string; launch: string };
      const issuer = deps.issuers.find((i) => i.iss === q.iss);
      if (!issuer) return fail();
      const conf = await getJson(
        `${issuer.iss.replace(/\/$/, '')}/.well-known/smart-configuration`,
      );
      const authorize = conf?.['authorization_endpoint'];
      const token = conf?.['token_endpoint'];
      if (!allowedEndpoint(authorize, issuer) || !allowedEndpoint(token, issuer)) return fail();
      const binding = readCookie(request.headers.cookie, SMART_COOKIE) ?? b64url(randomBytes(32));
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(32));
      if (
        !attempts.add(state, {
          binding,
          iss: issuer.iss,
          clientId: issuer.clientId,
          verifier,
          tokenEndpoint: token,
        })
      )
        return fail();
      const url = new URL(authorize);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: issuer.clientId,
        redirect_uri: redirectUri,
        launch: q.launch,
        scope: 'launch openid fhirUser patient/Patient.rs',
        state,
        aud: issuer.iss,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      }).toString();
      return reply
        .header(
          'set-cookie',
          `${SMART_COOKIE}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
        )
        .redirect(url.toString(), 302);
    },
  );

  app.get(
    '/smart/callback',
    {
      config: launch,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', maxLength: 4096 },
            state: { type: 'string', maxLength: 256 },
            error: { type: 'string', maxLength: 256 },
            error_description: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { code?: string; state?: string; error?: string };
      const a = q.state ? attempts.take(q.state) : null;
      const binding = readCookie(request.headers.cookie, SMART_COOKIE);
      if (!a || !binding || binding !== a.binding || q.error || !q.code) return fail();
      const tokens = await getJson(a.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri,
          client_id: a.clientId,
          code_verifier: a.verifier,
        }).toString(),
      });
      // The patient in context (a FHIR id); the tokens themselves are not kept.
      const patient = tokens?.['patient'];
      if (typeof patient !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(patient)) return fail();
      const handle = b64url(randomBytes(32));
      const linkHash = createHash('sha256').update(`${a.iss}|${patient}`).digest('hex');
      // Bound to the browser that completed the launch: a handle sent to someone else is useless.
      if (!contexts.add(handle, { linkHash, binding })) return fail();
      // The handle travels in the fragment: never sent to a server or kept in its logs.
      return reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/reviews#launch=${handle}">` +
            `<title>Opening</title><p><a href="/reviews#launch=${handle}">Continue</a></p>`,
        );
    },
  );

  // The desk, in the clinician's own session: which patient this launch is for, and linking.
  const asClinician = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    body: object,
  ) => {
    const session = request.session;
    const active = session?.active;
    if (!session || !active)
      throw new ProblemError(403, 'authz.organisation_required', 'Choose an organisation first.');
    const token = await deps.signer.sign(
      { sub: session.personId, role: active.role, org_id: active.orgId, patient_id: null },
      'api',
    );
    let res: Response;
    try {
      res = await deps.fetch(new URL(path, deps.apiBaseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': request.id,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new ProblemError(
        502,
        'upstream_unavailable',
        'The service is not available right now.',
      );
    }
    return { res, reply };
  };
  const contextOf = (request: FastifyRequest, handle: unknown) => {
    const c = typeof handle === 'string' ? contexts.get(handle) : null;
    // The launch must have been completed in this browser (Codex r8: no handle injection).
    const binding = readCookie(request.headers.cookie, SMART_COOKIE);
    if (!c || !binding || binding !== c.binding)
      throw new ProblemError(
        404,
        'smart.launch_expired',
        'Open the record from the record system again.',
      );
    return c;
  };
  const handleBody = {
    type: 'object',
    additionalProperties: false,
    required: ['handle'],
    properties: { handle: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
  } as const;

  app.post(
    '/v1/smart/context',
    { config: { auth: { kind: 'session' } }, bodyLimit: 256, schema: { body: handleBody } },
    async (request, reply) => {
      const c = contextOf(request, (request.body as { handle: string }).handle);
      const { res } = await asClinician(request, reply, '/v1/ehr-links/resolve', {
        link_hash: c.linkHash,
      });
      if (res.status === 404) return { linked: false };
      if (!res.ok) throw new ProblemError(403, 'authz.denied', 'You do not have access to this.');
      const b = (await res.json()) as { patient_id?: unknown };
      return typeof b.patient_id === 'string' && UUID.test(b.patient_id)
        ? { linked: true, patient_id: b.patient_id }
        : { linked: false };
    },
  );

  app.post(
    '/v1/smart/link',
    {
      config: { auth: { kind: 'session' } },
      bodyLimit: 256,
      schema: {
        body: {
          ...handleBody,
          required: ['handle', 'patient_id'],
          properties: {
            ...handleBody.properties,
            patient_id: { type: 'string', pattern: UUID.source },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { handle: string; patient_id: string };
      const c = contextOf(request, b.handle);
      const { res } = await asClinician(request, reply, `/v1/patients/${b.patient_id}/ehr-links`, {
        link_hash: c.linkHash,
      });
      if (res.status === 409)
        throw new ProblemError(409, 'ehr_link.exists', 'This record is already linked.');
      if (!res.ok) throw new ProblemError(403, 'authz.denied', 'You do not have access to this.');
      contexts.take(b.handle); // used: a launch links once
      return reply.code(201).send({ linked: true, patient_id: b.patient_id });
    },
  );
}
