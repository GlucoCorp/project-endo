package org.glucorp.endo.keycloak;

import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.util.regex.Pattern;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;

/**
 * {@code endo-email-code} (spec 10.1; ADR-0026): the fallback when she cannot use her passkey.
 * She types her address; the identity service decides whether a code exists for it and returns
 * it only for delivery, which Keycloak's own SMTP sender does, to the address she confirmed. The
 * next page is the same whether or not a code was sent. She types the code; the identity service
 * checks it (5 wrong entries lock it) and names her user. The quarantine guard still runs after.
 */
public class EmailCodeAuthenticator implements Authenticator {
  static final String FORM = "endo-email-code.ftl";
  static final String REQUEST_NOTE = "endo_email_request";
  private static final Pattern EMAIL = Pattern.compile("^[^\\s@]{1,64}@[^\\s@]{1,189}$");
  private static final Pattern CODE = Pattern.compile("^[0-9]{6}$");
  private static final Pattern UUID_RE =
      Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

  /** The neutral message (spec 13.2: no product or health words a shared inbox could reveal). */
  static final String SUBJECT = "Your sign-in code";

  static String body(String code) {
    return "Your code is "
        + code
        + ". It works for 10 minutes.\n\nIf you did not ask for it, you can ignore this email.";
  }

  @Override
  public void authenticate(AuthenticationFlowContext ctx) {
    ctx.challenge(form(ctx, "address", null));
  }

  @Override
  public void action(AuthenticationFlowContext ctx) {
    MultivaluedMap<String, String> f = ctx.getHttpRequest().getDecodedFormParameters();
    String stage = f.getFirst("stage");
    IdentityClient client = EndoConfig.client();
    if (client == null) {
      ctx.failureChallenge(
          AuthenticationFlowError.INTERNAL_ERROR, form(ctx, "address", "endoEmailUnavailable"));
      return;
    }
    if ("code".equals(stage)) {
      verify(ctx, client, f.getFirst("code"));
      return;
    }
    String address = f.getFirst("address");
    if (address == null || !EMAIL.matcher(address.trim()).matches()) {
      ctx.failureChallenge(
          AuthenticationFlowError.INVALID_CREDENTIALS, form(ctx, "address", "endoEmailInvalid"));
      return;
    }
    IdentityClient.EmailCode issued =
        client.emailSignIn(address.trim(), ctx.getConnection().getRemoteAddr());
    if (issued == null) {
      ctx.failureChallenge(
          AuthenticationFlowError.INTERNAL_ERROR, form(ctx, "address", "endoEmailUnavailable"));
      return;
    }
    if (issued.deliverTo() != null && !send(ctx.getSession(), ctx.getRealm(), issued)) {
      ctx.failureChallenge(
          AuthenticationFlowError.INTERNAL_ERROR, form(ctx, "address", "endoEmailUnavailable"));
      return;
    }
    ctx.getAuthenticationSession().setAuthNote(REQUEST_NOTE, issued.requestId());
    // The same page whether or not a code went out: nothing tells who has an account.
    ctx.challenge(form(ctx, "code", null));
  }

  private void verify(AuthenticationFlowContext ctx, IdentityClient client, String code) {
    String requestId = ctx.getAuthenticationSession().getAuthNote(REQUEST_NOTE);
    if (requestId == null || !UUID_RE.matcher(requestId).matches()) {
      ctx.challenge(form(ctx, "address", null));
      return;
    }
    String subject =
        code != null && CODE.matcher(code).matches() ? client.verifyEmail(requestId, code) : null;
    UserModel user =
        subject == null ? null : ctx.getSession().users().getUserById(ctx.getRealm(), subject);
    // Never a provisional user: enrolment finishes only through its own handoff.
    if (user == null || !user.isEnabled() || user.getFirstAttribute(EndoConfig.QUARANTINE) != null) {
      ctx.failureChallenge(
          AuthenticationFlowError.INVALID_CREDENTIALS, form(ctx, "code", "endoEmailCodeWrong"));
      return;
    }
    ctx.getAuthenticationSession().removeAuthNote(REQUEST_NOTE);
    ctx.setUser(user);
    ctx.success();
  }

  /** Sends with the realm's SMTP settings; false if mail cannot be handed over. */
  static boolean send(KeycloakSession session, RealmModel realm, IdentityClient.EmailCode c) {
    try {
      session
          .getProvider(EmailSenderProvider.class)
          .send(realm.getSmtpConfig(), c.deliverTo(), SUBJECT, body(c.code()), null);
      return true;
    } catch (EmailException | RuntimeException e) {
      return false;
    }
  }

  private static Response form(AuthenticationFlowContext ctx, String stage, String error) {
    var f = ctx.form().setAttribute("stage", stage);
    if (error != null) f.setError(error);
    return f.createForm(FORM);
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
