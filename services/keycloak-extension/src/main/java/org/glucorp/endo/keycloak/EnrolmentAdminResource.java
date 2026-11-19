package org.glucorp.endo.keycloak;

import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.Map;
import java.util.regex.Pattern;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserManager;

/**
 * The extension's narrow admin endpoint (ADR-0021 sections 10, 11 and 13):
 * {@code /realms/{realm}/endo-enrolment/...}, for the identity coordinator only (workload scope
 * {@code keycloak.enrolment.admin}). It acts only on users quarantined for the named transaction.
 */
public class EnrolmentAdminResource {
  static final String SCOPE = "keycloak.enrolment.admin";
  private static final Pattern UUID_RE =
      Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

  /** What the endpoint decides, apart from Keycloak, so it can be tested on its own. */
  enum Outcome {
    DONE,
    REFUSED
  }

  private final KeycloakSession session;

  EnrolmentAdminResource(KeycloakSession session) {
    this.session = session;
  }

  /** Activation step 3: assign `patient`, lift the quarantine. Idempotent. */
  @POST
  @Path("finalise")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response finalise(@HeaderParam("authorization") String auth, Map<String, Object> body) {
    if (!authorised(auth)) return status(Response.Status.UNAUTHORIZED);
    RealmModel realm = session.getContext().getRealm();
    UserModel user = user(realm, body);
    if (user == null) return status(Response.Status.NOT_FOUND);
    RoleModel patient = realm.getRole("patient");
    if (patient == null) return status(Response.Status.CONFLICT);
    Outcome o =
        decideFinalise(
            user.getFirstAttribute(EndoConfig.QUARANTINE), user.hasRole(patient), (String) body.get("transaction_id"));
    if (o == Outcome.REFUSED) return status(Response.Status.CONFLICT);
    if (o == Outcome.DONE && user.getFirstAttribute(EndoConfig.QUARANTINE) != null) {
      user.grantRole(patient);
      user.removeRequiredAction(EndoConfig.ACTION_ID);
      user.removeAttribute(EndoConfig.QUARANTINE);
    }
    return Response.ok(Map.of("finalised", true)).build();
  }

  /** Cleanup (section 11): deletes a provisional user, never anyone else. Idempotent. */
  @POST
  @Path("delete")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response delete(@HeaderParam("authorization") String auth, Map<String, Object> body) {
    if (!authorised(auth)) return status(Response.Status.UNAUTHORIZED);
    RealmModel realm = session.getContext().getRealm();
    if (!validIds(body)) return status(Response.Status.BAD_REQUEST);
    UserModel user = session.users().getUserById(realm, (String) body.get("subject"));
    if (user == null) return Response.ok(Map.of("deleted", true)).build();
    if (decideDelete(user.getFirstAttribute(EndoConfig.QUARANTINE), (String) body.get("transaction_id"))
        != Outcome.DONE) return status(Response.Status.CONFLICT);
    session.users().removeUser(realm, user);
    return Response.ok(Map.of("deleted", true)).build();
  }

  /**
   * REQ-009, ADR-0029: her account goes when she is erased. The identity service calls this with
   * her subject (scope {@code keycloak.user.erase}) before it clears the subject. Only a patient's
   * account, or one still in enrolment, can be erased this way; a staff account never is (409).
   * Her sessions, credentials (passkeys) and consents go with the user. Idempotent: an unknown
   * subject is already erased.
   */
  @POST
  @Path("erase")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response erase(@HeaderParam("authorization") String auth, Map<String, Object> body) {
    WorkloadTokenVerifier v = EndoConfig.identityVerifier();
    if (v == null || !v.verify(auth, ERASE_SCOPE)) return status(Response.Status.UNAUTHORIZED);
    if (body == null || !(body.get("subject") instanceof String subject) || !UUID_RE.matcher(subject).matches())
      return status(Response.Status.BAD_REQUEST);
    RealmModel realm = session.getContext().getRealm();
    UserModel user = session.users().getUserById(realm, subject);
    if (user == null) return Response.ok(Map.of("erased", true)).build();
    RoleModel patient = realm.getRole("patient");
    boolean isPatient = patient != null && user.hasRole(patient);
    boolean isStaff = user.getRoleMappingsStream().anyMatch(r -> STAFF_ROLES.contains(r.getName()));
    if (decideErase(isPatient, user.getFirstAttribute(EndoConfig.QUARANTINE), isStaff) != Outcome.DONE)
      return status(Response.Status.CONFLICT);
    new UserManager(session).removeUser(realm, user);
    return Response.ok(Map.of("erased", true)).build();
  }

  static final String ERASE_SCOPE = "keycloak.user.erase";
  private static final java.util.Set<String> STAFF_ROLES =
      java.util.Set.of("clinician", "org_admin", "glucorp_platform_admin", "glucorp_support");

  /** A patient (or a user still in enrolment) who holds no staff role. */
  static Outcome decideErase(boolean isPatient, String quarantine, boolean isStaff) {
    if (isStaff) return Outcome.REFUSED;
    return isPatient || quarantine != null ? Outcome.DONE : Outcome.REFUSED;
  }

  /**
   * ADR-0026: sends one code email for the identity service (confirming a new address). The
   * identity service chose the address and drew the code; this only delivers it, with the
   * realm's own SMTP settings and the same neutral message as sign-in.
   */
  @POST
  @Path("send-email")
  @Consumes(MediaType.APPLICATION_JSON)
  @Produces(MediaType.APPLICATION_JSON)
  public Response sendEmail(@HeaderParam("authorization") String auth, Map<String, Object> body) {
    WorkloadTokenVerifier v = EndoConfig.identityVerifier();
    if (v == null || !v.verify(auth, EMAIL_SCOPE)) return status(Response.Status.UNAUTHORIZED);
    if (body == null
        || !(body.get("to") instanceof String to)
        || !(body.get("code") instanceof String code)
        || !EMAIL.matcher(to).matches()
        || !code.matches("^[0-9]{6}$")) return status(Response.Status.BAD_REQUEST);
    RealmModel realm = session.getContext().getRealm();
    boolean sent =
        EmailCodeAuthenticator.send(
            session, realm, new IdentityClient.EmailCode("unused", to, code));
    return sent
        ? Response.ok(Map.of("sent", true)).build()
        : status(Response.Status.SERVICE_UNAVAILABLE);
  }

  static final String EMAIL_SCOPE = "keycloak.email.send";
  private static final Pattern EMAIL = Pattern.compile("^[^\\s@]{1,64}@[^\\s@]{1,189}$");

  /** Finalise only the user quarantined for this transaction; a repeat after success is DONE. */
  static Outcome decideFinalise(String quarantine, boolean isPatient, String transactionId) {
    if (quarantine == null) return isPatient ? Outcome.DONE : Outcome.REFUSED;
    return quarantine.equals(transactionId) ? Outcome.DONE : Outcome.REFUSED;
  }

  /** Delete only a provisional user quarantined for this transaction. */
  static Outcome decideDelete(String quarantine, String transactionId) {
    return quarantine != null && quarantine.equals(transactionId) ? Outcome.DONE : Outcome.REFUSED;
  }

  private boolean authorised(String auth) {
    WorkloadTokenVerifier v = EndoConfig.identityVerifier();
    return v != null && v.verify(auth, SCOPE);
  }

  private static boolean validIds(Map<String, Object> body) {
    return body != null
        && body.get("subject") instanceof String s
        && body.get("transaction_id") instanceof String t
        && UUID_RE.matcher(s).matches()
        && UUID_RE.matcher(t).matches();
  }

  private UserModel user(RealmModel realm, Map<String, Object> body) {
    if (!validIds(body)) return null;
    return session.users().getUserById(realm, (String) body.get("subject"));
  }

  private static Response status(Response.Status s) {
    return Response.status(s).entity(Map.of()).type(MediaType.APPLICATION_JSON).build();
  }
}
