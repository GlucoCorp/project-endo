-- Durable browser sessions for the BFFs (spec 10.1, 10.2; ADR-0019 section 5; ADR-0033).
--
-- One row per session. The browser holds the token; only its SHA-256 is stored, so a copy of
-- this table cannot be used to take over a session. Expiry (idle and absolute) is checked by the
-- database on every read, so every BFF replica agrees. `doc` holds what the BFF keeps about the
-- session: opaque ids, roles, the sealed refresh token. No health data.

CREATE TABLE browser_session (
  token_hash    char(64)    PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind          text        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_-]{0,31}$'),
  doc           jsonb       NOT NULL CHECK (jsonb_typeof(doc) = 'object'
                                            AND octet_length(doc::text) <= 16384),
  -- For back-channel logout (revoke every session of a Keycloak session or subject).
  issuer        text        CHECK (char_length(issuer) <= 512),
  sid           text        CHECK (char_length(sid) <= 255),
  subject       text        CHECK (char_length(subject) <= 255),
  idle_ms       integer     NOT NULL CHECK (idle_ms BETWEEN 60000 AND 86400000),
  absolute_ms   integer     NOT NULL CHECK (absolute_ms BETWEEN 60000 AND 86400000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_session_logout_idx ON browser_session (issuer, sid);
CREATE INDEX browser_session_subject_idx ON browser_session (issuer, subject);
CREATE INDEX browser_session_expiry_idx ON browser_session (last_seen_at);

REVOKE ALL ON browser_session FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE (doc, last_seen_at), DELETE ON browser_session TO endo_sessions_app;
