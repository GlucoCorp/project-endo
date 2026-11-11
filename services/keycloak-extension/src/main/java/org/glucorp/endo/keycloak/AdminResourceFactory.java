package org.glucorp.endo.keycloak;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;

/** Registers {@code /realms/{realm}/endo-enrolment} (ADR-0021 section 13). */
public final class AdminResourceFactory implements RealmResourceProviderFactory {
  @Override
  public String getId() {
    return "endo-enrolment";
  }

  @Override
  public RealmResourceProvider create(KeycloakSession session) {
    EnrolmentAdminResource resource = new EnrolmentAdminResource(session);
    return new RealmResourceProvider() {
      @Override
      public Object getResource() {
        return resource;
      }

      @Override
      public void close() {}
    };
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
