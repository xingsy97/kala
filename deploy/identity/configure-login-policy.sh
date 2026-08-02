#!/bin/sh
set -eu

: "${IDENTITY_DOMAIN:=<identity-domain>}"
: "${ZITADEL_ADMIN_PAT_FILE:=/run/secrets/zitadel_admin_pat}"

pat=$(cat "$ZITADEL_ADMIN_PAT_FILE")
curl --fail --silent --show-error \
  --request PUT "https://${IDENTITY_DOMAIN}/admin/v1/policies/login" \
  --header "Authorization: Bearer ${pat}" \
  --header 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "allowUsernamePassword": true,
  "allowRegister": true,
  "allowExternalIdp": true,
  "forceMfa": false,
  "passwordlessType": "PASSWORDLESS_TYPE_ALLOWED",
  "hidePasswordReset": false,
  "ignoreUnknownUsernames": false,
  "allowDomainDiscovery": true,
  "passwordCheckLifetime": "864000s",
  "externalLoginCheckLifetime": "864000s",
  "mfaInitSkipLifetime": "2592000s",
  "secondFactorCheckLifetime": "64800s",
  "multiFactorCheckLifetime": "43200s"
}
JSON
