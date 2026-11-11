# The endo-keycloak image (ADR-0021 section 15, ADR-0025): the pinned Keycloak release plus the
# enrolment extension, built and tested in a digest-pinned Maven container (Maven Central only,
# strict checksums). Build context: this directory.
FROM maven:3.9.16-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q --strict-checksums -Dmaven.repo.local=/m2 dependency:go-offline
COPY src ./src
RUN mvn -B -q --strict-checksums -Dmaven.repo.local=/m2 package

# Upgraded only together with keycloak.version in pom.xml (ADR-0021 section 16).
FROM quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332
COPY --from=build --chown=1000:0 /src/target/endo-keycloak-extension-0.1.0.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build
USER 1000
