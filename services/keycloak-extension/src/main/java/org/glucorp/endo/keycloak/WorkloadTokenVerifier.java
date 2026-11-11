package org.glucorp.endo.keycloak;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.keycloak.util.JsonSerialization;

/**
 * Verifies the identity service's workload tokens (ADR-0018, ADR-0021 section 13) for the
 * extension's admin endpoint: Ed25519 with the identity service's own public key, header exactly
 * {@code alg: EdDSA, typ: endo-workload+jwt}, issuer and subject {@code identity}, audience
 * {@code keycloak}, unexpired, at most 65 seconds old, and the required scope. Anything else is
 * refused; the reason is never told to the caller.
 */
public final class WorkloadTokenVerifier {
  private static final byte[] ED25519_SPKI_PREFIX = HexFormat.of().parseHex("302a300506032b6570032100");
  private static final long MAX_AGE_SECONDS = 65;
  private static final long SKEW_SECONDS = 5;

  private final PublicKey key;
  private final Clock clock;

  /** {@code x} is the raw 32-byte Ed25519 public key (the JWK {@code x} member, base64url). */
  public WorkloadTokenVerifier(String x, Clock clock) throws GeneralSecurityException {
    byte[] raw = Base64.getUrlDecoder().decode(x);
    if (raw.length != 32) throw new GeneralSecurityException("Ed25519 key must be 32 bytes");
    byte[] spki = new byte[ED25519_SPKI_PREFIX.length + 32];
    System.arraycopy(ED25519_SPKI_PREFIX, 0, spki, 0, ED25519_SPKI_PREFIX.length);
    System.arraycopy(raw, 0, spki, ED25519_SPKI_PREFIX.length, 32);
    this.key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
    this.clock = clock;
  }

  /** True only for a valid identity-service token carrying {@code scope}. */
  public boolean verify(String authorization, String scope) {
    if (authorization == null || !authorization.startsWith("Bearer ")) return false;
    String[] parts = authorization.substring(7).split("\\.", -1);
    if (parts.length != 3) return false;
    try {
      Map<?, ?> header = json(parts[0]);
      if (!"EdDSA".equals(header.get("alg")) || !"endo-workload+jwt".equals(header.get("typ")))
        return false;
      Signature v = Signature.getInstance("Ed25519");
      v.initVerify(key);
      v.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
      if (!v.verify(Base64.getUrlDecoder().decode(parts[2]))) return false;
      Map<?, ?> claims = json(parts[1]);
      long now = clock.instant().getEpochSecond();
      return "identity".equals(claims.get("iss"))
          && "identity".equals(claims.get("sub"))
          && "keycloak".equals(claims.get("aud"))
          && claims.get("iat") instanceof Number iat
          && claims.get("exp") instanceof Number exp
          && exp.longValue() > now - SKEW_SECONDS
          && iat.longValue() <= now + SKEW_SECONDS
          && now - iat.longValue() <= MAX_AGE_SECONDS
          && claims.get("jti") instanceof String
          && claims.get("scope") instanceof List<?> scopes
          && scopes.contains(scope);
    } catch (IOException | GeneralSecurityException | IllegalArgumentException e) {
      return false;
    }
  }

  private static Map<?, ?> json(String part) throws IOException {
    return JsonSerialization.readValue(Base64.getUrlDecoder().decode(part), Map.class);
  }
}
