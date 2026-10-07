-- A trusted principal must resolve to at most one active organization/runtime unit.
-- Stop before creating the index when legacy data is ambiguous: choosing a tenant
-- automatically would be an unsafe cross-tenant authorization decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM organization_memberships
    WHERE status = 'active'
    GROUP BY principal_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot enforce one active organization per principal: ambiguous active memberships exist'
      USING ERRCODE = 'check_violation',
            HINT = 'Identify affected principals with: SELECT principal_id, array_agg(organization_id ORDER BY organization_id) FROM organization_memberships WHERE status = ''active'' GROUP BY principal_id HAVING count(*) > 1; remediate each assignment explicitly, then rerun the migration.';
  END IF;
END
$$;

CREATE UNIQUE INDEX organization_memberships_active_principal_uidx
  ON organization_memberships(principal_id)
  WHERE status = 'active';
