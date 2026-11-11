package org.glucorp.endo.keycloak;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** ADR-0021 sections 5 to 8, ADR-0025: the extension's logic outside Keycloak. */
class ExtensionTest {
  private static final String TX = "01900000-0000-7000-8000-0000000000f1";
  private static final String SUBJECT = "01900000-0000-7000-8000-0000000000e9";
  private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-11T12:00:00Z"), ZoneOffset.UTC);

  private HttpServer server;

  @AfterEach
  void stop() {
    if (server != null) server.stop(0);
  }

  private static KeyPair keys() throws GeneralSecurityException {
    return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
  }

  /** The raw 32-byte private key: the tail of its PKCS#8 encoding. */
  private static String d(KeyPair kp) {
    byte[] pkcs8 = kp.getPrivate().getEncoded();
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(Arrays.copyOfRange(pkcs8, pkcs8.length - 32, pkcs8.length));
  }

  private static String part(String jwt, int i) {
    return new String(Base64.getUrlDecoder().decode(jwt.split("\\.")[i]), StandardCharsets.UTF_8);
  }

  @Test
  void signsAWorkloadTokenTheIdentityServiceAccepts() throws Exception {
    KeyPair kp = keys();
    String jwt = new WorkloadToken(d(kp), CLOCK).sign(List.of("identity.enrolment.keycloak"));
    String[] p = jwt.split("\\.");
    assertEquals(3, p.length);
    assertEquals("{\"alg\":\"EdDSA\",\"typ\":\"endo-workload+jwt\"}", part(jwt, 0));
    String claims = part(jwt, 1);
    assertTrue(claims.contains("\"scope\":[\"identity.enrolment.keycloak\"]"));
    assertTrue(claims.contains("\"iss\":\"keycloak\",\"sub\":\"keycloak\",\"aud\":\"identity\""));
    assertTrue(claims.contains("\"iat\":1794398400,\"exp\":1794398460"));
    Signature v = Signature.getInstance("Ed25519");
    v.initVerify(kp.getPublic());
    v.update((p[0] + "." + p[1]).getBytes(StandardCharsets.US_ASCII));
    assertTrue(v.verify(Base64.getUrlDecoder().decode(p[2])));
  }

  @Test
  void refusesBadKeysAndScopes() throws Exception {
    assertThrows(GeneralSecurityException.class, () -> new WorkloadToken("AAAA", CLOCK));
    WorkloadToken t = new WorkloadToken(d(keys()), CLOCK);
    assertThrows(IllegalArgumentException.class, () -> t.sign(List.of()));
    assertThrows(IllegalArgumentException.class, () -> t.sign(List.of("Bad Scope")));
    assertThrows(IllegalArgumentException.class, () -> t.sign(List.of("a\",\"x.y")));
  }

  /** A stand-in identity service; returns the client pointed at it, and records requests. */
  private IdentityClient serve(int status, String body, List<String> seen) throws Exception {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        ex -> {
          seen.add(
              ex.getRequestURI().getPath()
                  + " "
                  + ex.getRequestHeaders().getFirst("authorization")
                  + " "
                  + new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
          byte[] out = body.getBytes(StandardCharsets.UTF_8);
          ex.sendResponseHeaders(status, out.length == 0 ? -1 : out.length);
          try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
          } catch (IOException e) {
            // closed
          }
        });
    server.start();
    URI base = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
    return new IdentityClient(base, new WorkloadToken(d(keys()), Clock.systemUTC()));
  }

  private static IdentityClient.Redeem request() {
    return new IdentityClient.Redeem(
        "R".repeat(43),
        "enrol",
        "https://kc.test/realms/endo",
        "bff-patient",
        "https://app.test/auth/enrolment/callback",
        "C".repeat(43),
        "state-123456789012",
        "nonce-123456789012",
        "root-1",
        "client-1",
        "tab-1");
  }

  @Test
  void redeemsAHandoffWithEveryBoundValue() throws Exception {
    List<String> seen = new ArrayList<>();
    IdentityClient c =
        serve(200, "{\"transaction_id\":\"" + TX + "\",\"provisional_subject\":\"" + SUBJECT + "\",\"kind\":\"enrol\"}", seen);
    IdentityClient.Redeemed r = c.redeem(request());
    assertNotNull(r);
    assertEquals(TX, r.transactionId());
    assertEquals(SUBJECT, r.provisionalSubject());
    String sent = seen.get(0);
    assertTrue(sent.startsWith("/internal/v1/enrolment/handoffs/redeem Bearer "));
    for (String field :
        List.of(
            "\"handoff_ref\":\"" + "R".repeat(43) + "\"",
            "\"redirect_uri\":\"https://app.test/auth/enrolment/callback\"",
            "\"code_challenge\":\"" + "C".repeat(43) + "\"",
            "\"root_session_id\":\"root-1\"",
            "\"tab_id\":\"tab-1\""))
      assertTrue(sent.contains(field), field);
  }

  @Test
  void treatsEveryUnexpectedAnswerAsARefusal() throws Exception {
    for (String[] answer :
        new String[][] {
          {"403", "{}"},
          {"500", "{}"},
          {"200", "not json"},
          {"200", "{\"transaction_id\":\"x\",\"provisional_subject\":\"" + SUBJECT + "\",\"kind\":\"enrol\"}"},
          {"200", "{\"transaction_id\":\"" + TX + "\",\"provisional_subject\":\"" + SUBJECT + "\",\"kind\":\"resume\"}"},
        }) {
      assertNull(serve(Integer.parseInt(answer[0]), answer[1], new ArrayList<>()).redeem(request()));
      stop();
    }
    // Nothing listening: refused, not thrown.
    IdentityClient down =
        new IdentityClient(URI.create("http://127.0.0.1:9"), new WorkloadToken(d(keys()), CLOCK));
    assertNull(down.redeem(request()));
    assertFalse(down.credentialCommitted(TX));
  }

  @Test
  void reportsTheCommittedPasskey() throws Exception {
    List<String> seen = new ArrayList<>();
    assertTrue(serve(200, "{\"status\":\"credential-committed\"}", seen).credentialCommitted(TX));
    assertTrue(seen.get(0).startsWith("/internal/v1/enrolment/transactions/" + TX + "/credential-committed Bearer "));
    stop();
    assertFalse(serve(409, "{}", new ArrayList<>()).credentialCommitted(TX));
    // Never builds a path from something that is not a transaction id.
    AtomicReference<String> none = new AtomicReference<>();
    assertFalse(serve(200, "{}", new ArrayList<>()).credentialCommitted("../persons"));
    assertNull(none.get());
  }

  @Test
  void quarantinesProvisionalUsersOutsideTheirOwnSignIn() {
    assertTrue(QuarantineGuard.allowed(null, null));
    assertTrue(QuarantineGuard.allowed(TX, TX));
    assertFalse(QuarantineGuard.allowed(TX, null));
    assertFalse(QuarantineGuard.allowed(TX, "01900000-0000-7000-8000-0000000000f2"));
    assertEquals(TX, EnrolmentPasskeyAction.boundTransaction(TX, TX));
    assertNull(EnrolmentPasskeyAction.boundTransaction(TX, null));
    assertNull(EnrolmentPasskeyAction.boundTransaction(null, null));
  }
}
