# SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text v2

**Status**: designed, not yet implemented
**Owner**: TBD
**Companion doc**: [mcp.md](mcp.md)

---

## 1. Context

**translated historical texttranslated historical text**：translated historical text `agent-kernel` translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text"**translated historical texttranslated historical texttranslated historical texttranslated historical text host**（agent brain translated historical texttranslated historical text + dashboard）+ **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**（GitHub OAuth）+ **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor**（translated historical texttranslated historical texttranslated historical texttranslated historical text）"translated historical text SaaS translated historical texttranslated historical text。

**Why**：

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（kernel translated historical texttranslated historical texttranslated historical texttranslated historical text / executor translated historical texttranslated historical texttranslated historical texttranslated historical text）translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text brain + translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text API key，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；host translated historical texttranslated historical texttranslated historical text brain translated historical texttranslated historical texttranslated historical text。
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：docker-compose translated historical texttranslated historical texttranslated historical text host + executor translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**，translated historical texttranslated historical texttranslated historical texttranslated historical text plan。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text §16 Phased rollout translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。

### v2 vs v1 translated historical texttranslated historical texttranslated historical text

v1 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text `userId` translated historical texttranslated historical texttranslated historical texttranslated historical text host core（server / store / connection）。**v2 translated historical texttranslated historical texttranslated historical texttranslated historical text**：

1. **translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `packages/platform/` translated historical text，host core translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `userId` translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text platform translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text agent translated historical texttranslated historical texttranslated historical texttranslated historical text"—— core translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text"userId translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text。
2. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical text §"Frontend interaction design"，translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text flow / translated historical texttranslated historical texttranslated historical texttranslated historical text / empty state / error state / translated historical text-translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UI translated historical texttranslated historical text。

## 2. Decisions locked in

| # | translated historical text | translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|---|
| 1 | Auth | GitHub OAuth | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、username translated historical texttranslated historical text |
| 2 | LLM translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | Host translated historical text（translated historical texttranslated historical text A） | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text Settings translated historical text key，host translated historical texttranslated historical texttranslated historical texttranslated historical text |
| 3 | API key translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text `users/<id>/settings.json`，`0600` translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 4 | Session translated historical texttranslated historical text | `sessions/<userId>/*.jsonl` translated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical text DB；translated historical texttranslated historical texttranslated historical texttranslated historical text JSONL translated historical texttranslated historical text |
| 5 | Executor translated historical texttranslated historical text | PAT + hash translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical text + revoke；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor | translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 6 | translated historical texttranslated historical text executor translated historical texttranslated historical text approval | `ask`（translated historical text `auto`） | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 7 | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical text | SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 8 | Host translated historical texttranslated historical texttranslated historical texttranslated historical text / E2E translated historical texttranslated historical text | non-goal | translated historical text kernel translated historical texttranslated historical texttranslated historical texttranslated historical text + replay/fork translated historical texttranslated historical texttranslated historical text |
| 9 | translated historical texttranslated historical texttranslated historical texttranslated historical text OAuth | `AK_DEV_USER` translated historical texttranslated historical text + translated historical text OAuth App | translated historical texttranslated historical text 0 translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 10 | translated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical text | translated historical text DB translated historical text Redis |
| 11 | Rate limit | translated historical texttranslated historical texttranslated historical text 10 translated historical texttranslated historical text tool_call + 60 req/min LLM | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 12 | **core/platform translated historical texttranslated historical text** | **translated historical texttranslated historical text `packages/platform/`，host core translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text userId** | **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text core translated historical texttranslated historical texttranslated historical text** |
| 13 | Multi-tenant translated historical texttranslated historical text | `AK_PLATFORM=1` env translated historical text platform translated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical text import；translated historical texttranslated historical texttranslated historical text legacy translated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 14 | translated historical texttranslated historical text UI translated historical texttranslated historical text | translated historical texttranslated historical text Explorer + Workbench translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical text user chip translated historical text Explorer translated historical texttranslated historical text；Settings translated historical texttranslated historical text tab | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 15 | translated historical texttranslated historical text platform translated historical texttranslated historical texttranslated historical texttranslated historical text | dashboard `features/auth/` translated historical texttranslated historical text + translated historical texttranslated historical text SettingsDialog translated historical texttranslated historical text tab；translated historical text `useUser()` context translated historical texttranslated historical text | translated historical text dashboard translated historical texttranslated historical texttranslated historical text |

## 3. Layered architecture

```
┌───────────────────────────────────────────────────────────┐
│                Dashboard (React SPA)                       │
│                                                             │
│  Core UI (chat / inspector / explorer / settings / ...)    │
│    ↑                                                        │
│  Platform UI overlay (login gate / user menu /             │
│     machines panel / providers panel / welcome page)       │
│    ↑                                                        │
│  `useUser()` context — provides { id, login, avatarUrl }   │
│     or `null` (single-user mode)                            │
└───────────────────────────────────────────────────────────┘
                        │  HTTP + Socket.IO
                        ▼
┌───────────────────────────────────────────────────────────┐
│                @agent-kernel/platform  (new package)       │
│                                                             │
│  HTTP router (/auth/*, /api/*)                             │
│  Cookie session store   PAT store   User store             │
│  ContextResolver — the SINGLE seam into core               │
│    resolve(request) → SessionContext                       │
│  User-scoped rate limiter                                  │
│  User adapter cache (LRU per userId)                       │
└──────────────────────┬────────────────────────────────────┘
                       │  SessionContext (opaque to platform)
                       ▼
┌───────────────────────────────────────────────────────────┐
│                @agent-kernel/host  (unchanged in shape)    │
│                                                             │
│  server.ts: middleware receives injected SessionContext    │
│             from platform (or default context in            │
│             single-user mode) — never sees userId           │
│  store/session.ts: takes `sessionsDir` from context         │
│  connection/executor.ts: takes `executorFilter` predicate   │
│  loop.ts: takes `llmRegistry` from context per session      │
└──────────────────────┬────────────────────────────────────┘
                       ▼
┌───────────────────────────────────────────────────────────┐
│                @agent-kernel/kernel  (never changes)       │
│                pure FSM, no IO, no identity                 │
└───────────────────────────────────────────────────────────┘
```

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text IO（LLM、tool call、translated historical texttranslated historical texttranslated historical texttranslated historical text）translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text——translated historical text**translated historical texttranslated historical text platform translated historical texttranslated historical texttranslated historical text**。translated historical texttranslated historical texttranslated historical text kernel + host + executor translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "userId" translated historical texttranslated historical texttranslated historical text。

## 4. The core / platform seam

### 4.1 SessionContext + ContextResolver

`packages/host/src/context.ts`（translated historical texttranslated historical text，~30 translated historical text）：

```ts
export type SessionContext = {
  readonly sessionsDir: string
  readonly llmRegistry: LLMRegistry
  readonly toolTimeoutMs?: number
  readonly executorFilter?: (bind: ExecutorBind) => boolean
  readonly rateLimiter?: RateLimiter
}

export type ContextResolver = {
  // translated historical texttranslated historical text null → translated historical texttranslated historical texttranslated historical text，socket / http translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
  resolveDashboard(handshake: HandshakeAuth, cookies: string): Promise<SessionContext | null>
  resolveExecutor(handshake: HandshakeAuth): Promise<SessionContext | null>
  resolveHttp(req: IncomingMessage): Promise<SessionContext | null>
}

export const DEFAULT_SINGLE_USER_RESOLVER: ContextResolver = /* translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text context */
```

Host `startHostServer({ ..., contextResolver })` translated historical text resolver。**core translated historical texttranslated historical texttranslated historical text handler translated historical text `socket.data.ctx` translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text userId**。

### 4.2 Platform translated historical texttranslated historical texttranslated historical texttranslated historical text

Platform translated historical texttranslated historical texttranslated historical text `ContextResolver`：

- **resolveDashboard**：translated historical text cookie → translated historical text UserStore → translated historical texttranslated historical text `{ sessionsDir: sessionsRoot/<id>, llmRegistry: userAdapterCache.get(id), executorFilter: bind => bind.metadata?.userId === id, rateLimiter: perUserLimiter.for(id) }`
- **resolveExecutor**：translated historical text PAT → translated historical text PatStore → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **resolveHttp**：translated historical text cookie → translated historical text `/api/*` translated historical text

### 4.3 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

- **translated historical texttranslated historical text**：core translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `DEFAULT_SINGLE_USER_RESOLVER`，translated historical texttranslated historical text mock translated historical texttranslated historical text / OAuth
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text platform translated historical text Kubernetes-style tenancy，translated historical texttranslated historical texttranslated historical text ContextResolver，core translated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical text kernel + host + executor translated historical texttranslated historical texttranslated historical text，platform/ translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；ARCHITECTURE.md translated historical texttranslated historical texttranslated historical text"userId"translated historical texttranslated historical texttranslated historical text

## 5. Package layout

translated historical texttranslated historical text `packages/platform/`：

```
packages/platform/
├── package.json                     name: @agent-kernel/platform
├── src/
│   ├── index.ts                     export startPlatform()
│   ├── context-resolver.ts          translated historical texttranslated historical text ContextResolver
│   ├── auth/
│   │   ├── github-oauth.ts          OAuth translated historical texttranslated historical texttranslated historical text
│   │   ├── cookie-session.ts        cookie translated historical texttranslated historical text
│   │   └── oauth-state.ts           CSRF state translated historical texttranslated historical texttranslated historical text
│   ├── stores/
│   │   ├── user-store.ts            users/<id>/profile.json
│   │   ├── pat-store.ts             users/<id>/pats.json
│   │   ├── user-settings-store.ts   users/<id>/settings.json (translated historical text apiKey)
│   │   └── cookie-store.ts          cookie-sessions.json
│   ├── llm/
│   │   └── user-adapter-cache.ts    LRU per userId
│   ├── rate-limit/
│   │   └── per-user-limiter.ts
│   ├── http/
│   │   ├── router.ts                translated historical text /auth/* + /api/*
│   │   ├── auth-github.ts           /auth/github/{start,callback}, /auth/logout
│   │   ├── me.ts                    /api/me
│   │   ├── pats.ts                  /api/pats
│   │   ├── providers.ts             /api/providers
│   │   └── machines.ts              /api/machines
│   ├── executor-registry.ts         translated historical texttranslated historical text userId translated historical text Bind + translated historical texttranslated historical texttranslated historical texttranslated historical text
│   └── remote-approval.ts           translated historical texttranslated historical texttranslated historical texttranslated historical text executor + translated historical texttranslated historical text ask
├── test/
└── README.md
```

`packages/host/` translated historical texttranslated historical texttranslated historical texttranslated historical text：

- translated historical texttranslated historical text `src/context.ts`（~30 translated historical text）
- `server.ts` middleware translated historical texttranslated historical texttranslated historical text `contextResolver.resolveXxx()`；handler translated historical text `socket.data.ctx` translated historical texttranslated historical texttranslated historical text
- `store/session.ts` translated historical texttranslated historical text `sessionsDir` translated historical text context translated historical texttranslated historical text
- `connection/executor.ts` `Bind` translated historical text `metadata: unknown` translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text `executorFilter?: (bind) => boolean` translated historical texttranslated historical text
- `loop.ts` translated historical text context translated historical text `llmRegistry`

`packages/host/bin/agent-kernel-host.ts` translated historical texttranslated historical texttranslated historical texttranslated historical text：

```ts
import { DEFAULT_SINGLE_USER_RESOLVER } from '../src/context.js'

let contextResolver = DEFAULT_SINGLE_USER_RESOLVER
if (process.env.AK_PLATFORM === '1') {
  const { startPlatform } = await import('@agent-kernel/platform')
  const platform = await startPlatform({ sessionsRoot, oauthConfig, ... })
  contextResolver = platform.contextResolver
  server.mountHttpRouter('/auth', platform.authRouter)
  server.mountHttpRouter('/api', platform.apiRouter)
}
await startHostServer({ ..., contextResolver })
```

**translated historical texttranslated historical text import** translated historical texttranslated historical texttranslated historical text platform translated historical texttranslated historical texttranslated historical texttranslated historical text build（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text）。

## 6. Identity & auth flow

### 6.1 translated historical texttranslated historical texttranslated historical texttranslated historical text（cookie session）

```
1. Browser → GET https://ak.you.com/
   host translated historical text cookie → 302 → /welcome

2. /welcome translated historical texttranslated historical texttranslated historical texttranslated historical text "Sign in with GitHub"
   → GET /auth/github/start
   → 302 translated historical text GitHub OAuth authorize URL
   (state=random opaque translated historical text in-memory translated historical text CSRF)

3. GitHub → callback https://ak.you.com/auth/github/callback?code=...&state=...
   platform translated historical texttranslated historical text state；POST code → GitHub token endpoint → access_token
   GET https://api.github.com/user → { id: 12345, login, avatar_url }

4. Platform:
   - translated historical text/translated historical texttranslated historical text users/12345/profile.json = { login, avatarUrl, updatedAt }
   - translated historical texttranslated historical text ak_sid = crypto.randomBytes(32).toString('hex')
   - translated historical texttranslated historical text map: ak_sid → { userId: 12345, expiresAt: +30d }
   - translated historical texttranslated historical text cookie-sessions.json = translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical text）
   - Set-Cookie: ak_sid=xxx; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
   - 302 → /

5. Browser → GET / with cookie → dashboard translated historical texttranslated historical text
   fetch('/api/me') → platform translated historical text cookie map → { id: 12345, login, avatarUrl }
```

**translated historical texttranslated historical text**：`POST /auth/logout` → translated historical text cookie + translated historical text map translated historical text。
**translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical text cookie translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text < 7 translated historical texttranslated historical texttranslated historical texttranslated historical text +30d。
**Cookie translated historical texttranslated historical text**：translated historical texttranslated historical text map + translated historical text 5 translated historical texttranslated historical text flush translated historical text `~/.agent-kernel/cookie-sessions.json`（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。

### 6.2 Executor translated historical texttranslated historical text（PAT）

**translated historical texttranslated historical texttranslated historical text PAT**：Personal Access Token —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（`ak_pat_<64 hex>`），translated historical texttranslated historical text"translated historical texttranslated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical text SSH translated historical texttranslated historical texttranslated historical texttranslated historical text：

| translated historical texttranslated historical text | SSH | translated historical texttranslated historical texttranslated historical text |
|---|---|---|
| translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | `~/.ssh/id_ed25519`（translated historical texttranslated historical text） | executor CLI `--pat`（translated historical texttranslated historical text） |
| translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | `~/.ssh/authorized_keys`（translated historical texttranslated historical text） | `users/<id>/pats.json`（hash） |
| translated historical texttranslated historical text | translated historical text `authorized_keys` translated historical texttranslated historical texttranslated historical text | Dashboard translated historical texttranslated historical text revoke |

**translated historical texttranslated historical text**：

```
1. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text dashboard，translated historical text Settings → Machines → "Add machine"
   dashboard POST /api/pats { label: 'my-laptop' } (cookie auth)
   platform:
   - pat = 'ak_pat_' + crypto.randomBytes(32).toString('hex')  // 64 hex chars
   - hash = sha256(pat)
   - translated historical texttranslated historical texttranslated historical text users/12345/pats.json:
       { id: ulid(), hash, label, createdAt, lastSeenAt: null, revoked: false }
   - translated historical texttranslated historical text { pat }  // translated historical texttranslated historical text PAT，translated historical texttranslated historical texttranslated historical texttranslated historical text
   dashboard translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + CLI translated historical texttranslated historical texttranslated historical texttranslated historical text

2. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text CLI
   executor Socket.IO connect → auth = { role: 'executor', pat: 'ak_pat_...', clientVersion }

3. Platform.resolveExecutor:
   - hash = sha256(pat)
   - translated historical texttranslated historical texttranslated historical texttranslated historical text hash → { userId, patId } translated historical texttranslated historical texttranslated historical text
   - translated historical texttranslated historical text → translated historical texttranslated historical text SessionContext（translated historical text executorFilter translated historical texttranslated historical texttranslated historical text user translated historical text bind）
   - translated historical texttranslated historical text pats.json translated historical text lastSeenAt
   - translated historical texttranslated historical texttranslated historical texttranslated historical text revoked → translated historical text null → socket translated historical text

4. Host translated historical text executor.ts translated historical texttranslated historical text SessionContext，translated historical text bind.metadata = { userId, patId } translated historical texttranslated historical texttranslated historical text
   translated historical texttranslated historical texttranslated historical text user translated historical text dashboard translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text bind
```

**Revoke**：`DELETE /api/pats/:id` → platform translated historical texttranslated historical text `revoked=true` → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor bind → platform translated historical texttranslated historical text disconnect。

**translated historical texttranslated historical text**：`GET /api/pats` translated historical texttranslated historical text `{ id, label, createdAt, lastSeenAt, revoked, connected }[]`；**translated historical texttranslated historical texttranslated historical texttranslated historical text hash translated historical text PAT translated historical texttranslated historical text**。

## 7. Data model & storage

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：

```
~/.agent-kernel/
├── cookie-sessions.json          # ak_sid → { userId, expiresAt }
├── users/
│   └── 12345/                    # GitHub numeric id
│       ├── profile.json          # { login, avatarUrl, updatedAt }
│       ├── settings.json         # { providers[], defaultModel }  # translated historical text apiKey，0600
│       └── pats.json             # PAT records (hash only)
└── sessions/
    ├── *.jsonl                   # translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（legacy translated historical texttranslated historical text）
    └── 12345/                    # translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
        └── 2026-07-06T10-00-00_<uuid>.jsonl
```

**Legacy**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `sessions/*.jsonl` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `sessions/<id>/` translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text `AK_PLATFORM=1` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text JSONL，translated historical texttranslated historical text warn；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text userId translated historical texttranslated historical texttranslated historical texttranslated historical text）。

**File permissions**：translated historical texttranslated historical text `users/<id>/*` translated historical texttranslated historical text `0600`；translated historical texttranslated historical text `0700`。

**translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Map translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical text）。

## 8. Wire protocol changes

### 8.1 `HandshakeAuth` translated historical text discriminated union

translated historical texttranslated historical text `packages/shared/src/protocol.ts`：

```ts
export type HandshakeAuth = {
  role: ClientRole
  sessionId?: string
  token?: string
  clientVersion: string
}
```

translated historical texttranslated historical text：

```ts
export type DashboardHandshakeAuth = {
  role: 'dashboard'
  sessionId: string
  clientVersion: string
  // translated historical text token translated historical texttranslated historical text：dashboard translated historical texttranslated historical text HTTP cookie（Socket.IO withCredentials）
}

export type ExecutorHandshakeAuth = {
  role: 'executor'
  pat?: string          // translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
  token?: string        // translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text legacy HOST_AUTH_TOKEN
  clientVersion: string
}

export type HandshakeAuth = DashboardHandshakeAuth | ExecutorHandshakeAuth
```

**translated historical texttranslated historical texttranslated historical text**：Slice E translated historical texttranslated historical texttranslated historical text `token`；Slice E translated historical text platform translated historical texttranslated historical texttranslated historical text `pat` translated historical texttranslated historical text，`token` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 8.2 translated historical texttranslated historical text HTTP endpoints

translated historical texttranslated historical texttranslated historical text platform translated historical texttranslated historical texttranslated historical text：

| Endpoint | Auth | translated historical texttranslated historical text |
|---|---|---|
| `GET /welcome` | none | translated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical text HTML translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text） |
| `GET /auth/github/start` | none | 302 translated historical text GitHub OAuth |
| `GET /auth/github/callback` | none (state translated historical texttranslated historical text) | translated historical texttranslated historical text OAuth |
| `POST /auth/logout` | cookie | translated historical text cookie |
| `GET /api/me` | cookie | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| `GET /api/host-info` | none | translated historical texttranslated historical texttranslated historical text label translated historical text，translated historical text /welcome translated historical texttranslated historical text |
| `GET /api/pats` | cookie | translated historical texttranslated historical text PAT metadata |
| `POST /api/pats` | cookie | translated historical texttranslated historical text PAT，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| `DELETE /api/pats/:id` | cookie | Revoke |
| `GET /api/providers` | cookie | translated historical text provider（translated historical text key） |
| `PUT /api/providers/:id` | cookie | translated historical texttranslated historical text provider（translated historical text key） |
| `DELETE /api/providers/:id` | cookie | translated historical texttranslated historical text provider |
| `GET /api/machines` | cookie | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor（translated historical texttranslated historical texttranslated historical texttranslated historical text） |

Host translated historical texttranslated historical texttranslated historical text `GET /settings` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical text paths、mcp note）；user translated historical texttranslated historical texttranslated historical text `/api/providers`。

### 8.3 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**Core translated historical texttranslated historical text**：translated historical texttranslated historical text `client:*` handler translated historical text `socket.data.ctx` translated historical text `sessionsDir`；session id translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text sessionId translated historical texttranslated historical texttranslated historical text `ctx.sessionsDir` translated historical texttranslated historical texttranslated historical text）。**translated historical texttranslated historical text userId translated historical texttranslated historical text**。

**Platform translated historical texttranslated historical text**：ContextResolver translated historical texttranslated historical text `ctx.sessionsDir` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；executor translated historical texttranslated historical texttranslated historical text `ctx.executorFilter?.(bind)` translated historical texttranslated historical text。

## 9. Provider & LLM adapter (per-user)

### 9.1 Storage

`users/<id>/settings.json`：

```json
{
  "providers": [
    {
      "id": "anthropic-default",
      "label": "Anthropic",
      "wire": "anthropic",
      "apiKey": "sk-ant-...",
      "models": ["claude-opus-4-8", "claude-sonnet-4-6"]
    },
    {
      "id": "openai-default",
      "label": "OpenAI",
      "wire": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o", "gpt-4o-mini"]
    }
  ],
  "defaultModel": "claude-opus-4-8"
}
```

### 9.2 Adapter cache

`packages/platform/src/llm/user-adapter-cache.ts`：

- Key: `userId`
- Value: `{ adapters: Map<model, LLMAdapter>, defaultModel: string, mtime: number }`
- LRU translated historical texttranslated historical text 100 translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text build；`settings.json` mtime translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- ContextResolver translated historical text `llmRegistry: cache.get(userId)` translated historical texttranslated historical text core

**translated historical text provider translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text provider → `ctx.llmRegistry.adapters` translated historical texttranslated historical text → session ready translated historical text `state:ready` translated historical texttranslated historical text `warnings: ['no_provider_configured']` → dashboard translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### 9.3 Host runtime-config translated historical texttranslated historical text

translated historical text `packages/host/src/runtime-config.ts` translated historical texttranslated historical text，**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical text `~/.claude/settings.json` / `~/.codex/config.toml`。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `AK_PLATFORM=1`，host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical text key）。

## 10. Approval defaults

translated historical texttranslated historical text executor translated historical texttranslated historical text `approvalMode = 'ask'`。translated historical texttranslated historical text"translated historical texttranslated historical text"：executor announce translated historical texttranslated historical texttranslated historical text `hostname + ipAddresses`；platform translated historical texttranslated historical text，session translated historical texttranslated historical texttranslated historical texttranslated historical text workspace translated historical texttranslated historical texttranslated historical texttranslated historical text executor → translated historical texttranslated historical text `approvalMode = 'ask'`；translated historical texttranslated historical texttranslated historical texttranslated historical text `auto`。

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `packages/platform/src/remote-approval.ts`；core translated historical text session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `initialApprovalMode` translated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text），platform translated historical texttranslated historical text `SessionContext` translated historical texttranslated historical texttranslated historical texttranslated historical text hook translated historical texttranslated historical text。

## 11. Rate limiting

`packages/platform/src/rate-limit/per-user-limiter.ts`：

- Concurrent tool_call ≤ 10：`callTool` translated historical texttranslated historical text pending translated historical text，translated historical texttranslated historical text → translated historical texttranslated historical text；FIFO；~5s timeout
- LLM req/min ≤ 60：translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text → `llm_error { kind: 'rate_limited_by_platform', retryAfterMs }`

Core `loop.ts` translated historical text `ctx.rateLimiter?.checkOrThrow('tool_call' | 'llm')`，`?.` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

## 12. Frontend interaction design

translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text **Explorer（translated historical text）+ Workbench（translated historical text）translated historical texttranslated historical texttranslated historical texttranslated historical text** translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text。

### 12.1 Entry-to-daily flow

```
[translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text]
   │
   ▼
GET / ──► 302 /welcome (translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)
                │
                │  translated historical texttranslated historical texttranslated historical text "Sign in with GitHub"
                ▼
       /auth/github/start ──► GitHub OAuth ──► /auth/github/callback
                                                     │
                                                     ▼
                                        302 /  (translated historical text ak_sid cookie)
                                                     │
                                                     ▼
                             ┌──────────────────────────────────────┐
                             │  Dashboard translated historical texttranslated historical texttranslated historical texttranslated historical text                    │
                             │  fetch /api/me → OK                   │
                             │  fetch /api/providers → translated historical text             │
                             │  fetch /api/pats → translated historical text                  │
                             │  render dashboard translated historical texttranslated historical texttranslated historical text              │
                             │  translated historical texttranslated historical texttranslated historical texttranslated historical text empty state translated historical texttranslated historical text:            │
                             │    · "Add API key to start"           │
                             │    · "Add machine to run commands"    │
                             └──────────────────────────────────────┘
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              │                                              │
                              ▼                                              ▼
                    Settings → Providers                        Settings → Machines
                              │                                              │
                              ▼                                              ▼
                      translated historical text API key & save                            Add machine → translated historical text PAT
                                                                              │
                                                                              ▼
                                                       translated historical texttranslated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical text executor
                                                                              │
                                                                              ▼
                                              Machines panel translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
                                                                              │
                              └──────────────────────┬───────────────────────┘
                                                     ▼
                                       translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
```

### 12.2 Page inventory

translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text modal / drawer：

| Path | Purpose | Auth required |
|---|---|---|
| `/welcome` | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + "Sign in with GitHub" translated historical texttranslated historical text | no |
| `/auth/github/callback` | OAuth translated historical texttranslated historical text，302 translated historical text `/` | no（translated historical text state translated historical texttranslated historical text） |
| `/` | Dashboard translated historical texttranslated historical texttranslated historical text（Explorer + Workbench） | yes（translated historical texttranslated historical texttranslated historical text 302 translated historical text `/welcome`） |

**translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical text settings translated historical text（translated historical texttranslated historical text modal）。translated historical texttranslated historical text：Settings translated historical texttranslated historical texttranslated historical text flow，modal translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical text router translated historical texttranslated historical text ADR 0013 "URL query params only" translated historical texttranslated historical texttranslated historical text。

### 12.3 `/welcome` page

```
┌───────────────────────────────────────────────────────────────┐
│                                                                │
│         [agent-kernel logo/wordmark]                           │
│                                                                │
│   Open-source coding agent · run anywhere · read every event  │
│                                                                │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  Before you sign in                                  │    │
│   │                                                       │    │
│   │  What this host sees:                                │    │
│   │  · Your conversations, tool outputs, uploaded files │    │
│   │  · Your Anthropic/OpenAI API key (memory only,      │    │
│   │    never logged)                                     │    │
│   │  · Which machines you've paired via access token    │    │
│   │                                                       │    │
│   │  What this host cannot see:                          │    │
│   │  · Anything outside your executor's sandbox roots   │    │
│   │  · Your GitHub password                              │    │
│   │                                                       │    │
│   │  Prefer to self-host? [Docker guide]                 │    │
│   └─────────────────────────────────────────────────────┘    │
│                                                                │
│         [   Sign in with GitHub   ]                            │
│                                                                │
│   By signing in you agree the operator (that's [name]) can   │
│   see your conversation content. This is not Claude/OpenAI. │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

**Behavior**：

- "Sign in with GitHub" → `window.location = '/auth/github/start?next=/'`
- "Docker guide" translated historical texttranslated historical texttranslated historical text `docs/deploy.md`
- translated historical texttranslated historical text `[name]` translated historical text `/api/host-info` translated historical text（host translated historical texttranslated historical texttranslated historical texttranslated historical text env `HOST_OPERATOR_LABEL='ak.you.com'`）

### 12.4 Dashboard layout evolution

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：

```
┌─────────────────┬──────────────────────────────────────────┐
│                 │  Workbench                                │
│  Explorer       │  ┌────────────────────────────────────┐  │
│   (workspaces × │  │ WorkbenchToolbar                    │  │
│    sessions)    │  │  [session label · cwd · status]     │  │
│                 │  │  [inspector btn · theme · ...]       │  │
│                 │  └────────────────────────────────────┘  │
│                 │  ChatPanel                               │
│                 │  Composer                                │
│                 │  Inspector (drawer)                      │
└─────────────────┴──────────────────────────────────────────┘
```

**Platform mode translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**（translated historical texttranslated historical texttranslated historical texttranslated historical text）：

1. **Explorer translated historical texttranslated historical texttranslated historical text user chip**：translated historical texttranslated historical texttranslated historical texttranslated historical text + login，translated historical texttranslated historical texttranslated historical texttranslated historical text dropdown（Settings / Sign out）。
2. **Explorer translated historical texttranslated historical texttranslated historical text "Add machine +" translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical text Machines tab modal。

```
Explorer（platform mode）：
┌─────────────────────────────────┐
│ [avatar] zhangsan  ▾            │  ← translated historical texttranslated historical text user chip
│─────────────────────────────────│
│ + New session                    │
│                                  │
│ ▸ my-laptop (2 sessions)          │
│   ● debug PR      · 3m ago       │
│   ● fix bug 42    · 1h ago       │
│                                  │
│ ▸ fly-prod (offline)              │
│   ○ deploy check  · yesterday    │
│                                  │
│  Add machine +                   │  ← translated historical texttranslated historical text
└─────────────────────────────────┘
```

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：Explorer translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text user chip），translated historical text Machines translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical text `<Explorer>` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical text `useUser()` context translated historical texttranslated historical text null translated historical texttranslated historical text。

### 12.5 Empty states

| translated historical texttranslated historical text | UI |
|---|---|
| translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical text provider，translated historical text machine | Workbench translated historical texttranslated historical texttranslated historical text empty state translated historical texttranslated historical text："Set up in 2 steps → 1. Add API key 2. Add machine"，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Settings translated historical texttranslated historical text tab |
| translated historical text provider，translated historical text machine | Workbench translated historical texttranslated historical text："You have API keys ready. Add a machine to run commands." |
| translated historical text machine，translated historical text provider | Workbench translated historical texttranslated historical text："You have `my-laptop` connected. Add an API key to send messages." |
| Machine translated historical texttranslated historical text offline | Explorer translated historical text machine translated historical texttranslated historical texttranslated historical text `(offline)` + toolbar status pill："Executor offline. Start it: `agent-kernel-executor ...`"（translated historical texttranslated historical texttranslated historical texttranslated historical text） |
| Provider translated historical texttranslated historical texttranslated historical text API call translated historical texttranslated historical text（wrong key / 429） | ActivityBar translated historical texttranslated historical texttranslated historical text banner："Provider `openai-default` returned 401. Check API key in Settings." |

### 12.6 Modals & panels (new)

**Settings > Providers tab**（translated historical texttranslated historical texttranslated historical texttranslated historical text Models translated historical texttranslated historical text）：

```
┌────────────────────────────────────────────────────────┐
│ Providers                                               │
│                                                         │
│ Bring your own key. Keys stay in host memory, never   │
│ written to disk.                                       │
│                                                         │
│ ┌────────────────────────────────────────────────┐    │
│ │ Anthropic                                 [x]  │    │
│ │  API key   [•••••••••••••••••••••••] [show]   │    │
│ │  Base URL  https://api.anthropic.com          │    │
│ │  Models    claude-opus-4-8, claude-sonnet...  │    │
│ │                                       [Save]  │    │
│ └────────────────────────────────────────────────┘    │
│                                                         │
│ [+ Add provider]                                       │
└────────────────────────────────────────────────────────┘
```

- API key input `type=password`，"show" translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- Save translated historical text `PUT /api/providers/:id`，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text "Saved" translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text error toast
- translated historical texttranslated historical text [x] translated historical text confirm dialog
- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：translated historical texttranslated historical text Providers translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical text read-only translated historical texttranslated historical text）

**Settings > Machines tab**（translated historical texttranslated historical text）：

```
┌────────────────────────────────────────────────────────┐
│ Machines                                                │
│                                                         │
│ Each machine runs an executor that dials this host    │
│ and provides shell / filesystem access.               │
│                                                         │
│ ┌────────────────────────────────────────────────┐    │
│ │ ● my-laptop         Last seen 2m ago    [Revoke]│    │
│ │   Created Jun 1 · linux · 192.0.2.10          │    │
│ └────────────────────────────────────────────────┘    │
│                                                         │
│ ┌────────────────────────────────────────────────┐    │
│ │ ○ fly-prod          Last seen 3d ago    [Revoke]│    │
│ │   Created May 20 · linux · fly.io               │    │
│ └────────────────────────────────────────────────┘    │
│                                                         │
│ [+ Add machine]                                        │
└────────────────────────────────────────────────────────┘
```

- translated historical texttranslated historical texttranslated historical text：● translated historical texttranslated historical text（socket translated historical text）/ ◐ translated historical texttranslated historical text 5min translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / ○ translated historical texttranslated historical texttranslated historical texttranslated historical text
- Revoke translated historical text confirm dialog；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text API + translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**"New machine" modal**（translated historical texttranslated historical texttranslated historical text）：

```
Step 1 — translated historical texttranslated historical text：
┌────────────────────────────────────────────────────────┐
│ Pair a new machine                                     │
│                                                         │
│ Give it a name (only you see this):                   │
│  [ my-laptop                                    ]      │
│                                                         │
│                                     [Cancel] [Create]  │
└────────────────────────────────────────────────────────┘

Step 2 — translated historical texttranslated historical text token translated historical texttranslated historical texttranslated historical text：
┌────────────────────────────────────────────────────────┐
│ ✓ Token created for "my-laptop"                        │
│                                                         │
│ Copy this token (shown only once):                    │
│  ┌────────────────────────────────────────────────┐   │
│  │ ak_pat_9f8a2c1b7e4d5f6a3b8c9d0e1f2a3b4c        │   │
│  └────────────────────────────────────────────────┘   │
│                                             [ Copied ✓]│
│                                                         │
│ Run this on the machine you want to connect:          │
│  ┌────────────────────────────────────────────────┐   │
│  │ npx -y @agent-kernel/executor \                │   │
│  │   --host https://ak.you.com \                  │   │
│  │   --pat ak_pat_9f8a2c1b7e4d... \               │   │
│  │   --name my-laptop                             │   │
│  └────────────────────────────────────────────────┘   │
│                                             [ Copy ✓  ]│
│                                                         │
│ Once connected, you'll see it here with a green dot. │
│                                                         │
│                                                 [Done] │
└────────────────────────────────────────────────────────┘
```

- translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text token"translated historical texttranslated historical texttranslated historical text
- "Copy" translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text icon translated historical text ✓ translated historical texttranslated historical text 2s，translated historical text alert translated historical texttranslated historical text
- Done translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text Machines panel translated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical text ○，executor translated historical texttranslated historical texttranslated historical texttranslated historical text ●）

**User dropdown**（Explorer translated historical texttranslated historical text user chip translated historical texttranslated historical text）：

```
┌──────────────────────────────┐
│  [avatar] zhangsan            │
│  zhangsan@github              │
│ ──────────────────────────── │
│  ⚙  Settings                  │
│  📖 Docs                      │
│ ──────────────────────────── │
│  ↩  Sign out                  │
└──────────────────────────────┘
```

### 12.7 Loading / error states

| translated historical texttranslated historical text | translated historical texttranslated historical text |
|---|---|
| `/api/me` 401 | 302 → `/welcome`（translated historical texttranslated historical text dashboard translated historical texttranslated historical text） |
| `/api/me` 5xx | Dashboard translated historical texttranslated historical text"Cannot reach host"translated historical texttranslated historical text error + retry translated historical texttranslated historical text |
| Cookie translated historical texttranslated historical text | translated historical texttranslated historical text API translated historical text 401 → toast "Session expired" → 3s translated historical text 302 `/welcome` |
| Socket.IO translated historical texttranslated historical text | ActivityBar translated historical texttranslated historical text"Reconnecting..."（translated historical texttranslated historical texttranslated historical texttranslated historical text） |
| PAT revoke translated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical text | Machines panel translated historical texttranslated historical texttranslated historical texttranslated historical text ○，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text session translated historical text tool_call → session translated historical text `session:error` "Machine disconnected mid-turn" |
| API key translated historical texttranslated historical text → Anthropic 401 | Chat translated historical texttranslated historical texttranslated historical text error assistant bubble："Provider rejected the API key. Check Settings." |

### 12.8 translated historical text/translated historical texttranslated historical texttranslated historical text UI translated historical texttranslated historical text

| UI translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|
| `/welcome` translated historical text | translated historical texttranslated historical texttranslated historical text（`/` translated historical texttranslated historical texttranslated historical text） | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| Explorer translated historical texttranslated historical text user chip | translated historical texttranslated historical text | translated historical texttranslated historical text |
| Explorer "Add machine" translated historical texttranslated historical text | translated historical texttranslated historical text | translated historical texttranslated historical text |
| WorkbenchToolbar user avatar | translated historical texttranslated historical text | translated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical text Explorer translated historical texttranslated historical text） |
| Settings > Providers tab | translated historical texttranslated historical text read-only translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text CRUD |
| Settings > Machines tab | translated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical text |
| Settings > MCP tab | translated historical texttranslated historical text（"planned"） | translated historical texttranslated historical text |
| translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical text provider"translated historical texttranslated historical text | translated historical texttranslated historical text | translated historical text |

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：`useUser()` hook translated historical texttranslated historical text `null | UserInfo`。`null` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text `if (user) return <XXX />` translated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical texttranslated historical text feature flag props chain**，translated historical texttranslated historical text context。

## 13. Dev-mode ergonomics

### 13.1 `AK_DEV_USER` translated historical texttranslated historical text

translated historical texttranslated historical text host translated historical texttranslated historical text `AK_DEV_USER=12345`：

- translated historical texttranslated historical text OAuth；`/api/me` translated historical texttranslated historical texttranslated historical text `{ id: 12345, login: 'devuser', avatarUrl: null }`
- Dashboard translated historical texttranslated historical texttranslated historical texttranslated historical text login gate（cookie translated historical texttranslated historical texttranslated historical texttranslated historical text `dev-{userId}` translated historical text）
- translated historical texttranslated historical text `NODE_ENV=development` translated historical text `AK_DEV_USER` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

### 13.2 translated historical text OAuth App

- Dev App：GitHub translated historical texttranslated historical text callback `http://localhost:3000/auth/github/callback`
- Prod App：callback `https://ak.you.com/auth/github/callback`

Host reads `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and selects the development or production pair based on `NODE_ENV`. `docs/deploy.md` contains the two-step guide.

## 14. Security posture

| translated historical texttranslated historical text | translated historical texttranslated historical text |
|---|---|
| translated historical texttranslated historical texttranslated historical text session translated historical texttranslated historical text | session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（core translated historical text） |
| PAT translated historical texttranslated historical text | hash translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical text + revoke |
| API key translated historical texttranslated historical text (host translated historical texttranslated historical text) | `settings.json` `0600`；translated historical texttranslated historical texttranslated historical texttranslated historical text；`/api/providers` translated historical texttranslated historical text key |
| API key translated historical texttranslated historical text (host translated historical texttranslated historical text dump) | ⚠️ SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text |
| Host translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool_call | translated historical texttranslated historical text executor translated historical texttranslated historical text `approvalMode=ask`；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| CSRF | OAuth state translated historical texttranslated historical text + cookie `SameSite=Lax` + translated historical texttranslated historical texttranslated historical texttranslated historical text endpoint translated historical texttranslated historical text cookie + POST |
| Cookie translated historical texttranslated historical text | HttpOnly + Secure + SameSite=Lax；30 translated historical text TTL；revoke by logout |
| Session translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `ak_sid`，translated historical texttranslated historical texttranslated historical texttranslated historical text |
| translated historical text core translated historical texttranslated historical texttranslated historical text userId | ✅ translated historical texttranslated historical texttranslated historical text——core translated historical texttranslated historical texttranslated historical text `SessionContext` translated historical texttranslated historical text userId translated historical texttranslated historical text；platform translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |

## 15. Non-goals

- **Host translated historical texttranslated historical texttranslated historical texttranslated historical text**（signed kernel state translated historical text）——translated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / PAT translated historical texttranslated historical texttranslated historical texttranslated historical text key**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：
  1. **translated historical texttranslated historical texttranslated historical texttranslated historical text**：kernel translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text state translated historical texttranslated historical text `step()`
  2. **translated historical texttranslated historical texttranslated historical texttranslated historical text**：JSONL translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text → replay/fork/pause translated historical texttranslated historical text
  3. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：PAT translated historical texttranslated historical texttranslated historical text revoke，translated historical texttranslated historical text key translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical text**——GitHub translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text / translated historical texttranslated historical text / translated historical texttranslated historical text session**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**——BYOK translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text provider translated historical text
- **translated historical text OAuth provider（Google/GitLab）**——GitHub only
- **Multi-node host translated historical texttranslated historical text**——translated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **WebContainer executor translated historical texttranslated historical text**——translated historical texttranslated historical text
- **MCP translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**——translated historical texttranslated historical text（translated historical texttranslated historical text `docs/mcp.md`）
- **Platform translated historical text npm translated historical texttranslated historical text**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical text SaaS translated historical texttranslated historical texttranslated historical text pnpm workspace translated historical texttranslated historical texttranslated historical text

## 16. Phased rollout

**translated historical text slice translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text commit、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**

### Slice A：core/platform seam + platform translated historical texttranslated historical text（4–6h）

**translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical text。**

- translated historical texttranslated historical text `packages/host/src/context.ts` translated historical texttranslated historical text `SessionContext` / `ContextResolver` / `DEFAULT_SINGLE_USER_RESOLVER`
- `startHostServer` translated historical text `contextResolver` translated historical texttranslated historical text（translated historical texttranslated historical text `DEFAULT_SINGLE_USER_RESOLVER`）
- translated historical text `server.ts` translated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical text handler：translated historical text `socket.data.ctx` translated historical texttranslated historical texttranslated historical text
- translated historical text `store/session.ts` translated historical texttranslated historical text `sessionsDir` translated historical text context translated historical texttranslated historical text
- `connection/executor.ts` translated historical text `Bind` translated historical text `metadata: unknown`；translated historical texttranslated historical texttranslated historical text `executorFilter?: (bind) => boolean` translated historical texttranslated historical text
- translated historical texttranslated historical text `packages/platform/` translated historical texttranslated historical texttranslated historical text + package.json + tsconfig + dummy `startPlatform()`（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `DEFAULT_SINGLE_USER_RESOLVER`）
- Host bin translated historical texttranslated historical text `AK_PLATFORM=1` translated historical texttranslated historical texttranslated historical text import platform translated historical text
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical text**：`pnpm -r test` translated historical texttranslated historical text；`pnpm -r typecheck` translated historical texttranslated historical text；dashboard UI translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；`AK_PLATFORM=1 pnpm ...host dev` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（dummy resolver translated historical texttranslated historical texttranslated historical text = translated historical texttranslated historical texttranslated historical text）。

### Slice B：Auth + user isolation（3–5h）

Platform translated historical texttranslated historical texttranslated historical text auth translated historical texttranslated historical text。

- `platform/src/auth/*` + `stores/user-store.ts` + `stores/cookie-store.ts`
- HTTP `/auth/github/*`, `/auth/logout`, `/api/me`, `/api/host-info`
- ContextResolver.resolveDashboard/resolveHttp translated historical texttranslated historical text：cookie → userId → sessionsDir
- `AK_DEV_USER` translated historical texttranslated historical text
- Dashboard: `useUser()` context, LoginGate, `/welcome` translated historical text, user chip in Explorer, user dropdown
- Docs: `docs/deploy.md` translated historical texttranslated historical text，translated historical text OAuth App translated historical texttranslated historical text

**translated historical texttranslated historical text**：translated historical texttranslated historical text GitHub translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text session，translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical text sessionId translated historical text URL translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text `AK_PLATFORM`）dashboard translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### Slice C：PAT + executor translated historical texttranslated historical text（3–4h）

- `platform/src/stores/pat-store.ts` + `http/pats.ts`
- Wire: `HandshakeAuth` translated historical text discriminated union；executor translated historical texttranslated historical texttranslated historical texttranslated historical text PAT hash（platform.resolveExecutor）
- ContextResolver.resolveExecutor translated historical text `executorFilter: bind => bind.metadata.userId === thisUserId`
- Executor registry `Bind.metadata = { userId, patId }`
- Executor CLI translated historical text `--pat`
- Dashboard Machines tab + "New machine" modal + Explorer translated historical text machine translated historical texttranslated historical texttranslated historical text
- translated historical texttranslated historical text executor translated historical texttranslated historical text `approvalMode=ask`

**translated historical texttranslated historical text**：A translated historical texttranslated historical text PAT translated historical texttranslated historical texttranslated historical texttranslated historical text；B translated historical texttranslated historical texttranslated historical text PAT translated historical text；A revoke translated historical text executor translated historical texttranslated historical texttranslated historical text；session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text user translated historical text executor；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical text `--token`。

### Slice D：BYOK Providers（3–4h）

- `platform/src/stores/user-settings-store.ts` + `http/providers.ts`
- `platform/src/llm/user-adapter-cache.ts` LRU
- ContextResolver translated historical texttranslated historical text `llmRegistry: cache.get(userId)`
- Dashboard Providers translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- Empty state: translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text provider → translated historical texttranslated historical text
- Host `runtime-config.ts` translated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical text provider translated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical text**：Host env translated historical text `ANTHROPIC_API_KEY` translated historical texttranslated historical texttranslated historical text；A/B translated historical texttranslated historical texttranslated historical text key translated historical texttranslated historical texttranslated historical texttranslated historical text；provider translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（mtime invalidate）。

### Slice E：Rate limit + translated historical texttranslated historical texttranslated historical text（2–3h）

- `platform/src/rate-limit/per-user-limiter.ts`
- ContextResolver translated historical texttranslated historical text `rateLimiter`
- Core loop translated historical text `ctx.rateLimiter?.checkOrThrow(...)`
- `Dockerfile` + `docker-compose.yml`
- translated historical texttranslated historical text `docs/deploy.md`
- translated historical texttranslated historical text `docs/ARCHITECTURE.md` translated historical text"SaaS mode"translated historical texttranslated historical texttranslated historical texttranslated historical text platform seam

**translated historical texttranslated historical text**：`docker build && docker run` translated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical text；15 translated historical texttranslated historical text tool_call 5 translated historical texttranslated historical texttranslated historical text；`docs/deploy.md` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

## 17. Critical files

### translated historical texttranslated historical text

**Platform package**：

- `packages/platform/package.json`, `tsconfig.json`, `src/index.ts`
- `packages/platform/src/context-resolver.ts`
- `packages/platform/src/auth/{github-oauth,cookie-session,oauth-state}.ts`
- `packages/platform/src/stores/{user-store,pat-store,user-settings-store,cookie-store}.ts`
- `packages/platform/src/llm/user-adapter-cache.ts`
- `packages/platform/src/rate-limit/per-user-limiter.ts`
- `packages/platform/src/http/{router,auth-github,me,pats,providers,machines}.ts`
- `packages/platform/src/executor-registry.ts`
- `packages/platform/src/remote-approval.ts`
- `packages/platform/test/*.test.ts`
- `packages/platform/README.md`

**Host core（translated historical texttranslated historical text）**：

- `packages/host/src/context.ts` — `SessionContext` / `ContextResolver` / `DEFAULT_SINGLE_USER_RESOLVER`

**Dashboard**：

- `packages/dashboard/src/features/auth/`（UserContext, LoginGate, Welcome, UserChip, UserMenu）
- `packages/dashboard/src/features/settings/ProvidersPanel.tsx`（platform mode）
- `packages/dashboard/src/features/settings/MachinesPanel.tsx`
- `packages/dashboard/src/features/settings/NewMachineModal.tsx`

**Shared**：

- `packages/shared/src/platform.ts` — translated historical texttranslated historical text `/api/*` payload types

**Deploy**：

- `docs/deploy.md`
- `Dockerfile` + `docker-compose.yml`

### translated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）

- `packages/host/src/server.ts` — translated historical texttranslated historical texttranslated historical texttranslated historical text contextResolver；handler translated historical text `socket.data.ctx` translated historical texttranslated historical texttranslated historical text
- `packages/host/src/store/session.ts` — translated historical texttranslated historical text sessionsDir translated historical text context translated historical texttranslated historical text
- `packages/host/src/connection/executor.ts` — Bind translated historical text metadata；translated historical texttranslated historical texttranslated historical text executorFilter
- `packages/host/src/loop.ts` — translated historical text context translated historical text llmRegistry + rateLimiter
- `packages/host/bin/agent-kernel-host.ts` — `AK_PLATFORM=1` translated historical texttranslated historical texttranslated historical text import platform
- `packages/executor/bin/agent-kernel-executor.ts` — translated historical text `--pat`
- `packages/dashboard/src/app.tsx` — LoginGate + UserContext provider
- `packages/dashboard/src/features/explorer/Explorer.tsx` — translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text UserChip + Add machine translated historical texttranslated historical text
- `packages/dashboard/src/features/settings/SettingsDialog.tsx` — translated historical text Providers/Machines translated historical text tab（platform mode translated historical texttranslated historical texttranslated historical text）
- `packages/shared/src/protocol.ts` — HandshakeAuth translated historical texttranslated historical texttranslated historical texttranslated historical text

### translated historical texttranslated historical text

- `packages/host/src/runtime-config.ts` — translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical text provider translated historical texttranslated historical texttranslated historical texttranslated historical text
- `packages/dashboard/src/session.ts` — Socket.IO `withCredentials: true`
- `packages/dashboard/src/features/chat/ActivityBar.tsx` — translated historical text platform-only error banner
- `pnpm-workspace.yaml` — translated historical text `packages/platform` translated historical texttranslated historical text workspace

## 18. Reuse existing patterns

- **JSONL append-only**（`store/session.ts`）translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text sessionsDir translated historical texttranslated historical texttranslated historical text context translated historical texttranslated historical text
- **HandshakeAuth translated historical texttranslated historical texttranslated historical text**（`server.ts:436` / `server.ts:1011`）translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical text"token translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text"translated historical text contextResolver translated historical text context"
- **selectedModels translated historical texttranslated historical text Map**（`server.ts:171`）ephemeral translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text adapter cache
- **ExecutorAnnounce translated historical texttranslated historical text `hostname` / `ipAddresses`**——translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text executor"
- **translated historical texttranslated historical text Explorer + Workbench translated historical texttranslated historical texttranslated historical texttranslated historical text**（`app.tsx:485–544`）translated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text Explorer translated historical texttranslated historical texttranslated historical text UserChip
- **translated historical texttranslated historical text SettingsDialog + tab translated historical texttranslated historical text**（SettingsDialog.tsx）translated historical texttranslated historical text，translated historical texttranslated historical text tab

## 19. Verification (translated historical texttranslated historical text)

**Slice A**：`pnpm -r test` translated historical texttranslated historical text；`pnpm -r typecheck` translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text dev translated historical texttranslated historical texttranslated historical text golden path translated historical texttranslated historical texttranslated historical text。

**Slice B**：

```
# translated historical text host, AK_PLATFORM=1 GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...
# Chrome translated historical text GitHub translated historical texttranslated historical text A → translated historical texttranslated historical text session、translated historical texttranslated historical texttranslated historical text
# Firefox translated historical text B → translated historical text session translated historical texttranslated historical text；translated historical text A translated historical text sessionId translated historical texttranslated historical text URL → dashboard translated historical text session:error → 302 translated historical texttranslated historical texttranslated historical text
ls ~/.agent-kernel/sessions/<A_id>/*.jsonl  # translated historical text
ls ~/.agent-kernel/sessions/<B_id>/          # translated historical text
```

**Slice C**：

```
# A translated historical text dashboard Machines tab translated historical texttranslated historical text PAT → translated historical texttranslated historical texttranslated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical text
# Machines panel translated historical texttranslated historical text；A translated historical texttranslated historical text session translated historical text my-laptop workspace → translated historical texttranslated historical texttranslated historical text
# B translated historical texttranslated historical text PAT translated historical texttranslated historical text → executor translated historical texttranslated historical texttranslated historical text disconnect
# A revoke → A translated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical text，Machines panel translated historical texttranslated historical texttranslated historical text ○
```

**Slice D**：

```
unset ANTHROPIC_API_KEY; restart host
# A Settings/Providers translated historical text key → save → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# B translated historical texttranslated historical text key → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# A translated historical text provider baseUrl → translated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical text
```

**Slice E**：

```
docker build -t agent-kernel-host .
docker run -p 3000:3000 -e AK_PLATFORM=1 -e GITHUB_CLIENT_ID=... agent-kernel-host
# translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# translated historical texttranslated historical texttranslated historical texttranslated historical text 15 translated historical text tool_call → translated historical texttranslated historical text 5 translated historical texttranslated historical texttranslated historical text
```

## 20. Next steps (for future implementers)

1. Read this doc top-to-bottom.
2. Pick a slice from §16 Phased rollout.
3. Get user approval to start that slice.
4. Follow §17 Critical files as the change map.
5. Verify with §19 checklist.
6. Commit + open PR.
7. After merge, update this doc's "Status" if the slice materially changes the design.

**Slice A is the linchpin** —— translated historical texttranslated historical text core/platform translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text slice translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical text Slice A translated historical texttranslated historical texttranslated historical text Slice B translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text core**，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
