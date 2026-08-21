# Server-Revocable Browser Session Architecture

**Status:** accepted design for implementation
**Owner:** Runtime ingress gateway
**Scope:** Private Cloud browser authentication only; Dedicated remains identity-free

## 1. Problem

The current gateway puts identity claims and expiry into an HMAC-signed `ak_session` cookie. It expires, but the server cannot revoke one browser, list active devices, disable an account immediately, or invalidate all sessions. Logout only removes the current browser cookie.

## 2. Browser cookie

The replacement cookie is an opaque 32-byte random bearer token:

```text
ak_session=<base64url(randomBytes(32))>
```

The server stores only `SHA-256(token)`. The cookie contains no identity, Unit ID, expiry, Provider token, or signing-key identifier.

Attributes:

```text
HttpOnly; SameSite=Lax; Path=/; Secure in HTTPS deployments
```

A legacy signed-claims cookie is rejected and cleared. Migration deliberately requires one new login rather than preserving the revocation gap.

## 3. Session record

```typescript
export type BrowserSession = {
  id: string
  tokenHash: string
  identity: AuthenticatedIdentity
  cacheNamespace: string
  device: {
    label: string
    userAgent?: string
  }
  createdAt: number
  lastSeenAt: number
  idleExpiresAt: number
  absoluteExpiresAt: number
  providerRefreshAfter?: number
  refreshToken?: EncryptedSecret
  refreshTokenExpiresAt?: number
  providerSessionId?: string
  revokedAt?: number
  revocationReason?: 'logout' | 'logout_all' | 'remote_logout' | 'expired' | 'refresh_failed' | 'administrator'
}
```

Defaults for the first file-backed implementation:

- idle lifetime: 24 hours;
- absolute lifetime: 30 days;
- touch persistence interval: 5 minutes;
- revoked-record diagnostic retention: 7 days;
- maximum records: 10,000.

`cacheNamespace` is derived from a separate stable namespace secret and `issuer + subject`; rotating Provider-token encryption keys must not change browser cache identity.

## 4. Store Port

```typescript
export interface BrowserSessionStore {
  create(input: CreateBrowserSessionInput): Promise<BrowserSession>
  findByTokenHash(tokenHash: string): Promise<BrowserSession | undefined>
  touch(sessionId: string, now: number, idleExpiresAt: number): Promise<BrowserSession | undefined>
  updateTokens(sessionId: string, expected: EncryptedSecret | undefined, update: UpdateBrowserSessionTokens): Promise<BrowserSession | undefined>
  listForIdentity(identity: AuthenticatedIdentity, now: number): Promise<readonly BrowserSession[]>
  revoke(sessionId: string, reason: BrowserSessionRevocationReason, now: number): Promise<boolean>
  revokeAllForIdentity(identity: AuthenticatedIdentity, reason: BrowserSessionRevocationReason, now: number, exceptSessionId?: string): Promise<number>
  prune(now: number): Promise<number>
}
```

The local implementation follows existing gateway persistence patterns: serialized mutations, atomic JSON replacement, `0700` directory and `0600` file. This remains a single-process store. Multiple gateway replicas require a transactional database implementation behind the same Port.

## 5. Provider credentials

OIDC callback returns identity plus optional refresh metadata. Refresh tokens are encrypted before persistence with AES-256-GCM and a key ID. Plaintext tokens never enter cookies, assignments, Unit storage, Host headers, Dashboard responses, logs, or error bodies.

Key rotation:

1. add a new key while retaining the old key;
2. mark it active;
3. decrypt and re-encrypt live records during store load;
4. persist atomically before readiness;
5. retain old keys through rollback and backup retention windows.

Concurrent rotating refresh uses compare-and-swap against the previous encrypted token. `invalid_grant` revokes the local Session; temporary Provider failures fail the request closed but keep the Session for bounded retry.

## 6. One authentication path

HTTP and WebSocket upgrades call the same `authenticateBrowserSession` service:

1. parse and length-check opaque cookie;
2. hash token and load record;
3. reject missing, revoked, idle-expired, or absolute-expired record;
4. refresh Provider state when due;
5. touch activity without excessive writes;
6. resolve immutable identity-to-Unit assignment;
7. verify issuer and subject match;
8. strip browser Cookie, Authorization, and attempted routing headers;
9. inject trusted internal Unit route and service credential.

This prevents HTTP and WebSocket authorization rules from drifting.

## 7. Routes

- `GET /auth/me`: profile, stable cache namespace, effective expiry; invalid cookies are cleared.
- `POST /auth/logout`: revoke current local Session first, clear cookies, best-effort Provider token revocation, then force actual login UI.
- `POST /auth/logout-all`: revoke every Session for the identity and clear the current cookie.
- `GET /auth/sessions`: safe device/session list with one current marker.
- `DELETE /auth/sessions/:id`: revoke an owned Session; foreign and unknown IDs both return 404.

All mutating routes require same-origin validation. Logout remains idempotent.

## 8. Required tests

- opaque token never persisted in plaintext;
- create/find/restart/revoke/revoke-all;
- same subject under different issuers remains isolated;
- idle/absolute expiry and bounded touch;
- concurrent mutations and refresh compare-and-swap;
- encrypted-secret tamper/unknown-key/rotation behavior;
- callback persists before issuing Cookie;
- server revocation immediately denies HTTP and WebSocket;
- two-browser logout-all;
- foreign Session deletion returns 404;
- Gateway restart and backup/restore;
- restore without required encryption key fails readiness;
- legacy stateless Cookie is rejected and cleared.

## 9. Migration and deployment

The first deployment invalidates current stateless cookies and requires re-login. The old session-signing secret is retained only for one rollback window, then removed. Backup sets must include browser-session storage, Provider-token encryption keys, and the stable cache-namespace secret.
