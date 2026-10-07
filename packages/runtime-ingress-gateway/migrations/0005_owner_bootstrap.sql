CREATE TABLE owner_bootstrap_authorizations (
  id text PRIMARY KEY CHECK (id ~ '^ob_[A-Za-z0-9_-]+$'),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  expected_issuer text NOT NULL,
  expected_email text NOT NULL,
  organization_name text NOT NULL CHECK (char_length(organization_name) BETWEEN 1 AND 200),
  contract_reference text NOT NULL CHECK (char_length(contract_reference) BETWEEN 1 AND 200),
  support_tier text NOT NULL CHECK (support_tier IN ('standard', 'business', 'enterprise')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  grace_ends_at timestamptz,
  seat_limit integer NOT NULL CHECK (seat_limit > 0),
  concurrent_session_limit integer NOT NULL CHECK (concurrent_session_limit > 0),
  workspace_limit integer NOT NULL CHECK (workspace_limit > 0),
  operation_id text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  candidate_issuer text,
  candidate_subject text,
  candidate_email text,
  candidate_display_name text,
  candidate_code_hash text CHECK (candidate_code_hash IS NULL OR char_length(candidate_code_hash) = 64),
  candidate_at timestamptz,
  confirmed_at timestamptz,
  organization_id text REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((candidate_subject IS NULL AND candidate_code_hash IS NULL AND candidate_at IS NULL) OR
         (candidate_subject IS NOT NULL AND candidate_code_hash IS NOT NULL AND candidate_at IS NOT NULL)),
  CHECK ((confirmed_at IS NULL AND organization_id IS NULL) OR
         (confirmed_at IS NOT NULL AND organization_id IS NOT NULL))
);

CREATE INDEX owner_bootstrap_expiry_idx ON owner_bootstrap_authorizations(expires_at)
  WHERE confirmed_at IS NULL;
