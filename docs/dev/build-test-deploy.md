# Build, Test, And Deploy

This runbook keeps common local and remote operations fast without adding many package scripts.

## Targeted Tests

Use `pnpm exec` inside the selected package when running a single Vitest file:

```bash
pnpm --filter @agent-kernel/host exec vitest run src/loop.test.ts
```

Avoid passing a file after the package `test` script:

```bash
pnpm --filter @agent-kernel/host test -- src/loop.test.ts
```

That form invokes the package script and can still run the full suite depending on how the script forwards arguments.

## TypeScript Builds

Package `tsconfig.json` files use incremental compiler metadata at `dist/.tsbuildinfo`. The cache is local build output and is ignored by git.

## Release Assets

Full local release build without native SEA assets:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native
```

Fast release rebundle after package and dashboard builds are already current:

```bash
pnpm run build:release-assets -- --repo <owner>/<repo> --no-native --skip-dashboard-build --skip-package-build
```

`--skip-dashboard-build` still requires `packages/dashboard/dist/index.html` to exist. If it is missing, the release script fails before producing a host bundle.

## Remote Deploy

Build release assets first, then deploy with explicit remote settings:

```bash
pnpm run deploy:remote -- \
  --ssh <ssh-target> \
  --host-url <host-url-reachable-from-remote> \
  --remote-bin <remote-bin-dir>
```

The deploy script uploads release assets to a timestamped directory under `--remote-bin`, backs up replaced files, installs the new files, then requests a graceful host restart through `/runtime/restart`.

Useful optional flags:

```bash
pnpm run deploy:remote -- \
  --ssh <ssh-target> \
  --host-url <host-url-reachable-from-remote> \
  --remote-bin <remote-bin-dir> \
  --restart-mode checkpoint \
  --restart-timeout-ms 600000 \
  --status-timeout-ms 660000
```

Equivalent environment variables are available for local shell aliases or CI secrets:

```bash
AK_DEPLOY_SSH=<ssh-target>
AK_DEPLOY_HOST_URL=<host-url-reachable-from-remote>
AK_DEPLOY_REMOTE_BIN=<remote-bin-dir>
```

Do not commit personal SSH targets, ports, or machine paths into package scripts or docs.
