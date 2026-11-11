package org.glucorp.endo.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

/** Keycloak factories for the extension's providers (ADR-0021 sections 7 and 8). */
public final class Factories {
  private Factories() {}

  private static final AuthenticationExecutionModel.Requirement[] ALTERNATIVE = {
    AuthenticationExecutionModel.Requirement.ALTERNATIVE
  };
  private static final AuthenticationExecutionModel.Requirement[] REQUIRED = {
    AuthenticationExecutionModel.Requirement.REQUIRED
  };

  /** Shared plumbing for the two authenticators. */
  private abstract static class Base implements AuthenticatorFactory {
    @Override
    public void init(Config.Scope config) {
      EndoConfig.init();
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {}

    @Override
    public void close() {}

    @Override
    public String getReferenceCategory() {
      return "endo";
    }

    @Override
    public boolean isConfigurable() {
      return false;
    }

    @Override
    public boolean isUserSetupAllowed() {
      return false;
    }

    @Override
    public List<ProviderConfigProperty> getConfigProperties() {
      return List.of();
    }
  }

  public static final class Enrolment extends Base {
    private static final EnrolmentAuthenticator SINGLETON = new EnrolmentAuthenticator();

    @Override
    public String getId() {
      return "endo-enrolment";
    }

    @Override
    public String getDisplayType() {
      return "Endo enrolment handoff";
    }

    @Override
    public String getHelpText() {
      return "Redeems an enrolment handoff with the identity coordinator (ADR-0021).";
    }

    @Override
    public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
      return ALTERNATIVE.clone();
    }

    @Override
    public Authenticator create(KeycloakSession session) {
      return SINGLETON;
    }
  }

  public static final class EmailCode extends Base {
    private static final EmailCodeAuthenticator SINGLETON = new EmailCodeAuthenticator();

    @Override
    public String getId() {
      return "endo-email-code";
    }

    @Override
    public String getDisplayType() {
      return "Email me a code";
    }

    @Override
    public String getHelpText() {
      return "Sign in with a code sent to your email address.";
    }

    @Override
    public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
      return ALTERNATIVE.clone();
    }

    @Override
    public Authenticator create(KeycloakSession session) {
      return SINGLETON;
    }
  }

  public static final class Guard extends Base {
    private static final QuarantineGuard SINGLETON = new QuarantineGuard();

    @Override
    public String getId() {
      return "endo-quarantine-guard";
    }

    @Override
    public String getDisplayType() {
      return "Endo enrolment quarantine";
    }

    @Override
    public String getHelpText() {
      return "Refuses users still in enrolment, except for the sign-in that redeemed it.";
    }

    @Override
    public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
      return REQUIRED.clone();
    }

    @Override
    public Authenticator create(KeycloakSession session) {
      return SINGLETON;
    }
  }

  public static final class Passkey implements RequiredActionFactory {
    /** Keycloak's own passwordless WebAuthn registration, which this action guards. */
    static final String WEBAUTHN = "webauthn-register-passwordless";

    @Override
    public String getId() {
      return EndoConfig.ACTION_ID;
    }

    @Override
    public String getDisplayText() {
      return "Endo enrolment passkey";
    }

    @Override
    public RequiredActionProvider create(KeycloakSession session) {
      return new EnrolmentPasskeyAction(session.getProvider(RequiredActionProvider.class, WEBAUTHN));
    }

    @Override
    public boolean isOneTimeAction() {
      return true;
    }

    @Override
    public void init(Config.Scope config) {
      EndoConfig.init();
    }

    @Override
    public void postInit(KeycloakSessionFactory factory) {}

    @Override
    public void close() {}
  }
}
