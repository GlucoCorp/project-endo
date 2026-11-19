package org.glucorp.endo.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;

/** ADR-0021 sections 10, 11 and 13: the admin endpoint's rules and token checks. */
class AdminTest {
  private static final String TX = "01900000-0000-7000-8000-0000000000f1";
  private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
  private static final Instant NOW = Instant.parse("2026-11-11T12:00:00Z");

  private static String x(KeyPair kp) {
    byte[] spki = kp.getPublic().getEncoded();
    return B64.encodeToString(Arrays.copyOfRange(spki, spki.length - 32, spki.length));
  }

  private static String token(KeyPair kp, String header, String claims) throws Exception {
    String input = B64.encodeToString(header.getBytes(StandardCharsets.UTF_8)) + "." + B64.encodeToString(claims.getBytes(StandardCharsets.UTF_8));
    Signature s = Signature.getInstance("Ed25519");
    s.initSign(kp.getPrivate());
    s.update(input.getBytes(StandardCharsets.US_ASCII));
    return "Bearer " + input + "." + B64.encodeToString(s.sign());
  }

  private static final String HEADER = "{\"alg\":\"EdDSA\",\"typ\":\"endo-workload+jwt\"}";

  private static String claims(String iss, String aud, long iat, String scope) {
    return "{\"scope\":[\"" + scope + "\"],\"iss\":\"" + iss + "\",\"sub\":\"" + iss + "\",\"aud\":\"" + aud + "\",\"iat\":" + iat + ",\"exp\":" + (iat + 60) + ",\"jti\":\"j\"}";
  }

  @Test
  void acceptsOnlyTheIdentityServiceWithTheAdminScope() throws Exception {
    KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    KeyPair other = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    WorkloadTokenVerifier v = new WorkloadTokenVerifier(x(kp), Clock.fixed(NOW, ZoneOffset.UTC));
    long now = NOW.getEpochSecond();
    String scope = EnrolmentAdminResource.SCOPE;
    assertTrue(v.verify(token(kp, HEADER, claims("identity", "keycloak", now, scope)), scope));
    assertFalse(v.verify(token(other, HEADER, claims("identity", "keycloak", now, scope)), scope));
    assertFalse(v.verify(token(kp, HEADER, claims("api", "keycloak", now, scope)), scope));
    assertFalse(v.verify(token(kp, HEADER, claims("identity", "identity", now, scope)), scope));
    assertFalse(v.verify(token(kp, HEADER, claims("identity", "keycloak", now - 300, scope)), scope));
    assertFalse(v.verify(token(kp, HEADER, claims("identity", "keycloak", now, "identity.enrolment.keycloak")), scope));
    assertFalse(v.verify(token(kp, "{\"alg\":\"none\",\"typ\":\"endo-workload+jwt\"}", claims("identity", "keycloak", now, scope)), scope));
    assertFalse(v.verify(null, scope));
    assertFalse(v.verify("Bearer a.b", scope));
  }

  @Test
  void finalisesAndDeletesOnlyTheUserQuarantinedForThisTransaction() {
    assertEquals(EnrolmentAdminResource.Outcome.DONE, EnrolmentAdminResource.decideFinalise(TX, false, TX));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideFinalise("other", false, TX));
    // A repeat after success: no quarantine, already a patient.
    assertEquals(EnrolmentAdminResource.Outcome.DONE, EnrolmentAdminResource.decideFinalise(null, true, TX));
    // Never finalises an ordinary user.
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideFinalise(null, false, TX));
    assertEquals(EnrolmentAdminResource.Outcome.DONE, EnrolmentAdminResource.decideDelete(TX, TX));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideDelete(null, TX));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideDelete("other", TX));
  }

  @Test
  void erasesOnlyPatientsAndUsersInEnrolmentNeverStaff() {
    assertEquals(EnrolmentAdminResource.Outcome.DONE, EnrolmentAdminResource.decideErase(true, null, false));
    assertEquals(EnrolmentAdminResource.Outcome.DONE, EnrolmentAdminResource.decideErase(false, TX, false));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideErase(false, null, false));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideErase(true, null, true));
    assertEquals(EnrolmentAdminResource.Outcome.REFUSED, EnrolmentAdminResource.decideErase(false, TX, true));
  }
}
