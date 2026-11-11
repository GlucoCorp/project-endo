package org.glucorp.endo.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.InitiatedActionSupport;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.models.AbstractKeycloakTransaction;

/**
 * {@code endo-enrolment-passkey} (ADR-0021 section 8): Keycloak's own passwordless WebAuthn
 * registration, reachable only inside a redeemed enrolment. It checks the binding (the sign-in's
 * redeemed transaction equals the user's quarantine) both when it shows the challenge and when it
 * processes the answer; {@code kc_action} cannot reach it. Once Keycloak has committed the new
 * passkey, it tells the coordinator.
 */
public class EnrolmentPasskeyAction implements RequiredActionProvider {
  private final RequiredActionProvider webauthn;

  EnrolmentPasskeyAction(RequiredActionProvider webauthn) {
    this.webauthn = webauthn;
  }

  /** The transaction of a bound enrolment, or null when this sign-in is not one. */
  static String boundTransaction(String quarantine, String redeemedTx) {
    return quarantine != null && quarantine.equals(redeemedTx) ? quarantine : null;
  }

  private static String bound(RequiredActionContext ctx) {
    return boundTransaction(
        ctx.getUser().getFirstAttribute(EndoConfig.QUARANTINE),
        ctx.getAuthenticationSession().getAuthNote(EndoConfig.TX_NOTE));
  }

  private static void refuse(RequiredActionContext ctx) {
    ctx.challenge(
        ctx.form().setError("endoEnrolmentRefused").createErrorPage(Response.Status.FORBIDDEN));
  }

  @Override
  public InitiatedActionSupport initiatedActionSupport() {
    return InitiatedActionSupport.NOT_SUPPORTED;
  }

  @Override
  public void evaluateTriggers(RequiredActionContext ctx) {}

  @Override
  public void requiredActionChallenge(RequiredActionContext ctx) {
    if (webauthn == null || bound(ctx) == null) {
      refuse(ctx);
      return;
    }
    webauthn.requiredActionChallenge(ctx);
  }

  @Override
  public void processAction(RequiredActionContext ctx) {
    String tx = bound(ctx);
    if (webauthn == null || tx == null) {
      refuse(ctx);
      return;
    }
    webauthn.processAction(ctx);
    if (ctx.getStatus() != RequiredActionContext.Status.SUCCESS) return;
    // After Keycloak's own transaction commits the passkey, never before (ADR-0021 section 10).
    // If the notice is lost, the coordinator reconciles by asking Keycloak (slice 6).
    IdentityClient client = EndoConfig.client();
    ctx.getSession()
        .getTransactionManager()
        .enlistAfterCompletion(
            new AbstractKeycloakTransaction() {
              @Override
              protected void commitImpl() {
                if (client != null) client.credentialCommitted(tx);
              }

              @Override
              protected void rollbackImpl() {}
            });
  }

  @Override
  public void close() {
    if (webauthn != null) webauthn.close();
  }
}
