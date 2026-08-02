# Runtime Component Naming Migration

## Inventory

Technical names to remove:

- package `packages/runtime-ingress-gateway` / `@agent-kernel/runtime-ingress-gateway`;
- symbols `RuntimeIngressGateway`, `startRuntimeIngressGateway`;
- binary `agent-runlab-runtime-ingress`;
- technical environment prefixes `SAAS_GATEWAY_*`, `SAAS_HOST_*`, `SAAS_INGRESS_*`;
- Compose technical services/images containing `saas`.

Commercial/deployment terms allowed to remain:

- deployment mode value `saas` where externally persisted compatibility requires it;
- `deploy/saas/`, `scripts/saas-local/`, SaaS runbook/product prose;
- tests explicitly comparing Standalone and SaaS product capability modes.

## Target

- package: `packages/runtime-ingress-gateway`, `@agent-kernel/runtime-ingress-gateway`;
- symbols: `RuntimeIngressGateway`, `startRuntimeIngressGateway`;
- binary: `agent-runlab-runtime-ingress`;
- Host: `RuntimeHost`;
- in-process trusted selector: `RuntimeUnitIngress`;
- isolated service object: `TenantRuntimeUnit`;
- environment: `RUNTIME_INGRESS_*`, `RUNTIME_HOST_*`, `INGRESS_PUBLIC_ORIGIN`.

## Compatibility

Environment variables use one release of explicit fallback from new name to old name with startup warning; deployment docs and generated examples emit only new names. Public stored deployment mode remains compatible. Package, binary, symbol, service and image names have no compatibility alias after all workspace references migrate atomically.
