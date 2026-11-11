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

  private EndoConfig() {}

  static synchronized void init() {
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

  /** The configured client, or null: callers then refuse. */
  static IdentityClient client() {
    return client;
  }

  /** Tests only. */
  static void set(IdentityClient c) {
    client = c;
  }
}
