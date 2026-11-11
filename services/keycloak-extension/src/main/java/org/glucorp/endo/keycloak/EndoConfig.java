package org.glucorp.endo.keycloak;

import java.net.URI;
import java.security.GeneralSecurityException;
import java.time.Clock;
import java.util.Map;
import org.keycloak.util.JsonSerialization;

/**
 * The extension's configuration, read once from the environment at start-up (ADR-0025). Missing
 * or invalid configuration leaves the client absent, and every handoff then fails closed.
 */
final class EndoConfig {
  /** The user attribute that quarantines a provisional user until activation (ADR-0021 s7). */
  static final String QUARANTINE = "endo_enrolment";
  /** Authentication-session note: the transaction this sign-in redeemed. */
  static final String TX_NOTE = "endo_tx";
  /** The authorisation-request parameter carrying the handoff reference. */
  static final String HANDOFF_PARAM = "client_request_param_endo_handoff";
  static final String ACTION_ID = "endo-enrolment-passkey";

  private static volatile IdentityClient client;
  private static volatile WorkloadTokenVerifier identityVerifier;

  private EndoConfig() {}

  static synchronized void init() {
    initVerifier();
    if (client != null) return;
    String url = System.getenv("ENDO_IDENTITY_BASE_URL");
    String jwk = System.getenv("ENDO_KEYCLOAK_WORKLOAD_PRIVATE_KEY_JWK");
    if (url == null || jwk == null) return;
    try {
      Map<?, ?> key = JsonSerialization.readValue(jwk, Map.class);
      if (!"OKP".equals(key.get("kty")) || !"Ed25519".equals(key.get("crv"))) return;
      if (!(key.get("d") instanceof String d)) return;
      client = new IdentityClient(URI.create(url), new WorkloadToken(d, Clock.systemUTC()));
    } catch (java.io.IOException | GeneralSecurityException | IllegalArgumentException e) {
      client = null;
    }
  }

  /** The identity service's public key, for the admin endpoint (ADR-0021 section 13). */
  private static void initVerifier() {
    if (identityVerifier != null) return;
    String jwk = System.getenv("ENDO_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK");
    if (jwk == null) return;
    try {
      Map<?, ?> key = JsonSerialization.readValue(jwk, Map.class);
      if (!"OKP".equals(key.get("kty")) || !"Ed25519".equals(key.get("crv"))) return;
      if (!(key.get("x") instanceof String x)) return;
      identityVerifier = new WorkloadTokenVerifier(x, Clock.systemUTC());
    } catch (java.io.IOException | GeneralSecurityException | IllegalArgumentException e) {
      identityVerifier = null;
    }
  }

  /** The verifier for the identity service's tokens, or null: the admin endpoint then refuses. */
  static WorkloadTokenVerifier identityVerifier() {
    return identityVerifier;
  }

  /** The configured client, or null: callers then refuse. */
  static IdentityClient client() {
    return client;
  }

  /** Tests only. */
  static void set(IdentityClient c) {
    client = c;
  }
}
