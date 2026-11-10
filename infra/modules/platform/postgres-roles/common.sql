-- Cluster-wide defaults. Idempotent.
-- Never log the text of a failed statement in this session: ALTER ROLE carries a password.
SET log_min_error_statement = panic;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
