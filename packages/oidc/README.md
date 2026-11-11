# @endo/oidc

**Purpose:** the OIDC client both BFFs use (ADR-0019; ADR-0021 section 5): authorisation code with PKCE S256, single-use transactions bound to the browser, ID-token and back-channel logout-token validation, refresh and RP-initiated logout. Configuration-driven: issuer and endpoints come from trusted config, never from a token or discovery at request time.

**Owners:** security; changes need security review.

## Public API

| Export                                                      | What it does                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TransactionStore`, `OidcTransaction`                       | Dev and test store of sign-in attempts, keyed by `state`, consumed once, bound to the browser                                            |
| `authorizationUrl(config, tx, extra?)`, `codeChallenge(tx)` | The authorisation request (fresh login, S256); `extra` adds parameters such as the enrolment handoff, never overriding the standard ones |
| `exchangeCode`, `refreshSession`                            | Token endpoint calls with client authentication                                                                                          |
| `validateIdToken`, `validateLogoutToken`, `SeenTokenIds`    | Token validation: signature, issuer, audience and `azp`, nonce, `acr`, freshness; logout tokens once only                                |
| `logoutUrl`                                                 | RP-initiated logout                                                                                                                      |
