# Security policy

## Supported versions

Agent RunLab is pre-1.0 software. Security fixes are made on the latest release
candidate and the default branch; older development snapshots are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private GitHub Security Advisory reporting flow and include the affected revision,
deployment variant, impact, and the smallest safe reproduction available. Do not
include production credentials, Session logs, private endpoints, or customer data.

The maintainers will acknowledge a report, validate its scope, coordinate a fix,
and publish remediation guidance when disclosure is safe. No response-time or bounty
commitment is implied by this policy.

## Deployment responsibility

Portable, Dedicated, and Private Cloud are all self-hosted. Operators remain
responsible for network exposure, TLS, identity configuration, secrets, backups,
provider terms, and timely upgrades. See [the security notes](security/README.md)
and [deployment contract](docs/architecture/deployment-mode-contract.md).
