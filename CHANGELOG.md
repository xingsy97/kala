# Changelog

All notable user-facing changes are recorded here. The project follows Semantic
Versioning while pre-1.0 and uses one product version across release artifacts.

## [Unreleased]

### Added

- Near-full-screen views for the workspace terminal and task graph.
- Portable, Dedicated, and Private Cloud deployment variants.
- Independent Platform Dashboard releases.
- Stable Ingress, blue/green Runtime slots, durable admission, planned Session
  continuation, and Supervisor-owned rollback for Dedicated.
- Digest-pinned multi-architecture Private Cloud images, native Linux operator
  bundles, independent Dashboard upgrades, and state-machine lifecycle receipts.
- Release asset integrity checks, explicit vulnerability policy, and managed
  Windows Executor service install/uninstall lifecycle.

### Changed

- README architecture narrative now presents the pure-function Agent Kernel,
  Agent Runtime, and cloud-native service as one complete system.
- Thinking titles remain visible when collapsed, and reasoning direction now
  precedes the tool activity it introduces.
- Dashboard navigation, title, Composer, Operations, Product Outputs, Pipeline,
  Memo, Settings, responsive states, and Chinese localization use the shared
  product UI system.

### Release target

- `v0.2.0-rc.14` after every gate in the public release readiness runbook passes.
- Kala branding and safer installation documentation; no automatic npm publishing.
