#!/usr/bin/env node
// Spec 10.1, 10.2, 12.2, ADR-0015: security invariants of every Keycloak realm file in infra/.
// Any change that weakens sign-in (passwords, self-registration, extra flows or flow overrides,
// implicit/device/CIBA grants, missing PKCE, wildcard redirects, PII scopes, identity logging)
// fails CI here. Each rule has its own negative test at the bottom of this file.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REALM_DIR = join(ROOT, 'infra', 'modules', 'platform', 'realm');

const ALLOWED_AUTHENTICATORS = new Set([
  'auth-cookie',
  'webauthn-authenticator-passwordless',
  'deny-access-authenticator',
  // ADR-0021, ADR-0025: the enrolment extension.
  'endo-enrolment',
  'endo-quarantine-guard',
  // ADR-0026: the email code fallback, after the passkey.
  'endo-email-code',
]);
/** The one approved sub-flow: the patient sign-in alternatives (ADR-0021 section 7). */
const SIGN_IN_SUBFLOW = 'endo patient sign-in';
/** The exact patient browser flow (ADR-0021 section 7). */
const PATIENT_BROWSER = [
  { flowAlias: SIGN_IN_SUBFLOW, requirement: 'REQUIRED' },
  { authenticator: 'endo-quarantine-guard', requirement: 'REQUIRED' },
];
const PATIENT_SIGN_IN = [
  { authenticator: 'endo-enrolment', requirement: 'ALTERNATIVE' },
  { authenticator: 'auth-cookie', requirement: 'ALTERNATIVE' },
  { authenticator: 'webauthn-authenticator-passwordless', requirement: 'ALTERNATIVE' },
  { authenticator: 'endo-email-code', requirement: 'ALTERNATIVE' },
];
// Only the guarded enrolment registration (ADR-0021 section 8): no self-service passkey adding.
const ALLOWED_ENABLED_REQUIRED_ACTIONS = new Set(['endo-enrolment-passkey']);
const MUST_BE_DISABLED_REQUIRED_ACTIONS = [
  'UPDATE_PASSWORD',
  'CONFIGURE_TOTP',
  'webauthn-register-passwordless',
];
const ROLES = ['patient', 'clinician', 'org_admin', 'glucorp_support', 'glucorp_platform_admin'];
const BUILTIN_CLIENTS = ['account', 'account-console', 'admin-cli', 'security-admin-console'];
const ALLOWED_SCOPES = new Set(['basic', 'roles', 'acr']);
/** Reviewed application clients and their idle limits in seconds (spec 10.1, 10.2). */
const APP_CLIENT_IDLE_LIMIT = new Map([
  ['bff-patient', 1800],
  ['bff-clinician', 900],
]);
const DISABLED_GRANT_ATTRIBUTES = [
  'oauth2.device.authorization.grant.enabled',
  'oidc.ciba.grant.enabled',
  'client_credentials.use_refresh_token',
];

/** Returns the list of violations for one parsed realm. */
function checkRealm(realm) {
  const v = [];
  const expect = (cond, msg) => {
    if (!cond) v.push(msg);
  };

  // Realm switches.
  expect(realm.registrationAllowed === false, 'self-registration must be off (enrolment only)');
  expect(realm.resetPasswordAllowed === false, 'password reset must be off (no passwords)');
  expect(realm.rememberMe === false, 'remember-me must be off (shared phones)');
  expect(realm.sslRequired === 'external' || realm.sslRequired === 'all', 'sslRequired too weak');
  expect(realm.bruteForceProtected === true, 'brute-force protection must be on');
  expect(realm.adminEventsDetailsEnabled === false, 'admin event details may contain PII');
  expect(
    Array.isArray(realm.eventsListeners) && realm.eventsListeners.length === 0,
    'event listeners must be explicitly empty (jboss-logging writes identities to logs)',
  );
  expect(
    Array.isArray(realm.identityProviders) && realm.identityProviders.length === 0,
    'identity brokering needs a reviewed MFA and account-linking policy first (M1)',
  );

  // Sessions and tokens.
  expect(
    Number.isInteger(realm.ssoSessionIdleTimeout) && realm.ssoSessionIdleTimeout <= 1800,
    'ssoSessionIdleTimeout must be at most 30 minutes (spec 10.1)',
  );
  expect(
    Number.isInteger(realm.ssoSessionMaxLifespan) && realm.ssoSessionMaxLifespan <= 43200,
    'ssoSessionMaxLifespan must be at most 12 hours (spec 10.1)',
  );
  expect(realm.accessTokenLifespan <= 300, 'access tokens must live at most 5 minutes');
  expect(realm.revokeRefreshToken === true, 'refresh tokens must rotate');
  expect(realm.refreshTokenMaxReuse === 0, 'refresh tokens must be single-use');

  // Passkey policy.
  expect(
    realm.webAuthnPolicyPasswordlessUserVerificationRequirement === 'required',
    'passkeys must require user verification',
  );
  expect(
    realm.webAuthnPolicyPasswordlessResidentKey === 'required',
    'passkeys must be discoverable (usernameless sign-in)',
  );

  // Roles.
  const realmRoles = new Set((realm.roles?.realm ?? []).map((r) => r.name));
  for (const r of ROLES) expect(realmRoles.has(r), `realm role ${r} missing (spec 3.1)`);
  const defaultRole = (realm.roles?.realm ?? []).find((r) => r.name === realm.defaultRole?.name);
  expect(
    defaultRole !== undefined && defaultRole.composite === false,
    'the default role must be defined here as non-composite',
  );
  for (const builtin of ['offline_access', 'uma_authorization'])
    expect(realmRoles.has(builtin), `${builtin} must be defined so Keycloak does not grant it`);

  // Flows: every flow in the file uses approved steps only, and nothing outside the file is bound.
  const flows = new Map((realm.authenticationFlows ?? []).map((f) => [f.alias, f]));
  for (const f of flows.values()) {
    for (const e of f.authenticationExecutions ?? []) {
      const subflow = e.authenticatorFlow === true && e.flowAlias === SIGN_IN_SUBFLOW;
      expect(
        subflow || (e.authenticatorFlow !== true && ALLOWED_AUTHENTICATORS.has(e.authenticator)),
        `flow "${f.alias}": step "${e.authenticator ?? e.flowAlias}" is not approved`,
      );
      expect(
        e.requirement !== 'CONDITIONAL',
        `flow "${f.alias}": no CONDITIONAL steps (ADR-0021 s7)`,
      );
    }
  }
  // ADR-0021 section 7: exactly this tree, in this order, nothing else.
  const steps = (alias) =>
    (flows.get(alias)?.authenticationExecutions ?? [])
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((e) =>
        e.authenticatorFlow
          ? { flowAlias: e.flowAlias, requirement: e.requirement }
          : { authenticator: e.authenticator, requirement: e.requirement },
      );
  expect(
    JSON.stringify(steps(realm.browserFlow)) === JSON.stringify(PATIENT_BROWSER),
    'browserFlow must be exactly: patient sign-in (REQUIRED), then endo-quarantine-guard (REQUIRED)',
  );
  expect(
    JSON.stringify(steps(SIGN_IN_SUBFLOW)) === JSON.stringify(PATIENT_SIGN_IN),
    'patient sign-in must be exactly: endo-enrolment, auth-cookie, passkey, email code (all ALTERNATIVE)',
  );
  // ADR-0026: Keycloak sends email codes. Settings come from the deployment, never literals, and
  // no SMTP password lives in the realm file.
  const smtp = realm.smtpServer ?? {};
  const placeholders = new Map(Object.entries(smtp));
  for (const key of ['host', 'port', 'from', 'starttls']) {
    const value = placeholders.get(key);
    expect(
      typeof value === 'string' && /^\$\{ENDO_SMTP_[A-Z]+\}$/.test(value),
      `smtpServer.${key} must be an ENDO_SMTP_* placeholder`,
    );
  }
  expect(smtp.password === undefined, 'smtpServer must not hold a password');
  expect(
    !/endo|health|clinic|diary|treatment/i.test(smtp.fromDisplayName ?? ''),
    'smtpServer.fromDisplayName must be neutral (spec 13.2)',
  );
  expect(flows.get(SIGN_IN_SUBFLOW)?.topLevel === false, 'patient sign-in must be a sub-flow');
  const unusedFlowBindings = {
    directGrantFlow: realm.directGrantFlow,
    resetCredentialsFlow: realm.resetCredentialsFlow,
    registrationFlow: realm.registrationFlow,
    firstBrokerLoginFlow: realm.firstBrokerLoginFlow,
  };
  for (const [binding, alias] of Object.entries(unusedFlowBindings)) {
    const steps = flows.get(alias)?.authenticationExecutions ?? [];
    expect(
      steps.length === 1 &&
        steps[0].authenticator === 'deny-access-authenticator' &&
        steps[0].requirement === 'REQUIRED',
      `${binding} must be bound to a flow that only denies access`,
    );
  }

  // Required actions: listed explicitly, so Keycloak does not restore its defaults.
  const actions = realm.requiredActions ?? [];
  for (const id of MUST_BE_DISABLED_REQUIRED_ACTIONS) {
    expect(
      actions.some((a) => a.providerId === id && a.enabled === false),
      `required action ${id} must be listed and disabled`,
    );
  }
  for (const a of actions) {
    expect(a.defaultAction !== true, `required action ${a.providerId} must not be a default`);
    if (a.enabled !== false) {
      expect(
        ALLOWED_ENABLED_REQUIRED_ACTIONS.has(a.providerId),
        `required action ${a.providerId} is not approved`,
      );
    }
  }
  expect(
    actions.some((a) => a.providerId === 'endo-enrolment-passkey' && a.enabled === true),
    'the guarded enrolment passkey action (endo-enrolment-passkey) must be enabled',
  );

  // Clients.
  for (const builtin of BUILTIN_CLIENTS) {
    const c = (realm.clients ?? []).find((x) => x.clientId === builtin);
    expect(c?.enabled === false, `built-in client ${builtin} must be disabled`);
  }
  // ADR-0019 section 3: the one allowed override binds bff-clinician's browser flow to a flow that
  // demands a fresh passkey with no SSO-cookie step, so no other session can sign a clinician in.
  const clinicianOverride = new Map(
    Object.entries(
      (realm.clients ?? []).find((x) => x.clientId === 'bff-clinician')
        ?.authenticationFlowBindingOverrides ?? {},
    ),
  );
  const clinicianFlow = (realm.authenticationFlows ?? []).find(
    (f) => f.id !== undefined && f.id === clinicianOverride.get('browser'),
  );
  const clinicianSteps = (clinicianFlow?.authenticationExecutions ?? [])
    .slice()
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  expect(
    clinicianOverride.size === 1 &&
      clinicianSteps.length === 2 &&
      clinicianSteps[0].authenticator === 'webauthn-authenticator-passwordless' &&
      clinicianSteps[0].requirement === 'REQUIRED' &&
      clinicianSteps[1].authenticator === 'endo-quarantine-guard' &&
      clinicianSteps[1].requirement === 'REQUIRED',
    'bff-clinician must use a browser flow of one fresh passkey step, then the enrolment quarantine (no SSO cookie)',
  );
  // ADR-0021 section 7: every flow that can sign someone in ends with the enrolment quarantine.
  for (const f of flows.values()) {
    if (f.topLevel === false) continue;
    const ordered = (f.authenticationExecutions ?? [])
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const signsIn = ordered.some(
      (e) => e.authenticatorFlow === true || e.authenticator !== 'deny-access-authenticator',
    );
    const last = ordered.at(-1);
    expect(
      !signsIn ||
        (last?.authenticator === 'endo-quarantine-guard' && last.requirement === 'REQUIRED'),
      `flow "${f.alias}" signs people in, so it must end with endo-quarantine-guard (REQUIRED)`,
    );
  }
  for (const c of realm.clients ?? []) {
    const id = c.clientId;
    expect(
      id === 'bff-clinician' ||
        c.authenticationFlowBindingOverrides === undefined ||
        Object.keys(c.authenticationFlowBindingOverrides).length === 0,
      `${id}: per-client flow overrides are not allowed`,
    );
    if (c.enabled === false) {
      expect(
        c.standardFlowEnabled === false &&
          c.implicitFlowEnabled === false &&
          c.directAccessGrantsEnabled === false &&
          c.serviceAccountsEnabled === false,
        `${id}: disabled clients must also have every flow off`,
      );
      continue;
    }
    const idleLimit = APP_CLIENT_IDLE_LIMIT.get(id);
    expect(idleLimit !== undefined, `${id}: unreviewed enabled client`);
    expect(
      Number(c.attributes?.['client.session.idle.timeout']) > 0 &&
        Number(c.attributes?.['client.session.idle.timeout']) <= (idleLimit ?? 0),
      `${id}: client session idle timeout above the spec limit`,
    );
    expect(c.fullScopeAllowed === false, `${id}: tokens may carry only mapped roles`);
    const mapped = (realm.scopeMappings ?? []).find((m) => m.client === id)?.roles ?? [];
    expect(mapped.length > 0, `${id}: needs an explicit role scope mapping`);
    expect(
      !mapped.includes('glucorp_platform_admin'),
      `${id}: break-glass role must not reach apps`,
    );
    expect(c.publicClient === false, `${id}: must be confidential (BFF pattern, spec 8.4)`);
    expect(c.standardFlowEnabled === true, `${id}: authorisation code flow expected`);
    expect(c.implicitFlowEnabled === false, `${id}: implicit flow forbidden`);
    expect(c.directAccessGrantsEnabled === false, `${id}: password grant forbidden`);
    expect(c.serviceAccountsEnabled === false, `${id}: service account not expected`);
    const attributes = new Map(Object.entries(c.attributes ?? {}));
    if (id === 'bff-clinician') {
      // ADR-0019 section 6: Keycloak tells the BFF when a clinician session ends.
      expect(
        /^\$\{[A-Z0-9_]+\}$/.test(String(attributes.get('backchannel.logout.url'))) &&
          attributes.get('backchannel.logout.session.required') === 'true',
        `${id}: back-channel logout URL (environment placeholder) and session id are required`,
      );
    }
    for (const attr of DISABLED_GRANT_ATTRIBUTES)
      expect(attributes.get(attr) === 'false', `${id}: ${attr} must be "false"`);
    expect(c.attributes?.['pkce.code.challenge.method'] === 'S256', `${id}: PKCE S256 required`);
    expect(
      typeof c.secret === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(c.secret),
      `${id}: secret must be an environment placeholder, never a literal`,
    );
    for (const uri of [...(c.redirectUris ?? []), c.attributes?.['post.logout.redirect.uris']]) {
      expect(
        typeof uri === 'string' && !uri.includes('*') && uri !== '+',
        `${id}: redirect URIs must be exact (no wildcards)`,
      );
    }
    expect((c.webOrigins ?? []).length === 0, `${id}: no CORS origins (server-side exchange)`);
    expect(
      (c.defaultClientScopes ?? []).every((s) => ALLOWED_SCOPES.has(s)),
      `${id}: default scopes limited to ${[...ALLOWED_SCOPES].join(', ')} (no email/profile PII)`,
    );
    expect((c.optionalClientScopes ?? []).length === 0, `${id}: no optional scopes`);
    expect((c.protocolMappers ?? []).length === 0, `${id}: custom token mappers need review`);
  }
  return v;
}

// Negative tests: each weakening on its own must be caught.
const MUTATIONS = [
  ['self-registration', (r) => (r.registrationAllowed = true)],
  ['identity logging', (r) => (r.eventsListeners = ['jboss-logging'])],
  ['unreviewed broker', (r) => (r.identityProviders = [{ alias: 'hospital' }])],
  ['refresh reuse', (r) => (r.refreshTokenMaxReuse = 1)],
  [
    'no user verification',
    (r) => (r.webAuthnPolicyPasswordlessUserVerificationRequirement = 'preferred'),
  ],
  [
    'password flow added',
    (r) =>
      r.authenticationFlows.push({
        alias: 'pw',
        authenticationExecutions: [{ authenticator: 'auth-username-password-form' }],
      }),
  ],
  ['direct grant default', (r) => delete r.directGrantFlow],
  [
    'client flow override',
    (r) => (bff(r, 'bff-patient').authenticationFlowBindingOverrides = { browser: 'x' }),
  ],
  [
    'clinician override removed',
    (r) => delete bff(r, 'bff-clinician').authenticationFlowBindingOverrides,
  ],
  [
    'clinician flow reuses the SSO cookie',
    (r) =>
      r.authenticationFlows
        .find((f) => f.alias === 'endo clinician passkey')
        .authenticationExecutions.unshift({
          authenticator: 'auth-cookie',
          requirement: 'ALTERNATIVE',
        }),
  ],
  [
    'clinician back-channel logout removed',
    (r) => delete bff(r, 'bff-clinician').attributes['backchannel.logout.url'],
  ],
  ['required actions omitted', (r) => delete r.requiredActions],
  [
    'stock passkey registration enabled',
    (r) =>
      (r.requiredActions.find((a) => a.providerId === 'webauthn-register-passwordless').enabled =
        true),
  ],
  [
    'clinician flow without the quarantine',
    (r) =>
      r.authenticationFlows
        .find((f) => f.alias === 'endo clinician passkey')
        .authenticationExecutions.pop(),
  ],
  [
    'enrolment guard removed',
    (r) =>
      r.authenticationFlows
        .find((f) => f.alias === 'endo passkey browser')
        .authenticationExecutions.pop(),
  ],
  [
    'cookie before the enrolment step',
    (r) =>
      (r.authenticationFlows
        .find((f) => f.alias === 'endo patient sign-in')
        .authenticationExecutions.find((e) => e.authenticator === 'auth-cookie').priority = 1),
  ],
  [
    'email code before the passkey',
    (r) =>
      (r.authenticationFlows
        .find((f) => f.alias === 'endo patient sign-in')
        .authenticationExecutions.find((e) => e.authenticator === 'endo-email-code').priority = 25),
  ],
  [
    'email code required',
    (r) =>
      (r.authenticationFlows
        .find((f) => f.alias === 'endo patient sign-in')
        .authenticationExecutions.find((e) => e.authenticator === 'endo-email-code').requirement =
        'REQUIRED'),
  ],
  ['literal SMTP host', (r) => (r.smtpServer.host = 'smtp.example.com')],
  ['SMTP password in the realm', (r) => (r.smtpServer.password = 'x')],
  ['revealing sender name', (r) => (r.smtpServer.fromDisplayName = 'Endo clinic')],
  [
    'conditional enrolment step',
    (r) =>
      (r.authenticationFlows
        .find((f) => f.alias === 'endo patient sign-in')
        .authenticationExecutions.find((e) => e.authenticator === 'endo-enrolment').requirement =
        'CONDITIONAL'),
  ],
  ['admin-cli enabled', (r) => (r.clients.find((c) => c.clientId === 'admin-cli').enabled = true)],
  ['email scope', (r) => bff(r, 'bff-patient').defaultClientScopes.push('email')],
  ['offline scope', (r) => bff(r, 'bff-patient').optionalClientScopes.push('offline_access')],
  [
    'device grant',
    (r) => (bff(r, 'bff-patient').attributes['oauth2.device.authorization.grant.enabled'] = 'true'),
  ],
  ['ciba grant', (r) => (bff(r, 'bff-clinician').attributes['oidc.ciba.grant.enabled'] = 'true')],
  [
    'clinician idle 30 min',
    (r) => (bff(r, 'bff-clinician').attributes['client.session.idle.timeout'] = '1800'),
  ],
  ['full scope', (r) => (bff(r, 'bff-patient').fullScopeAllowed = true)],
  ['password grant', (r) => (bff(r, 'bff-patient').directAccessGrantsEnabled = true)],
  ['no PKCE', (r) => delete bff(r, 'bff-patient').attributes['pkce.code.challenge.method']],
  ['wildcard redirect', (r) => (bff(r, 'bff-patient').redirectUris = ['http://localhost:3001/*'])],
  ['literal secret', (r) => (bff(r, 'bff-patient').secret = 'hunter2')],
  [
    'unreviewed client',
    (r) => r.clients.push({ ...structuredClone(bff(r, 'bff-patient')), clientId: 'new-app' }),
  ],
];

function bff(realm, clientId) {
  return realm.clients.find((c) => c.clientId === clientId);
}

const files = (await readdir(REALM_DIR)).filter((f) => f.endsWith('.json'));
const failures = [];
if (files.length === 0) failures.push('no realm files found');
for (const f of files) {
  const realm = JSON.parse(await readFile(join(REALM_DIR, f), 'utf8'));
  for (const msg of checkRealm(realm)) failures.push(`${f}: ${msg}`);
  for (const [name, mutate] of MUTATIONS) {
    const weakened = structuredClone(realm);
    mutate(weakened);
    if (checkRealm(weakened).length === 0)
      failures.push(`${f}: negative test "${name}" was not caught; the checker is broken`);
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Keycloak realms OK (${files.length}; ${MUTATIONS.length} negative tests caught).`);
