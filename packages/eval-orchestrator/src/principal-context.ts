import { AsyncLocalStorage } from 'node:async_hooks'

import type { Principal } from '@agent-kernel/eval-protocol'

const principals = new AsyncLocalStorage<Principal>()

export function runAsPrincipal<T>(principal: Principal, action: () => T): T {
  return principals.run(principal, action)
}

export function currentPrincipal(): Principal | undefined {
  return principals.getStore()
}
