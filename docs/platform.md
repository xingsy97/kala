# SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

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

**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**，translated historical texttranslated historical texttranslated historical texttranslated historical text plan。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text §11 Phased rollout translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。

## 2. Decisions locked in

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：

| # | translated historical text | translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text |
|---|---|---|---|
| 1 | Auth | GitHub OAuth | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、username translated historical texttranslated historical text |
| 2 | LLM translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | Host translated historical text（translated historical texttranslated historical text A） | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text Settings translated historical text key，host translated historical texttranslated historical texttranslated historical texttranslated historical text |
| 3 | API key translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical text `users/<id>/settings.json`，`0600` translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 4 | Session translated historical texttranslated historical text | `sessions/<userId>/*.jsonl` translated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical text DB；translated historical texttranslated historical texttranslated historical texttranslated historical text JSONL translated historical texttranslated historical text |
| 5 | Executor translated historical texttranslated historical text | PAT + hash translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical text + revoke；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor | translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 6 | translated historical texttranslated historical text executor translated historical texttranslated historical text approval | `ask`（translated historical text `auto`） | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 7 | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical text | SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 8 | Host translated historical texttranslated historical texttranslated historical texttranslated historical text | non-goal | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 9 | translated historical texttranslated historical texttranslated historical texttranslated historical text OAuth | `AK_DEV_USER` translated historical texttranslated historical text + translated historical text OAuth App | translated historical texttranslated historical text 0 translated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| 10 | translated historical texttranslated historical texttranslated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical text | translated historical text DB translated historical text Redis |
| 11 | Rate limit | translated historical texttranslated historical texttranslated historical text 10 translated historical texttranslated historical text tool_call + 60 req/min LLM | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |

## 3. System architecture

```
                          ┌──────────────────────────────────────────┐
                          │        Host (public URL, single node)    │
                          │                                          │
                          │  ┌────────────────────────────────────┐  │
   Browser         ─────► │  │ HTTP: /auth/github/*, /api/*       │  │
   (OAuth + SPA)          │  │      /dashboard/* (static bundle)  │  │
                          │  └────────────────────────────────────┘  │
                          │  ┌────────────────────────────────────┐  │
   Browser         ─────► │  │ Socket.IO /dashboard (cookie auth) │  │
   (Socket.IO)            │  └────────────────────────────────────┘  │
                          │  ┌────────────────────────────────────┐  │
   Executor        ─────► │  │ Socket.IO /executor  (PAT auth)    │  │
   (Node CLI)             │  └────────────────────────────────────┘  │
                          │                                          │
                          │  Kernel FSM + Loop                       │
                          │  LLM Adapters (per-user key from cache)  │
                          │                                          │
                          │  UserStore    ~/.agent-kernel/users/     │
                          │                 <id>/                    │
                          │                   profile.json           │
                          │                   settings.json (key)    │
                          │                   pats.json (hash)       │
                          │  SessionStore ~/.agent-kernel/sessions/  │
                          │                 <id>/*.jsonl             │
                          │  ExecutorRegistry (in-mem):              │
                          │                 executorId →             │
                          │                   {userId, workspaceId}  │
                          │  CookieSessionMap (in-mem + disk):       │
                          │                 ak_sid → userId          │
                          └──────────────────────────────────────────┘
```

**translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text IO（LLM、tool call、translated historical texttranslated historical texttranslated historical texttranslated historical text）translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical text。cookie translated historical texttranslated historical text dashboard translated historical text `userId`；PAT translated historical texttranslated historical text executor translated historical text `userId`；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool translated historical texttranslated historical text。

## 4. Identity & auth flow

### 4.1 translated historical texttranslated historical texttranslated historical texttranslated historical text（cookie session）

```
1. Browser → GET https://ak.you.com/
   host translated historical text cookie → 302 → /auth/github/start

2. /auth/github/start → 302 → GitHub OAuth authorize URL
   (state=random opaque translated historical text in-memory translated historical text CSRF)

3. GitHub → callback https://ak.you.com/auth/github/callback?code=...&state=...
   host translated historical texttranslated historical text state；POST code → GitHub token endpoint → access_token
   GET https://api.github.com/user → { id: 12345, login, avatar_url }

4. Host:
   - translated historical text/translated historical texttranslated historical text users/12345/profile.json = { login, avatarUrl, updatedAt }
   - translated historical texttranslated historical text ak_sid = crypto.randomBytes(32).toString('hex')
   - translated historical texttranslated historical text map: ak_sid → { userId: 12345, expiresAt: +30d }
   - translated historical texttranslated historical text cookie-sessions.json = translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical texttranslated historical text）
   - Set-Cookie: ak_sid=xxx; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000
   - 302 → /

5. Browser → GET / with cookie → dashboard translated historical texttranslated historical text
   fetch('/api/me') → host translated historical text cookie map → { id: 12345, login, avatarUrl }
```

**translated historical texttranslated historical text**：`POST /auth/logout` → translated historical text cookie + translated historical text map translated historical text。
**translated historical texttranslated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical text cookie translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical text < 7 translated historical texttranslated historical texttranslated historical texttranslated historical text +30d。
**Cookie translated historical texttranslated historical text**：translated historical texttranslated historical text map + translated historical text 5 translated historical texttranslated historical text flush translated historical text `~/.agent-kernel/cookie-sessions.json`（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。

### 4.2 Executor translated historical texttranslated historical text（PAT）

**translated historical texttranslated historical texttranslated historical text PAT**：Personal Access Token —— translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（`ak_pat_<64 hex>`），translated historical texttranslated historical text"translated historical texttranslated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical text SSH translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：
- SSH：`~/.ssh/id_ed25519`（translated historical texttranslated historical text）↔ `~/.ssh/authorized_keys`（translated historical texttranslated historical text）
- translated historical texttranslated historical texttranslated historical text：executor CLI `--pat`（translated historical texttranslated historical text）↔ host `users/<id>/pats.json`（hash）

**translated historical texttranslated historical text**：

```
1. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text dashboard，translated historical text Settings → Machines → "Add machine"
   dashboard POST /api/pats { label: 'my-laptop' } (cookie auth)
   host:
   - pat = 'ak_pat_' + crypto.randomBytes(32).toString('hex')  // 64 hex chars
   - hash = sha256(pat)
   - translated historical texttranslated historical texttranslated historical text users/12345/pats.json:
       { id: ulid(), hash, label, createdAt, lastSeenAt: null, revoked: false }
   - translated historical texttranslated historical text { pat }  // translated historical texttranslated historical text PAT，translated historical texttranslated historical texttranslated historical texttranslated historical text
   dashboard translated historical texttranslated historical text：
     "translated historical texttranslated historical texttranslated historical texttranslated historical text：ak_pat_...   (translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text)"
     "translated historical texttranslated historical text：agent-kernel-executor --host https://ak.you.com --pat ak_pat_..."

2. translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text CLI
   executor Socket.IO connect → auth = { role: 'executor', pat: 'ak_pat_...', clientVersion }

3. Host /executor translated historical texttranslated historical texttranslated historical text：
   - hash = sha256(pat)
   - translated historical texttranslated historical texttranslated historical texttranslated historical text hash → { userId, patId } translated historical texttranslated historical texttranslated historical text
   - translated historical texttranslated historical text → translated historical text socket.data.userId, socket.data.patId
   - translated historical texttranslated historical text pats.json translated historical text lastSeenAt
   - translated historical texttranslated historical texttranslated historical texttranslated historical text revoked → next(new Error('pat_invalid')) translated historical texttranslated historical text

4. Executor translated historical texttranslated historical text announce workspaceId; host executor registry:
   Bind = { socket, executorId, workspaceId, userId }
```

**Revoke**：Settings → Machines → translated historical texttranslated historical text → `DELETE /api/pats/:id` → translated historical texttranslated historical text `revoked=true` → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor bind → translated historical texttranslated historical text disconnect。

**translated historical texttranslated historical text**：`GET /api/pats` translated historical texttranslated historical text `{ id, label, createdAt, lastSeenAt, revoked, connected }[]`；**translated historical texttranslated historical texttranslated historical texttranslated historical text hash translated historical text PAT translated historical texttranslated historical text**。

## 5. Data model & storage

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
    └── 12345/                    # translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
        ├── 2026-07-06T10-00-00_<uuid>.jsonl
        └── ...
```

**Legacy**：translated historical texttranslated historical text `sessions/*.jsonl`（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）translated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text warn，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。
**File permissions**：translated historical texttranslated historical text `users/<id>/*` translated historical texttranslated historical text `0600`；translated historical texttranslated historical text `0700`。
**translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text Map translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical text）。

## 6. Wire protocol changes

### 6.1 `HandshakeAuth` translated historical texttranslated historical texttranslated historical texttranslated historical text role

translated historical texttranslated historical text `packages/shared/src/protocol.ts`：

```ts
export type HandshakeAuth = {
  role: ClientRole
  sessionId?: string
  token?: string
  clientVersion: string
}
```

translated historical texttranslated historical text discriminated union：

```ts
export type DashboardHandshakeAuth = {
  role: 'dashboard'
  sessionId: string
  clientVersion: string
  // translated historical text token translated historical texttranslated historical text：dashboard translated historical texttranslated historical text HTTP cookie（Socket.IO withCredentials）
}

export type ExecutorHandshakeAuth = {
  role: 'executor'
  pat: string          // translated historical texttranslated historical texttranslated historical text token
  clientVersion: string
}

export type HandshakeAuth = DashboardHandshakeAuth | ExecutorHandshakeAuth
```

**translated historical texttranslated historical texttranslated historical text**：translated historical texttranslated historical text `token?: string` translated historical texttranslated historical text release translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text `pat` translated historical text `token` translated historical text `pat` translated historical texttranslated historical text。dev token translated historical text `HOST_DEV_TOKEN` env（translated historical text dev translated historical texttranslated historical text）。

### 6.2 translated historical texttranslated historical text HTTP endpoints

| Endpoint | Auth | translated historical texttranslated historical text |
|---|---|---|
| `GET /auth/github/start` | none | 302 translated historical text GitHub OAuth |
| `GET /auth/github/callback` | none (state translated historical texttranslated historical text) | translated historical texttranslated historical text OAuth |
| `POST /auth/logout` | cookie | translated historical text cookie |
| `GET /api/me` | cookie | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| `GET /api/pats` | cookie | translated historical texttranslated historical text PAT metadata |
| `POST /api/pats` | cookie | translated historical texttranslated historical text PAT，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| `DELETE /api/pats/:id` | cookie | Revoke |
| `GET /api/providers` | cookie | translated historical text provider（translated historical text key） |
| `PUT /api/providers/:id` | cookie | translated historical texttranslated historical text/translated historical texttranslated historical text provider（translated historical text key） |
| `GET /api/machines` | cookie | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text executor（translated historical texttranslated historical texttranslated historical texttranslated historical text） |

translated historical texttranslated historical text `GET /settings` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical text（translated historical texttranslated historical texttranslated historical text paths、mcp note）；user translated historical texttranslated historical texttranslated historical text `/api/providers`。

### 6.3 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical text `client:*` handler：
- translated historical text `socket.data.userId` translated historical texttranslated historical texttranslated historical text
- `SessionStore.load/create/ensure/list` translated historical texttranslated historical text userId
- Session id translated historical texttranslated historical texttranslated historical texttranslated historical text（translated historical text sessionId translated historical texttranslated historical texttranslated historical text `sessions/<userId>/` translated historical texttranslated historical texttranslated historical text）

translated historical texttranslated historical text executor translated historical texttranslated historical text：
- `pickBindFor(sessionId, userId)`：translated historical texttranslated historical text userId translated historical texttranslated historical text executor bind，translated historical texttranslated historical text workspaceId translated historical texttranslated historical texttranslated historical texttranslated historical text
- `server:executors` broadcast translated historical texttranslated historical texttranslated historical text user translated historical text bind

## 7. Provider & LLM adapter (per-user)

### 7.1 Storage

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

### 7.2 Adapter cache

translated historical texttranslated historical text `packages/host/src/user-adapter-cache.ts`：
- Key: `userId`
- Value: `{ adapters: Map<model, LLMAdapter>, defaultModel: string, mtime: number }`
- LRU translated historical texttranslated historical text 100 translated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text build；`settings.json` mtime translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- Session ready translated historical texttranslated historical text `session.userId` translated historical text adapter；`selectedModel` translated historical texttranslated historical text default

**translated historical text provider translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text provider → session ready translated historical text `state:ready` translated historical texttranslated historical text `warnings: ['no_provider_configured']` → dashboard translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text Settings translated historical text API key"。

### 7.3 Runtime config translated historical texttranslated historical text

translated historical text `packages/host/src/runtime-config.ts` translated historical texttranslated historical text，translated historical text**translated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical text**（`~/.claude/settings.json` / `~/.codex/config.toml` translated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）。translated historical texttranslated historical texttranslated historical texttranslated historical text `AK_MULTITENANT=1` translated historical texttranslated historical texttranslated historical texttranslated historical text `GITHUB_CLIENT_ID` env → translated historical text per-user translated historical texttranslated historical text。

**translated historical texttranslated historical text**：translated historical texttranslated historical text provider translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，SaaS translated historical texttranslated historical texttranslated historical text**translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical text**（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical text key）。

## 8. Approval defaults

Executor announce translated historical texttranslated historical texttranslated historical text approval translated historical texttranslated historical text，approval mode translated historical text session config translated historical texttranslated historical text。**translated historical texttranslated historical text**：session translated historical texttranslated historical texttranslated historical texttranslated historical text workspace translated historical text"translated historical texttranslated historical text executor"（executor translated historical text host translated historical texttranslated historical texttranslated historical text，translated historical text host translated historical text `AK_MULTITENANT=1`），translated historical texttranslated historical text `approvalMode = 'ask'`；translated historical texttranslated historical text（translated historical texttranslated historical text executor translated historical text dev mode）translated historical texttranslated historical text `auto`。

translated historical texttranslated historical text"translated historical texttranslated historical text executor"：executor announce translated historical texttranslated historical texttranslated historical text `hostname + ipAddresses`；host translated historical texttranslated historical text，session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

## 9. Rate limiting

**Per-user in-memory**：
- Concurrent tool_call ≤ 10：`callTool` translated historical texttranslated historical text pending translated historical text，translated historical texttranslated historical text → translated historical texttranslated historical text；FIFO；~5s translated historical text timeout translated historical text LLM translated historical texttranslated historical text
- LLM req/min ≤ 60：translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical text → `llm_error { kind: 'rate_limited_by_platform', retryAfterMs }`

**translated historical texttranslated historical text**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical text quota、translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

## 10. Dashboard changes

### 10.1 Login gate

`app.tsx` translated historical texttranslated historical texttranslated historical texttranslated historical text `fetch('/api/me')`：
- 200 → translated historical texttranslated historical texttranslated historical texttranslated historical text
- 401 → `window.location = '/auth/github/start'`

### 10.2 User context

translated historical texttranslated historical text `packages/dashboard/src/features/auth/UserContext.tsx` provide `{ id, login, avatarUrl }`；toolbar translated historical texttranslated historical texttranslated historical text avatar dropdown（Sign out / Settings）。

### 10.3 Settings translated historical texttranslated historical texttranslated historical text tab

- **Providers**：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical text provider translated historical text API key translated historical texttranslated historical texttranslated historical text（`type=password`）、baseUrl（translated historical texttranslated historical text）、models translated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text。
- **Machines**：translated historical texttranslated historical text PAT，translated historical texttranslated historical text label / createdAt / lastSeenAt / status dot（translated historical texttranslated historical texttranslated historical text/translated historical text）；"Add machine" translated historical texttranslated historical text PAT，translated historical text modal translated historical texttranslated historical text pat translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical text revoke translated historical texttranslated historical text。

### 10.4 translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

translated historical texttranslated historical texttranslated historical text（`/welcome` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text）+ Settings translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：

> **What this host sees**
> - Your conversations, including uploaded files and tool outputs
> - Your Anthropic/OpenAI API key (in memory only, never written to logs)
> - Which machines you've paired via PAT
>
> **What this host cannot see**
> - Anything on your local machine outside your executor's sandbox roots
> - Your GitHub password or other GitHub-side data
>
> **If you don't trust this host**, [self-host with docker-compose](./deploy.md)—all features work identically.

### 10.5 Executor translated historical texttranslated historical texttranslated historical texttranslated historical text UX

Machines tab "Add machine" translated historical texttranslated historical texttranslated historical text modal：

```
✓ New PAT created for "my-laptop"

Copy this token (shown only once):
  ┌────────────────────────────────────────────┐
  │ ak_pat_9f8a2c1b7e4d5f6a3b8c9d0e1f2a3b4c    │  [Copy]
  └────────────────────────────────────────────┘

Run this on the machine you want to connect:
  ┌────────────────────────────────────────────┐
  │ npx -y @agent-kernel/executor \            │  [Copy]
  │   --host https://ak.you.com \              │
  │   --pat ak_pat_... \                       │
  │   --name my-laptop                         │
  └────────────────────────────────────────────┘

[Done]
```

## 11. Executor CLI changes

`bin/agent-kernel-executor.ts` translated historical text `--pat` / `PAT` env；`--token` translated historical texttranslated historical texttranslated historical texttranslated historical text dev。

translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical text `executor:welcome { userLogin, warning?: 'trust_boundary' }` → executor translated historical texttranslated historical text：

```
✓ Connected to https://ak.you.com as zhangsan
⚠ Remote host will control this machine's shell.
   Approval mode: ask (you'll confirm each tool call in your browser)
   Sandbox roots: <workspace-root>
   Ctrl+C to disconnect.
```

## 12. Dev-mode ergonomics

### 12.1 `AK_DEV_USER` translated historical texttranslated historical text

translated historical texttranslated historical text host translated historical texttranslated historical text `AK_DEV_USER=12345` set：
- translated historical texttranslated historical text OAuth；`/api/me` translated historical texttranslated historical texttranslated historical text `{ id: 12345, login: 'devuser', avatarUrl: null }`
- dashboard translated historical texttranslated historical texttranslated historical texttranslated historical text login gate（cookie translated historical texttranslated historical texttranslated historical texttranslated historical text `dev-{userId}` translated historical text）
- translated historical texttranslated historical text `NODE_ENV=development` translated historical text `AK_DEV_USER` translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text

### 12.2 translated historical text OAuth App

- Dev App：GitHub translated historical texttranslated historical text callback `http://localhost:3000/auth/github/callback`
- Prod App：callback `https://ak.you.com/auth/github/callback`

Host reads `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and selects the development or production pair based on `NODE_ENV`.

`docs/deploy.md`（translated historical texttranslated historical text）translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical text OAuth App、translated historical texttranslated historical texttranslated historical text secret。

## 13. Security posture summary

| translated historical texttranslated historical text | translated historical texttranslated historical text |
|---|---|
| translated historical texttranslated historical texttranslated historical text session translated historical texttranslated historical text | session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| PAT translated historical texttranslated historical text | hash translated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical text + revoke |
| API key translated historical texttranslated historical text (host translated historical texttranslated historical text) | `settings.json` `0600`；translated historical texttranslated historical texttranslated historical texttranslated historical text；`/api/providers` translated historical texttranslated historical text key |
| API key translated historical texttranslated historical text (host translated historical texttranslated historical text dump) | ⚠️ SaaS translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical text |
| Host translated historical texttranslated historical text/translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text tool_call | translated historical texttranslated historical text executor translated historical texttranslated historical text `approvalMode=ask`；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text |
| CSRF | OAuth state translated historical texttranslated historical text + cookie `SameSite=Lax` + translated historical texttranslated historical texttranslated historical texttranslated historical text endpoint translated historical texttranslated historical text cookie + POST |
| Cookie translated historical texttranslated historical text | HttpOnly + Secure + SameSite=Lax；30 translated historical text TTL；revoke by logout |
| Session translated historical texttranslated historical text | translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text `ak_sid`，translated historical texttranslated historical texttranslated historical texttranslated historical text |

## 14. Non-goals

- **Host translated historical texttranslated historical texttranslated historical texttranslated historical text**（signed kernel state translated historical text）——translated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / PAT translated historical texttranslated historical texttranslated historical texttranslated historical text key**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text：
  1. **translated historical texttranslated historical texttranslated historical texttranslated historical text**：kernel translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text state translated historical texttranslated historical text `step()`，host translated historical texttranslated historical texttranslated historical text = translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical text kernel translated historical texttranslated historical text executor（translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text B）
  2. **translated historical texttranslated historical texttranslated historical texttranslated historical text**：JSONL translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text → replay/fork/pause translated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
  3. **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**：PAT translated historical texttranslated historical texttranslated historical text revoke（revoke = translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text），translated historical texttranslated historical text key translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（key translated historical text = translated historical texttranslated historical texttranslated historical texttranslated historical text），translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

  translated historical texttranslated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical text"translated historical texttranslated historical texttranslated historical texttranslated historical text"（translated historical texttranslated historical text JSONL translated historical texttranslated historical text + OS keyring translated historical text master key）translated historical texttranslated historical texttranslated historical texttranslated historical text。translated historical texttranslated historical texttranslated historical texttranslated historical text。
- **translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical text**——GitHub translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text / translated historical texttranslated historical text / translated historical texttranslated historical text session**——translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **translated historical texttranslated historical text / translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**——BYOK translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text provider translated historical text
- **translated historical text OAuth provider（Google/GitLab）**——GitHub only
- **Multi-node host translated historical texttranslated historical text**——translated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **WebContainer executor translated historical texttranslated historical text**——translated historical texttranslated historical text
- **MCP translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text**——translated historical texttranslated historical text（translated historical texttranslated historical text `docs/mcp.md`）

## 15. Phased rollout

**translated historical text slice translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text commit、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。**

### Slice 0：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text + session translated historical texttranslated historical texttranslated historical text（3–5h）

translated historical texttranslated historical text UI translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text BYOK、translated historical texttranslated historical text executor PAT。translated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text session；executor translated historical texttranslated historical texttranslated historical text token translated historical texttranslated historical text。

- Host translated historical text `/auth/github/*`、`/api/me`、`/auth/logout`
- Cookie session map（translated historical texttranslated historical text + `cookie-sessions.json`）
- SessionStore translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text userId
- translated historical texttranslated historical text `client:*` handler translated historical text socket.data translated historical text userId translated historical texttranslated historical texttranslated historical text
- session id translated historical texttranslated historical texttranslated historical texttranslated historical text
- Dashboard translated historical text login gate + `/welcome` translated historical texttranslated historical texttranslated historical text + translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- Dev mode: `AK_DEV_USER` translated historical texttranslated historical text
- Docs: `docs/deploy.md` translated historical texttranslated historical text，translated historical text OAuth App translated historical texttranslated historical text

**translated historical texttranslated historical text**：translated historical texttranslated historical text GitHub translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text session，translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical text sessionId translated historical text URL translated historical texttranslated historical text。

### Slice 1：Executor PAT + user translated historical texttranslated historical text（3–4h）

- Host translated historical text `POST/GET/DELETE /api/pats`
- Wire: `HandshakeAuth` translated historical texttranslated historical text；executor translated historical texttranslated historical texttranslated historical texttranslated historical text PAT hash translated historical texttranslated historical text
- Executor registry Bind translated historical text userId；`pickBindFor` translated historical text userId translated historical texttranslated historical text
- `server:executors` broadcast translated historical text userId
- Executor CLI translated historical text `--pat`
- Dashboard Machines tab + "Add machine" modal
- translated historical texttranslated historical text executor translated historical texttranslated historical text `approvalMode=ask` translated historical texttranslated historical text

**translated historical texttranslated historical text**：translated historical texttranslated historical text A translated historical texttranslated historical text PAT translated historical texttranslated historical text；B translated historical texttranslated historical text PAT translated historical texttranslated historical texttranslated historical text；A revoke PAT translated historical text executor translated historical texttranslated historical text；session translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text user translated historical text executor。

### Slice 2：BYOK Providers（3–4h）

- translated historical texttranslated historical text `user-config.ts` / `user-adapter-cache.ts`
- `POST /api/providers`, `GET /api/providers`
- `runtime-config.ts` translated historical texttranslated historical text：translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text host translated historical text provider translated historical texttranslated historical text
- Adapter translated historical text userId translated historical texttranslated historical text build + LRU translated historical texttranslated historical text
- Dashboard Providers translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- Empty state：translated historical text provider translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical text**：translated historical texttranslated historical text host env translated historical text API key，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text key translated historical texttranslated historical texttranslated historical texttranslated historical text；translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

### Slice 3：Rate limit + translated historical texttranslated historical texttranslated historical text（2–3h）

- Per-user concurrent tool_call ≤ 10 + LLM req/min ≤ 60
- `Dockerfile` + `docker-compose.yml`（host translated historical text container，translated historical text host+executor translated historical texttranslated historical texttranslated historical texttranslated historical text）
- translated historical texttranslated historical text `docs/deploy.md`
- translated historical texttranslated historical text `docs/ARCHITECTURE.md` translated historical text SaaS mode section

**translated historical texttranslated historical text**：`docker build && docker run` translated historical texttranslated historical text host translated historical texttranslated historical texttranslated historical texttranslated historical text；15 translated historical texttranslated historical text tool_call 5 translated historical texttranslated historical texttranslated historical text；docs translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text。

## 16. Critical files (translated historical texttranslated historical text)

**translated historical texttranslated historical text**：
- `packages/host/src/auth/github-oauth.ts` — OAuth translated historical texttranslated historical texttranslated historical text
- `packages/host/src/auth/cookie-session.ts` — cookie translated historical texttranslated historical text
- `packages/host/src/auth/user-store.ts` — `users/<id>/*.json` IO
- `packages/host/src/auth/pat.ts` — PAT translated historical texttranslated historical text/hash/translated historical texttranslated historical text/revoke
- `packages/host/src/user-config.ts` — per-user provider IO
- `packages/host/src/user-adapter-cache.ts` — LRU
- `packages/host/src/rate-limit.ts` — per-user translated historical texttranslated historical text
- `packages/host/src/http-api.ts` — `/api/*` + `/auth/*` translated historical texttranslated historical text（translated historical texttranslated historical text server.ts translated historical text http translated historical texttranslated historical texttranslated historical texttranslated historical text `/settings`，translated historical texttranslated historical texttranslated historical texttranslated historical text）
- `packages/dashboard/src/features/auth/` — UserContext, LoginGate, Welcome, UserMenu
- `packages/dashboard/src/features/settings/MachinesPanel.tsx`
- `packages/dashboard/src/features/settings/ProvidersPanel.tsx`（translated historical texttranslated historical texttranslated historical texttranslated historical text）
- `docs/deploy.md` — SaaS translated historical texttranslated historical texttranslated historical texttranslated historical text
- `Dockerfile` + `docker-compose.yml`

**translated historical texttranslated historical text（translated historical texttranslated historical text）**：
- `packages/host/src/server.ts` — translated historical texttranslated historical texttranslated historical text、translated historical texttranslated historical text handler translated historical text userId
- `packages/host/src/store/session.ts` — translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text userId
- `packages/host/src/connection/executor.ts` — Bind + translated historical texttranslated historical texttranslated historical texttranslated historical text
- `packages/host/bin/agent-kernel-host.ts` — translated historical text OAuth env、translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- `packages/executor/bin/agent-kernel-executor.ts` — `--pat`
- `packages/dashboard/src/app.tsx` — login gate
- `packages/dashboard/src/features/settings/SettingsDialog.tsx` — translated historical text Providers/Machines translated historical text tab
- `packages/shared/src/protocol.ts` — HandshakeAuth translated historical texttranslated historical texttranslated historical texttranslated historical text、translated historical text `/api/*` translated historical texttranslated historical texttranslated historical texttranslated historical text

**translated historical texttranslated historical text**：
- `packages/host/src/loop.ts` — translated historical texttranslated historical text userId translated historical text adapter
- `packages/dashboard/src/session.ts` — Socket.IO `withCredentials: true`

## 17. Reuse existing patterns

- **JSONL append-only**（`store/session.ts`）translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
- **HandshakeAuth translated historical texttranslated historical texttranslated historical text**（`server.ts:436` / `server.ts:1011`）translated historical texttranslated historical texttranslated historical texttranslated historical text，translated historical text"token translated historical texttranslated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text"cookie/PAT translated historical texttranslated historical texttranslated historical text userId"
- **selectedModels translated historical texttranslated historical text Map**（`server.ts:171`）ephemeral translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text adapter cache
- **ExecutorAnnounce translated historical texttranslated historical text `hostname` / `ipAddresses`**——translated historical texttranslated historical texttranslated historical text"translated historical texttranslated historical text executor"

## 18. Verification

**Slice 0**：

```
# translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text（Chrome + Firefox），translated historical texttranslated historical texttranslated historical text GitHub translated historical texttranslated historical text
# translated historical texttranslated historical texttranslated historical text session、translated historical texttranslated historical texttranslated historical text
ls ~/.agent-kernel/sessions/<A_id>/*.jsonl  # translated historical text
ls ~/.agent-kernel/sessions/<B_id>/*.jsonl  # translated historical text
# A translated historical text B translated historical text sessionId translated historical texttranslated historical text URL → dashboard translated historical texttranslated historical text session:error → translated historical text
```

**Slice 1**：

```
# A dashboard translated historical texttranslated historical text PAT → translated historical texttranslated historical texttranslated historical text executor
# Machines panel translated historical texttranslated historical texttranslated historical texttranslated historical text
# B translated historical texttranslated historical text A translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text → PAT translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# A translated historical text dashboard translated historical text revoke → translated historical text executor translated historical texttranslated historical texttranslated historical texttranslated historical text
```

**Slice 2**：

```
unset ANTHROPIC_API_KEY; restart host
# A Settings translated historical text key → translated historical texttranslated historical text session → translated historical texttranslated historical texttranslated historical text → translated historical text
# B translated historical texttranslated historical text key → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# A translated historical text provider → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
```

**Slice 3**：

```
docker build -t agent-kernel-host .
docker run -p 3000:3000 -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... agent-kernel-host
# translated historical texttranslated historical text http://localhost:3000 → translated historical texttranslated historical text → translated historical texttranslated historical texttranslated historical texttranslated historical texttranslated historical text
# translated historical texttranslated historical texttranslated historical texttranslated historical text 15 translated historical text tool_call → translated historical texttranslated historical text 5 translated historical texttranslated historical texttranslated historical text
```

## 19. Next steps (for future implementers)

1. Read this doc top-to-bottom.
2. Pick a slice from §15 Phased rollout.
3. Get user approval to start that slice.
4. Follow §16 Critical files as the change map.
5. Verify with §18 checklist.
6. Commit + open PR.
7. After merge, update this doc's "Status" if the slice materially changes the design.
