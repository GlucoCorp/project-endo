package org.glucorp.endo.keycloak;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.keycloak.util.JsonSerialization;

/**
 * The identity coordinator, as Keycloak calls it (ADR-0021 section 13): redeem a handoff and
 * report a committed passkey, with workload scope {@code identity.enrolment.keycloak}. No
 * redirects, five-second timeouts; anything unexpected is a refusal, never a guess.
 */
public class IdentityClient {
  static final String SCOPE = "identity.enrolment.keycloak";
  private static final Pattern UUID_RE =
      Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

  /** What a handoff names and how the real request looks (ADR-0021 section 5). */
  public record Redeem(
      String handoffRef,
      String kind,
      String issuer,
      String clientId,
      String redirectUri,
      String codeChallenge,
      String state,
      String nonce,
      String rootSessionId,
      String clientUuid,
      String tabId) {}

  /** A redeemed handoff: the transaction and the provisional user's id the coordinator chose. */
  public record Redeemed(String transactionId, String provisionalSubject, String kind) {}

  private final URI base;
  private final WorkloadToken token;
  private final HttpClient http;

  public IdentityClient(URI base, WorkloadToken token) {
    this.base = base;
    this.token = token;
    this.http =
        HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(5))
            .build();
  }

  /** The redeemed handoff, or null for any refusal or failure (the flow then ends, closed). */
  public Redeemed redeem(Redeem r) {
    Map<String, Object> body =
        Map.of(
            "handoff_ref", r.handoffRef(),
            "kind", r.kind(),
            "issuer", r.issuer(),
            "client_id", r.clientId(),
            "redirect_uri", r.redirectUri(),
            "code_challenge", r.codeChallenge(),
            "state", r.state(),
            "nonce", r.nonce(),
            "session",
                Map.of(
                    "root_session_id", r.rootSessionId(),
                    "client_uuid", r.clientUuid(),
                    "tab_id", r.tabId()));
    try {
      HttpResponse<String> res = post("/internal/v1/enrolment/handoffs/redeem", body);
      if (res.statusCode() != 200) return null;
      Map<?, ?> out = JsonSerialization.readValue(res.body(), Map.class);
      Object tx = out.get("transaction_id");
      Object subject = out.get("provisional_subject");
      Object kind = out.get("kind");
      if (tx instanceof String t
          && subject instanceof String s
          && kind instanceof String k
          && UUID_RE.matcher(t).matches()
          && UUID_RE.matcher(s).matches()
          && k.equals(r.kind())) return new Redeemed(t, s, k);
      return null;
    } catch (IOException | GeneralSecurityException e) {
      return null;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return null;
    }
  }

  /**
   * ADR-0021 section 8: may this provisional user register a passkey for this transaction now?
   * False for any refusal or failure (the registration is then refused, closed).
   */
  public boolean registrationAllowed(String transactionId, String subject) {
    if (!UUID_RE.matcher(transactionId).matches() || !UUID_RE.matcher(subject).matches()) return false;
    try {
      return post(
                  "/internal/v1/enrolment/transactions/" + transactionId + "/registration-check",
                  Map.of("subject", subject))
              .statusCode()
          == 200;
    } catch (IOException | GeneralSecurityException e) {
      return false;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return false;
    }
  }

  /** Reports the committed passkey (ADR-0021 section 10). True when the coordinator accepted it. */
  public boolean credentialCommitted(String transactionId) {
    if (!UUID_RE.matcher(transactionId).matches()) return false;
    try {
      return post("/internal/v1/enrolment/transactions/" + transactionId + "/credential-committed", null)
              .statusCode()
          == 200;
    } catch (IOException | GeneralSecurityException e) {
      return false;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return false;
    }
  }

  private HttpResponse<String> post(String path, Map<String, Object> body)
      throws IOException, InterruptedException, GeneralSecurityException {
    HttpRequest.Builder req =
        HttpRequest.newBuilder(base.resolve(path))
            .timeout(Duration.ofSeconds(5))
            .header("authorization", "Bearer " + token.sign(List.of(SCOPE)));
    if (body == null) req.POST(HttpRequest.BodyPublishers.noBody());
    else
      req.header("content-type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(JsonSerialization.writeValueAsString(body)));
    return http.send(req.build(), HttpResponse.BodyHandlers.ofString());
  }
}
