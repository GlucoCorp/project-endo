import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  API_SECURITY_HEADERS,
  ProblemError,
  enforceRouteDeclarations,
  loggerOptions,
  rateLimitedError,
  registerProblemHandlers,
  requestIdFrom,
} from '@endo/service-kit';
import { ApiUnavailableError, type ApiPort } from './api-client.ts';
import {
  AccessTokens,
  AuthError,
  SeenAssertions,
  grantScopes,
  verifyClientAssertion,
  type AccessToken,
} from './smart.ts';

/** The resource types served (spec 9.3), each read-and-search only. */
export const RESOURCE_TYPES = [
  'Patient',
  'CarePlan',
  'Goal',
  'QuestionnaireResponse',
  'Observation',
  'Consent',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Every route declares how it is reached (spec 2.5); the service will not start otherwise. */
export type IntegrationAuth =
  | { readonly kind: 'public'; readonly reason: 'liveness' | 'discovery' | 'token' }
  | { readonly kind: 'bearer'; readonly resource: ResourceType };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: IntegrationAuth;
  }
  interface FastifyRequest {
    token: AccessToken | null;
  }
}

export function isIntegrationAuth(v: unknown): v is IntegrationAuth {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as { kind?: unknown; reason?: unknown; resource?: unknown };
  if (a.kind === 'public')
    return a.reason === 'liveness' || a.reason === 'discovery' || a.reason === 'token';
  return a.kind === 'bearer' && RESOURCE_TYPES.includes(a.resource as ResourceType);
}

export interface IntegrationDeps {
  readonly logLevel: string;
  readonly logStream?: { write(msg: string): void };
  /** The public base URL record systems use, e.g. https://fhir.example.org (no trailing slash). */
  readonly baseUrl: string;
  readonly api: ApiPort;
  readonly now: () => number;
  readonly rateLimitPerMinute?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FHIR = 'application/fhir+json; charset=utf-8';

const issueCode = (status: number) =>
  status === 401
    ? 'login'
    : status === 403
      ? 'forbidden'
      : status === 404
        ? 'not-found'
        : status === 429
          ? 'throttled'
          : status >= 500
            ? 'exception'
            : 'invalid';

/**
 * The integration service (M7; spec 9.3, 16): a read-only FHIR R4 facade for record systems,
 * authenticated with SMART Backend Services. It holds no data: each read goes to the API with
 * the service's workload key, which checks the organisation, her consent and the client's kill
 * switch, and audits the read against her record.
 */
export async function buildIntegration(deps: IntegrationDeps): Promise<FastifyInstance> {
  const tokenUrl = `${deps.baseUrl}/oauth/token`;
  const seen = new SeenAssertions(deps.now);
  const tokens = new AccessTokens(deps.now);
  const app = Fastify({
    logger: loggerOptions('integration', deps.logLevel, deps.logStream),
    bodyLimit: 16 * 1024,
    trustProxy: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], false),
    logController: new LogController({ disableRequestLogging: true }),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.decorateRequest('token', null);
  enforceRouteDeclarations(app, 'auth', isIntegrationAuth);
  registerProblemHandlers(app);
  // The token request is a form (RFC 6749); parsed here without another dependency.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.addHook('onRequest', async (request, reply) => {
    void reply.headers({ ...API_SECURITY_HEADERS, 'x-request-id': request.id });
  });
  // FHIR clients read OperationOutcome, not problem details (spec 9.3).
  app.addHook('onSend', async (request, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (!request.url.startsWith('/fhir/') || !type.startsWith('application/problem+json'))
      return payload;
    const p = JSON.parse(String(payload)) as { title?: string };
    void reply.header('content-type', FHIR);
    return JSON.stringify({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: issueCode(reply.statusCode), diagnostics: p.title }],
    });
  });

  await app.register(rateLimit, { global: false });
  const limit = app.rateLimit({
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: 60_000,
    errorResponseBuilder: () => rateLimitedError(),
  });
  app.addHook('onRequest', async function (request, reply) {
    const auth = request.routeOptions.config.auth;
    if (auth?.kind === 'public' && auth.reason === 'liveness') return;
    await limit.call(this, request, reply);
  });

  // Bearer tokens: ours, unexpired, with the resource's scope, and the client still switched on
  // (the kill switch takes effect on the next request).
  app.addHook('onRequest', async (request) => {
    const auth = request.routeOptions.config.auth;
    if (auth?.kind !== 'bearer') return;
    const header = request.headers.authorization ?? '';
    const t = header.startsWith('Bearer ') ? tokens.find(header.slice(7)) : null;
    if (!t) throw new ProblemError(401, 'authn.token_invalid', 'A valid access token is needed.');
    if (!t.scopes.includes(`system/${auth.resource}.rs`))
      throw new ProblemError(403, 'authz.scope_missing', 'This client may not read that.');
    let client;
    try {
      client = await deps.api.resolveClient(t.clientId);
    } catch {
      throw new ProblemError(503, 'upstream.unavailable', 'Try again shortly.');
    }
    if (!client?.active || client.orgId !== t.orgId)
      throw new ProblemError(403, 'integration.disabled', 'This client is switched off.');
    request.token = t;
  });

  app.get('/healthz', { config: { auth: { kind: 'public', reason: 'liveness' } } }, () => ({
    status: 'ok',
  }));

  app.get(
    '/.well-known/smart-configuration',
    { config: { auth: { kind: 'public', reason: 'discovery' } } },
    () => ({
      token_endpoint: tokenUrl,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES384', 'RS384'],
      scopes_supported: RESOURCE_TYPES.map((t) => `system/${t}.rs`),
      capabilities: ['client-confidential-asymmetric', 'permission-v2'],
    }),
  );

  app.get(
    '/fhir/r4/metadata',
    { config: { auth: { kind: 'public', reason: 'discovery' } } },
    (_request, reply) =>
      reply.type(FHIR).send({
        resourceType: 'CapabilityStatement',
        status: 'active',
        date: '2026-11-16',
        kind: 'instance',
        fhirVersion: '4.0.1',
        format: ['json'],
        implementation: { description: 'Project Endo FHIR API', url: `${deps.baseUrl}/fhir/r4` },
        rest: [
          {
            mode: 'server',
            security: {
              service: [
                {
                  coding: [
                    {
                      system: 'http://terminology.hl7.org/CodeSystem/restful-security-service',
                      code: 'SMART-on-FHIR',
                    },
                  ],
                },
              ],
            },
            resource: RESOURCE_TYPES.map((type) => ({
              type,
              interaction: [
                { code: 'search-type' },
                ...(type === 'Patient' ? [{ code: 'read' }] : []),
              ],
              searchParam:
                type === 'Patient'
                  ? [{ name: '_id', type: 'token' }]
                  : [{ name: 'patient', type: 'reference' }],
            })),
          },
        ],
      }),
  );

  /** SMART Backend Services token endpoint: client_credentials with private_key_jwt. */
  app.post(
    '/oauth/token',
    {
      config: { auth: { kind: 'public', reason: 'token' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['grant_type', 'client_assertion_type', 'client_assertion', 'scope'],
          properties: {
            grant_type: { const: 'client_credentials' },
            client_assertion_type: {
              const: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            },
            client_assertion: { type: 'string', maxLength: 8192 },
            scope: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { client_assertion: string; scope: string };
      void reply.header('cache-control', 'no-store');
      // The client id is the assertion's issuer; it is verified against that client's own keys.
      let clientId = '';
      try {
        const payload = JSON.parse(
          Buffer.from(b.client_assertion.split('.')[1] ?? '', 'base64url').toString('utf8'),
        ) as { iss?: unknown };
        clientId = typeof payload.iss === 'string' ? payload.iss : '';
      } catch {
        clientId = '';
      }
      try {
        if (!/^[A-Za-z0-9_-]{22,64}$/.test(clientId)) throw new AuthError('invalid_client');
        const client = await deps.api.resolveClient(clientId);
        if (!client?.active) throw new AuthError('invalid_client');
        await verifyClientAssertion(
          b.client_assertion,
          clientId,
          client,
          tokenUrl,
          seen,
          deps.now(),
        );
        const scopes = grantScopes(b.scope, client.scopes);
        const t = tokens.issue({ clientId, orgId: client.orgId, scopes });
        return {
          access_token: t.token,
          token_type: 'bearer',
          expires_in: t.expiresIn,
          scope: scopes.join(' '),
        };
      } catch (error) {
        if (error instanceof ApiUnavailableError)
          throw new ProblemError(503, 'upstream.unavailable', 'Try again shortly.');
        const code = error instanceof AuthError ? error.code : 'invalid_client';
        request.log.warn({ event: 'token.refused' });
        return reply.code(code === 'invalid_scope' ? 400 : 401).send({ error: code });
      }
    },
  );

  const bundleFor = async (request: FastifyRequest, patientId: string) => {
    const t = request.token;
    if (!t || !UUID.test(patientId)) return null;
    try {
      return await deps.api.patient(t.orgId, patientId, t.clientId);
    } catch {
      throw new ProblemError(503, 'upstream.unavailable', 'Try again shortly.');
    }
  };
  const entriesOf = (bundle: Record<string, unknown> | null, type: ResourceType) =>
    ((bundle?.['entry'] ?? []) as { resource?: { resourceType?: string } }[]).filter(
      (e) => e.resource?.resourceType === type,
    );
  const searchset = (type: ResourceType, entries: unknown[]) => ({
    resourceType: 'Bundle',
    type: 'searchset',
    total: entries.length,
    link: [{ relation: 'self', url: `${deps.baseUrl}/fhir/r4/${type}` }],
    entry: entries,
  });

  app.get(
    '/fhir/r4/Patient/:id',
    { config: { auth: { kind: 'bearer', resource: 'Patient' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const patient = entriesOf(await bundleFor(request, id), 'Patient')[0];
      if (!patient) throw new ProblemError(404, 'fhir.not_found', 'Not found.');
      return reply.type(FHIR).send(patient.resource);
    },
  );

  for (const type of RESOURCE_TYPES)
    app.get(
      `/fhir/r4/${type}`,
      { config: { auth: { kind: 'bearer', resource: type } } },
      async (request, reply) => {
        const q = new Map(Object.entries(request.query as Record<string, unknown>));
        const param = type === 'Patient' ? '_id' : 'patient';
        // One search parameter: the patient (no open-ended listing across patients).
        const raw = q.size === 1 ? q.get(param) : undefined;
        if (typeof raw !== 'string')
          throw new ProblemError(400, 'fhir.search_unsupported', `Search by ${param} only.`);
        const patientId = raw.replace(/^Patient\//, '');
        // Observations: verdicts run in shadow mode, so none is released (ADR-0028).
        const entries =
          type === 'Observation' ? [] : entriesOf(await bundleFor(request, patientId), type);
        return reply.type(FHIR).send(searchset(type, entries));
      },
    );

  return app;
}
