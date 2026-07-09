# Releasing

Packages are published independently on tag push:

| Tag pattern      | Publishes                                                  |
| ---------------- | ---------------------------------------------------------- |
| `kernel-v*`      | `@agent-kernel/kernel`                                     |
| `host-v*`        | `@agent-kernel/host` (+ `shared`, `kernel` if newer)       |
| `executor-v*`    | `@agent-kernel/executor` (+ `shared`, `kernel` if newer)   |

`@agent-kernel/shared` is not tag-driven directly; it rides along with `host`
and `executor` because it is a transitive dep. `@agent-kernel/dashboard` is
not published — it is only served by the host as a static bundle.

## Cutting a release

```bash
# 1. Bump the version in the target package.json (and shared/kernel if their
#    surface changed).
pnpm --filter @agent-kernel/host exec npm version 0.2.0

# 2. Commit + tag with the matching name.
git commit -am "chore: release host 0.2.0"
git tag host-v0.2.0
git push origin main --tags
```

The `Publish to npm` workflow runs, builds, tests, verifies the tag version
matches `package.json`, and publishes with npm provenance.

Requires repo secret `NPM_TOKEN` scoped to `@agent-kernel`.

## Local dry run

```bash
pnpm run publish:kernel    # publishes kernel only
pnpm run publish:host      # publishes host (assumes shared+kernel already up)
pnpm run publish:executor  # publishes executor
pnpm run publish:all       # kernel → host → executor in order
```

Each calls the package's `publish:npm` script, which rebuilds first and then
runs `pnpm publish --access public --no-git-checks`.
