# Sample sandbox provider

This contract-only starter declares a namespaced Docker provider and all required capabilities. It intentionally cannot create or run workloads. Replace it with an isolated provider that enforces read-only base images, ephemeral overlays, resource limits, denied-by-default networking, ownership labels, collection allowlists, and verified cleanup.

Build with `npm install && npm run build`, then load the built package in a Worker. Import only the public `@agent-kernel/eval-sdk` root.
