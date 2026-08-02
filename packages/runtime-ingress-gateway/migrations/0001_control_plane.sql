-- Agent RunLab Hosted/Hybrid control-plane schema.
-- IDs are opaque application-generated values. Human-readable names are never routing keys.

CREATE TABLE organizations (
  id text PRIMARY KEY CHECK (id ~ '^org_[A-Za-z0-9_-]+$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug text UNIQUE CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  status text NOT NULL CHECK (status IN ('provisioning','active','suspended','closing','closed')),
  runtime_unit_id text NOT NULL UNIQUE,
  authorization_version bigint NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  closed_at timestamptz
);

CREATE TABLE principals (
  id text PRIMARY KEY CHECK (id ~ '^prn_[A-Za-z0-9_-]+$'),
  kind text NOT NULL CHECK (kind IN ('human','service_account')),
  issuer text,
  subject text,
  display_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'human' AND issuer IS NOT NULL AND subject IS NOT NULL) OR (kind = 'service_account' AND issuer IS NULL AND subject IS NULL)),
  UNIQUE NULLS NOT DISTINCT (issuer, subject)
);

CREATE TABLE organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, principal_id)
);
CREATE INDEX organization_memberships_principal_idx ON organization_memberships(principal_id) WHERE status = 'active';
CREATE INDEX organization_active_owner_idx ON organization_memberships(organization_id) WHERE role = 'owner' AND status = 'active';

CREATE TABLE organization_invites (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member','viewer')),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX organization_invites_open_idx ON organization_invites(organization_id, email_normalized) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE contract_entitlements (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  contract_reference text NOT NULL UNIQUE,
  support_tier text NOT NULL CHECK (support_tier IN ('standard','business','enterprise')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  grace_ends_at timestamptz,
  seat_limit integer NOT NULL CHECK (seat_limit > 0),
  concurrent_session_limit integer NOT NULL CHECK (concurrent_session_limit > 0),
  monthly_token_limit bigint CHECK (monthly_token_limit IS NULL OR monthly_token_limit >= 0),
  storage_bytes_limit bigint CHECK (storage_bytes_limit IS NULL OR storage_bytes_limit >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (grace_ends_at IS NULL OR grace_ends_at >= ends_at)
);

CREATE TABLE workspaces (
  id text PRIMARY KEY CHECK (id ~ '^ws_[A-Za-z0-9_-]+$'),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

CREATE TABLE workspace_grants (
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  access text NOT NULL CHECK (access IN ('admin','write','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, principal_id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, principal_id) REFERENCES organization_memberships(organization_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE workspace_policies (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  updated_by text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime_unit_placements (
  runtime_unit_id text PRIMARY KEY,
  organization_id text NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  desired_state text NOT NULL CHECK (desired_state IN ('ready','suspended','deleted')),
  generation bigint NOT NULL CHECK (generation > 0),
  host_id text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  last_operation_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((host_id IS NULL) = (lease_token_hash IS NULL)),
  CHECK ((host_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE executor_pools (
  id text PRIMARY KEY CHECK (id ~ '^pool_[A-Za-z0-9_-]+$'),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('organization','workspace')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'organization' AND workspace_id IS NULL) OR (mode = 'workspace' AND workspace_id IS NOT NULL)),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE executors (
  id text PRIMARY KEY CHECK (id ~ '^exe_[A-Za-z0-9_-]+$'),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pool_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','active','draining','revoked')),
  credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  public_key text,
  fingerprint text,
  platform jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(platform) = 'object'),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fingerprint),
  FOREIGN KEY (organization_id, pool_id) REFERENCES executor_pools(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX executors_pool_status_idx ON executors(pool_id, status);

CREATE TABLE executor_enrollment_tokens (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pool_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_by text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (organization_id, pool_id) REFERENCES executor_pools(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE browser_sessions (
  id text PRIMARY KEY CHECK (id ~ '^bs_[A-Za-z0-9_-]+$'),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  cache_namespace text NOT NULL,
  device jsonb NOT NULL CHECK (jsonb_typeof(device) = 'object'),
  encrypted_refresh_token jsonb,
  provider_refresh_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (idle_expires_at <= absolute_expires_at),
  FOREIGN KEY (organization_id, principal_id) REFERENCES organization_memberships(organization_id, principal_id) ON DELETE CASCADE
);
CREATE INDEX browser_sessions_live_principal_idx ON browser_sessions(principal_id, last_seen_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE notification_devices (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  browser_session_id text REFERENCES browser_sessions(id) ON DELETE SET NULL,
  endpoint_hash text NOT NULL,
  subscription_encrypted jsonb NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, endpoint_hash),
  FOREIGN KEY (organization_id, principal_id) REFERENCES organization_memberships(organization_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE retention_policies (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  session_days integer NOT NULL CHECK (session_days > 0),
  artifact_days integer NOT NULL CHECK (artifact_days > 0),
  audit_days integer NOT NULL CHECK (audit_days > 0),
  deleted_resource_grace_days integer NOT NULL CHECK (deleted_resource_grace_days >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_ledger (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  principal_id text REFERENCES principals(id) ON DELETE SET NULL,
  session_id text,
  model_key text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  estimated_cost_microunits bigint CHECK (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
  occurred_at timestamptz NOT NULL,
  source_operation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (organization_id, source_operation_id)
);
CREATE INDEX usage_ledger_org_time_idx ON usage_ledger(organization_id, occurred_at DESC);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','service_account','executor','system')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  result text NOT NULL CHECK (result IN ('allowed','denied','succeeded','failed')),
  request_id text,
  trace_id text,
  source_ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit_events(organization_id, occurred_at DESC, id);
CREATE INDEX audit_events_actor_time_idx ON audit_events(actor_principal_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(available_at, occurred_at) WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE control_plane_imports (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  source_checksum text NOT NULL,
  source_backup_path text NOT NULL,
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_checksum)
);
