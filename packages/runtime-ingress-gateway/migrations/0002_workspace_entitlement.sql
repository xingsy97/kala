ALTER TABLE contract_entitlements
  ADD COLUMN IF NOT EXISTS workspace_limit integer NOT NULL DEFAULT 5 CHECK (workspace_limit > 0);
