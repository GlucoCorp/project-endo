package org.glucorp.endo.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/**
 * {@code endo-quarantine-guard} (ADR-0021 section 7), REQUIRED after the sign-in alternatives. A
 * user still carrying {@code endo_enrolment} may complete only the sign-in that redeemed that same
 * transaction; an SSO cookie or a passkey sign-in on its own is refused until activation removes
 * the quarantine.
 */
public class QuarantineGuard implements Authenticator {

  /** True when the user may continue: not quarantined, or quarantined for this very sign-in. */
  static boolean allowed(String quarantine, String redeemedTx) {
    return quarantine == null || quarantine.equals(redeemedTx);
  }

  @Override
  public void authenticate(AuthenticationFlowContext ctx) {
    UserModel user = ctx.getUser();
    String quarantine = user == null ? null : user.getFirstAttribute(EndoConfig.QUARANTINE);
    String redeemed = ctx.getAuthenticationSession().getAuthNote(EndoConfig.TX_NOTE);
    if (allowed(quarantine, redeemed)) {
      ctx.success();
      return;
    }
    Response page =
        ctx.form()
            .setError("endoEnrolmentRefused")
            .createErrorPage(Response.Status.FORBIDDEN);
    ctx.failureChallenge(AuthenticationFlowError.ACCESS_DENIED, page);
  }

  @Override
  public void action(AuthenticationFlowContext ctx) {
    authenticate(ctx);
  }

  @Override
  public boolean requiresUser() {
    return true;
  }

  @Override
  public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
    return true;
  }

  @Override
  public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {}

  @Override
  public void close() {}
}
