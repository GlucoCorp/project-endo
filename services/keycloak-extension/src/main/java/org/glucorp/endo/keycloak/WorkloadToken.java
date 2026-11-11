package org.glucorp.endo.keycloak;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.EdECPrivateKeySpec;
import java.security.spec.NamedParameterSpec;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/**
 * Workload tokens from Keycloak to the identity service (ADR-0018, ADR-0025): Ed25519 JWTs with
 * {@code typ: endo-workload+jwt}, issuer and subject {@code keycloak}, audience {@code identity},
 * a 60-second lifetime, a unique {@code jti}, and only the scopes the call needs. The JDK signs
 * them; no JWT library is used.
 */
public final class WorkloadToken {
  private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
  private static final long TTL_SECONDS = 60;
  private static final String SCOPE = "^[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31})+$";

  private final PrivateKey key;
  private final Clock clock;

  /** {@code d} is the raw 32-byte Ed25519 private key (the JWK {@code d} member, base64url). */
  public WorkloadToken(String d, Clock clock) throws GeneralSecurityException {
    byte[] raw = Base64.getUrlDecoder().decode(d);
    if (raw.length != 32) throw new GeneralSecurityException("Ed25519 key must be 32 bytes");
    this.key =
        KeyFactory.getInstance("Ed25519")
            .generatePrivate(new EdECPrivateKeySpec(NamedParameterSpec.ED25519, raw));
    this.clock = clock;
  }

  public String sign(List<String> scopes) throws GeneralSecurityException {
    if (scopes.isEmpty() || scopes.size() > 16) throw new IllegalArgumentException("scopes");
    StringBuilder scope = new StringBuilder();
    for (String s : scopes) {
      if (!s.matches(SCOPE)) throw new IllegalArgumentException("scope");
      scope.append(scope.length() == 0 ? "" : ",").append('"').append(s).append('"');
    }
    long now = clock.instant().getEpochSecond();
    String header = "{\"alg\":\"EdDSA\",\"typ\":\"endo-workload+jwt\"}";
    String claims =
        "{\"scope\":["
            + scope
            + "],\"iss\":\"keycloak\",\"sub\":\"keycloak\",\"aud\":\"identity\",\"iat\":"
            + now
            + ",\"exp\":"
            + (now + TTL_SECONDS)
            + ",\"jti\":\""
            + UUID.randomUUID()
            + "\"}";
    String input = encode(header) + "." + encode(claims);
    Signature signer = Signature.getInstance("Ed25519");
    signer.initSign(key);
    signer.update(input.getBytes(StandardCharsets.US_ASCII));
    return input + "." + B64.encodeToString(signer.sign());
  }

  private static String encode(String json) {
    return B64.encodeToString(json.getBytes(StandardCharsets.UTF_8));
  }
}
