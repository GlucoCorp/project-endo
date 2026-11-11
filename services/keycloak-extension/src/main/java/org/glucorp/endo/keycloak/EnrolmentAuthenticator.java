package org.glucorp.endo.keycloak;

import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.services.Urls;
import org.keycloak.sessions.AuthenticationSessionModel;

/**
 * {@code endo-enrolment} (ADR-0021 section 7). Without a handoff reference it answers
 * {@code attempted()}, so the ordinary alternatives run. With one, it either succeeds or ends the
 * flow on a terminal error page: never a plain failure that could fall through to an SSO cookie.
 *
 * <p>Only the opaque reference is read from the request. Every value the handoff is bound to
 * (issuer, client, redirect URI, PKCE challenge, state, nonce) is taken from Keycloak's own
 * authentication session and compared by the coordinator; {@code client_request_param_*} is never
 * trusted for them.
 */
public class EnrolmentAuthenticator implements Authenticator {

  @Override
  public void authenticate(AuthenticationFlowContext ctx) {
    AuthenticationSessionModel auth = ctx.getAuthenticationSession();
    String ref = auth.getClientNote(EndoConfig.HANDOFF_PARAM);
    if (ref == null || ref.isEmpty()) {
      ctx.attempted();
      return;
    }
    IdentityClient client = EndoConfig.client();
    RealmModel realm = ctx.getRealm();
    IdentityClient.Redeemed redeemed =
        client == null
            ? null
            : client.redeem(
                new IdentityClient.Redeem(
                    ref,
                    "enrol",
                    Urls.realmIssuer(ctx.getUriInfo().getBaseUri(), realm.getName()),
                    auth.getClient().getClientId(),
                    auth.getRedirectUri(),
                    nonNull(auth.getClientNote(OIDCLoginProtocol.CODE_CHALLENGE_PARAM)),
                    nonNull(auth.getClientNote(OIDCLoginProtocol.STATE_PARAM)),
                    nonNull(auth.getClientNote(OIDCLoginProtocol.NONCE_PARAM)),
                    auth.getParentSession().getId(),
                    auth.getClient().getId(),
                    auth.getTabId()));
    if (redeemed == null) {
      refuse(ctx);
      return;
    }
    UserModel user = provisionalUser(ctx.getSession(), realm, redeemed);
    if (user == null) {
      refuse(ctx);
      return;
    }
    auth.setAuthNote(EndoConfig.TX_NOTE, redeemed.transactionId());
    // Any user already signed in on this browser is ignored: this sign-in is hers alone.
    ctx.setUser(user);
    ctx.success();
  }

  /**
   * Creates the provisional user with the id the coordinator chose, or resumes it on a retry. An
   * existing user with that id but another transaction is refused.
   */
  static UserModel provisionalUser(
      KeycloakSession session, RealmModel realm, IdentityClient.Redeemed r) {
    UserModel user = session.users().getUserById(realm, r.provisionalSubject());
    if (user == null) {
      user = session.users().addUser(realm, r.provisionalSubject(), "enrol-" + r.provisionalSubject(), false, false);
      user.setEnabled(true);
      user.setSingleAttribute(EndoConfig.QUARANTINE, r.transactionId());
      user.addRequiredAction(EndoConfig.ACTION_ID);
      return user;
    }
    return r.transactionId().equals(user.getFirstAttribute(EndoConfig.QUARANTINE)) ? user : null;
  }

  private static void refuse(AuthenticationFlowContext ctx) {
    Response page =
        ctx.form()
            .setError("endoEnrolmentRefused")
            .createErrorPage(Response.Status.FORBIDDEN);
    ctx.failureChallenge(AuthenticationFlowError.ACCESS_DENIED, page);
  }

  private static String nonNull(String s) {
    return s == null ? "" : s;
  }

  @Override
  public void action(AuthenticationFlowContext ctx) {
    ctx.attempted();
  }

  @Override
  public boolean requiresUser() {
    return false;
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
