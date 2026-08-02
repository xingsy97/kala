# PWA Mobile + Web Push — roadmap note

Status: proposed / planning
Owner: dashboard + host
Last updated: 2026-07-23

This note captures a complete PWA + Web Push rollout plan for the RunLab
dashboard. It is a roadmap document, not a change log — code lands per the
PR checklist in §10 and per-PR commits reference this file.

The plan itself is transcribed from a design conversation (session
`123e4567-e89b-42d3-a456-42661417000e`, LLM traces seq 1466 and seq 1489)
that was lost when a compaction bug replaced the transcript with a
conversational reply. The compaction bug has since been fixed
(`packages/host/src/extensions/compaction.ts`, codex-style anchored summary);
this note re-anchors the plan itself so it survives future compactions.

---

足够了。基于对现状（Vite + React、无 SW/manifest、无 HTTPS 引导、已有桌面通知与 safe-area 支持）的了解，产出完整方案。

<br>

# Agent RunLab Dashboard — PWA 改造与优化完整方案

## 0. 目标与非目标

**目标**
- 让 dashboard 可以作为独立 App 安装到桌面 / iOS 主屏 / Android，脱离浏览器 UI。
- 提供离线壳（App Shell），断网时仍能打开界面并显示"离线态"，而非浏览器错误页。
- 打通 **Web Push**（后台推送）与已有的前台桌面通知，让审批/等待/错误事件在标签页关闭时也能到达。
- 优化冷启动、资源缓存、iOS 体验、可观测性，且不破坏现有 SPA 行为。

**非目标**
- 不把业务数据（会话消息、事件流）做离线可写副本；离线仅提供只读壳。
- 不替换现有 WebSocket 实时链路，Push 仅是"叫醒用户"的旁路。

---

## 1. 总体架构

```
┌────────────────────┐     install     ┌────────────────────────────┐
│  Browser / iOS     │◀───manifest─────│  dashboard (Vite build)    │
│  Home Screen App   │                 │  - manifest.webmanifest    │
└─────────┬──────────┘                 │  - icons/ (maskable+any)   │
          │ fetch                      │  - sw.js (Workbox)         │
          ▼                            └─────────────┬──────────────┘
┌────────────────────┐  precache + runtime cache     │
│  Service Worker    │◀──────────────────────────────┘
│  - App Shell       │
│  - Runtime cache   │  push
│  - Push handler    │◀──────── VAPID ──────── host (Node)
│  - Notif click     │                         - /push/subscribe
└─────────┬──────────┘                         - /push/unsubscribe
          │ postMessage / focus                - web-push dispatcher
          ▼
┌────────────────────┐
│  React app (SPA)   │ 现有 WS + 前台 Notification API
└────────────────────┘
```

---

## 2. 分阶段路线图

| 阶段 | 内容 | 可交付 |
|---|---|---|
| **P0 可安装** | manifest + 图标 + 基础 SW（仅 App Shell 预缓存） | 桌面/Android 出现安装提示，离线可打开壳 |
| **P1 运行时缓存** | Workbox 策略 + 版本化更新 + "有新版本"提示 | 二次访问秒开；平滑升级 |
| **P2 后台推送** | VAPID + `/push/subscribe` + SW `push`/`notificationclick` | 关标签页也能收到审批提醒 |
| **P3 iOS & 体验** | apple-touch-icon、启动画面、safe-area 校对、`display_override` | iOS 添加到主屏可用 |
| **P4 观测与治理** | SW 事件上报、缓存配额监控、灰度与回滚开关 | 可运维 |

---

## 3. P0 — 可安装的最小闭环

### 3.1 Manifest

新建 `packages/dashboard/public/manifest.webmanifest`：

```json
{
  "name": "Agent RunLab",
  "short_name": "RunLab",
  "id": "/",
  "start_url": "/?utm_source=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone", "browser"],
  "orientation": "any",
  "background_color": "#0b0b0f",
  "theme_color": "#0b0b0f",
  "categories": ["developer", "productivity"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/monochrome.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "monochrome" }
  ],
  "shortcuts": [
    { "name": "Sessions", "url": "/#/sessions", "icons": [{ "src": "/icons/icon-192.png", "sizes": "192x192" }] },
    { "name": "Approvals", "url": "/#/approvals" }
  ]
}
```

**要点**
- `theme_color` 与 `index.html` 首屏一致，避免安装后系统栏闪色。
- 同时提供 `any` 与 `maskable` 图标，避免 Android 剪裁成白圈。
- `id` 固定，避免 host 变更导致同一 App 被重复安装。

### 3.2 图标资产

- 源 SVG → 用 `pwa-asset-generator` 生成 `192/512` PNG + `maskable`（安全区 80%）+ iOS splash。放到 `public/icons/`。
- CI 校验：脚本对比现有 hash，防止漏更新。

### 3.3 index.html 补丁

```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0b0b0f" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<!-- iOS -->
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="RunLab" />
```

保留现有内联主题脚本（防止 FOUC）。

### 3.4 Service Worker（最小版）

引入 `vite-plugin-pwa`（Workbox 封装），`vite.config.ts`：

```ts
import { VitePWA } from 'vite-plugin-pwa'

VitePWA({
  registerType: 'prompt',               // 手动提示更新，避免打断长会话
  strategies: 'generateSW',
  injectRegister: null,                 // 自行注册以便挂 UI
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,woff2}'],
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/push/, /^\/events/],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
  },
  manifest: false,                      // 我们自己维护 manifest
})
```

**关键决策**
- `navigateFallbackDenylist` 必须排除 `/api`、`/ws`、SSE，绝对不能让 SW 拦截长连接。
- 不 `skipWaiting`：更新走用户确认，避免会话中途 reload 丢状态。

---

## 4. P1 — 运行时缓存与更新流

### 4.1 缓存策略矩阵

| 资源 | 策略 | 说明 |
|---|---|---|
| 构建产物 `assets/*` (带 hash) | **CacheFirst**，1 年 | 内容寻址，安全长缓存 |
| `index.html` / `manifest` | **NetworkFirst**，5s 超时回落缓存 | 保证发版可达 |
| 图标/字体 `public/**` | **StaleWhileRevalidate** | |
| `GET /api/**` 只读元数据 | **NetworkFirst**，3s 超时；带 `X-SW-Cache: 1` 头 | 弱网下可看历史列表 |
| `POST /api/**` / `/ws` / `/events` | **NetworkOnly**，不入缓存 | |
| 会话消息内容 | 不缓存 | 一致性优先，避免陈旧数据误导 |

runtimeCaching 示例：

```ts
{
  urlPattern: ({ url, request }) =>
    request.method === 'GET' && url.pathname.startsWith('/api/') && isReadOnly(url),
  handler: 'NetworkFirst',
  options: {
    cacheName: 'api-readonly-v1',
    networkTimeoutSeconds: 3,
    expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
    cacheableResponse: { statuses: [200] },
  },
}
```

### 4.2 更新提示 UI

新增 `src/lib/pwa.ts`：

```ts
import { registerSW } from 'virtual:pwa-register'

export function initPwa(onUpdate: () => void, onReady: () => void) {
  const update = registerSW({
    onNeedRefresh: onUpdate,
    onOfflineReady: onReady,
    onRegisteredSW(_, r) {
      // 每 30 分钟主动检查，覆盖长开的场景
      setInterval(() => r?.update(), 30 * 60 * 1000)
    },
  })
  return update
}
```

在 `app.tsx` 顶栏加入非阻塞 Toast："新版本可用 · 刷新" → 调用 `update(true)`。仅在无进行中审批/长任务时默认建议刷新。

### 4.3 离线态

- 全局 `useOnline()` hook（`navigator.onLine` + `online`/`offline` 事件 + 一次 `HEAD /healthz` 探测）。
- 顶栏出现 "Offline — 显示的是缓存数据"，配色沿用现有 `text-muted-foreground` + 图标。
- WebSocket 层已有断连处理，只需把 UI 状态合并（不再在断网时反复重连指数退避到极值）。

---

## 5. P2 — Web Push（后台通知）

现状：`desktop-notifications.ts` 仅在页面存活时用 `Notification` API。目标：页面关闭也能收。

### 5.1 后端（host 包）

新增：
- `POST /push/vapid-public-key` → 返回 VAPID 公钥。
- `POST /push/subscribe` → 持久化 `endpoint / p256dh / auth / userId / prefs`。
- `POST /push/unsubscribe`。
- `web-push` 依赖，在既有事件分发点（approval_required / waiting_for_user / session_error / connection_lost / workspace_offline）按 `DesktopNotificationPrefs` 过滤后发送。
- 发送失败（410/404）→ 清理订阅。
- 存储：现有偏好用什么存就用什么（若是本地 SQLite / JSON，加一张 `push_subscriptions` 表）。

**安全**
- VAPID 密钥放服务器环境变量，不入 git。
- 订阅须绑定当前登录/工作区，防止跨用户串扰。
- 事件 payload 只带 `{ kind, sessionId, title, body, url }`，**不带敏感 diff / 密钥 / 消息正文**。

### 5.2 前端订阅流程

在"通知设置"面板复用现有 `DESKTOP_NOTIFICATION_PREFS`，增加 **"启用后台推送（关标签也接收）"** 主开关：

1. 检测 `('serviceWorker' in navigator) && ('PushManager' in window)`。
2. `Notification.requestPermission()`。
3. `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`。
4. `POST /push/subscribe` 带上偏好快照。
5. 偏好变更时增量 `PATCH`；关闭时 `unsubscribe()`。

**iOS 特别处理**：只有在 `display-mode: standalone`（已添加到主屏）时 iOS 才允许 Push。UI 需要检测并提示"请先添加到主屏"。

### 5.3 SW 中的 push / click

```js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {}
  event.waitUntil(self.registration.showNotification(data.title || 'Agent RunLab', {
    body: data.body,
    tag: data.tag ?? data.kind,   // 同类事件合并
    renotify: data.kind === 'approval_required',
    data: { url: data.url ?? '/' },
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    requireInteraction: data.kind === 'approval_required',
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url ?? '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const hit = all.find(c => new URL(c.url).origin === self.location.origin)
    if (hit) { await hit.focus(); hit.postMessage({ type: 'navigate', url: target }) }
    else await self.clients.openWindow(target)
  })())
})
```

前台窗口存活时，用 `postMessage` 把 push 转成应用内 toast，**不再重复弹系统通知**（去重键：`tag`）。

### 5.4 多设备活跃抑制

默认交付策略是“仅在没有设备正在使用 Agent RunLab 时发送系统 Push”，避免桌面端正在查看运行结果时手机仍然响铃。

“正在使用”必须同时满足：

- 页面处于前台可见状态；
- 浏览器窗口拥有焦点；
- 最近 5 分钟内有点击、键盘、触摸或滚动操作；
- Host 在最近 45 秒内收到该设备的心跳。

Dashboard 每 15 秒发送一次 `/push/activity` 心跳，并在 `visibilitychange`、`focus`、`blur` 和 `pagehide` 时立即更新。Host 只维护带过期时间的内存状态；页面崩溃、断网或设备休眠后会自动恢复 Push。任一设备满足活跃条件时，Host 抑制正常产品 Push，但 Settings 中显式触发的诊断测试 Push 不受影响。Sub-agent 事件仍不产生产品级通知。

---

## 6. P3 — iOS / 桌面体验细节

- **iOS 启动画面**：`pwa-asset-generator` 生成一套 `apple-touch-startup-image`，覆盖常见尺寸。
- **safe-area**：已在 `app.tsx` 用 `env(safe-area-inset-*)`，补齐顶栏 `pt-[env(safe-area-inset-top)]`，standalone 下顶栏没有浏览器 UI。
- **standalone 检测**：加 `useStandalone()` hook，用于：
  - 隐藏"添加到主屏"引导 banner；
  - 允许更激进的手势（如下拉刷新拦截）。
- **窗口控件覆盖（桌面 Chromium）**：`display_override: ["window-controls-overlay"]` + CSS `env(titlebar-area-*)`，把顶栏渲染进标题栏区域，观感接近原生 App。
- **文件协议 / Web Share Target**（可选）：把 `.log`、`.json` 分享到 App 直接打开为诊断视图，`manifest.share_target` 配置。

---

## 7. P4 — 观测、灰度与治理

- **SW 指标**：`navigator.serviceWorker.controller` 命中率、缓存命中率、`push` 送达数、`notificationclick` 打开率 → 通过现有事件通道回传 host。
- **配额监控**：`navigator.storage.estimate()`，超 80% 触发清理 `api-readonly-v1`。
- **灰度开关**：`VITE_ENABLE_PWA` 编译期开关；`VITE_ENABLE_PUSH` 运行时开关（远端配置）。发现回归可下发禁用，SW 内置 `self.registration.unregister()` kill-switch 路径 `/__sw_kill`。
- **版本可见性**：SW 里内嵌 `BUILD_ID`，`postMessage({type:'version'})` 供前端在"关于"页展示。
- **HTTPS 前置**：Service Worker + Push 强依赖 HTTPS。文档中明确：本地 `localhost` 可用；部署必须走反代（Caddy/Nginx）提供 TLS，否则 PWA 能力全部失效。

---

## 8. 测试计划

| 层级 | 工具 | 用例 |
|---|---|---|
| 单元 | Vitest | `pwa.ts` 更新回调、`useOnline`、push 订阅 payload 序列化、tag 去重 |
| SW | Workbox `injectManifest` dry-run + Playwright | 首次加载 → 离线刷新 → 显示壳；`/api` NetworkFirst 超时回落 |
| E2E | Playwright（Chromium/WebKit） | 安装横幅出现；`display-mode: standalone` 生效；push 模拟（Chromium `--enable-features=...`）触发通知点击回到窗口 |
| 手工 | iOS Safari 真机 | 添加到主屏、启动画面、standalone 下 push |
| 回归 | 现有 dashboard 测试 | 确认 SW 不拦截 `/ws`、`/events` |

Lighthouse PWA 分数目标 ≥ 90；性能预算：首屏 JS ≤ 现值 +5%。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SW 缓存了旧 `index.html`，用户看到旧 UI 调用新 API 报错 | `index.html` 用 NetworkFirst + 版本探针；`onNeedRefresh` 强提示 |
| SW 拦截 WebSocket/SSE 导致长连接异常 | `navigateFallbackDenylist` + 手工 e2e 校验；SW 内 `fetch` handler 显式跳过 upgrade 请求 |
| Push 泄露敏感信息 | payload 白名单字段；正文只做提示，详情跳链后由已登录会话拉取 |
| 用户拒绝通知后无法再次弹权限 | UI 检测 `Notification.permission === 'denied'`，展示"到浏览器站点设置开启"引导 |
| iOS 只有 standalone 才有 push | UI 分支引导先"添加到主屏" |
| 老会话在自动 reload 时丢失草稿 | 更新提示改为手动确认；草稿写入 `localStorage` 双保险 |
| 多标签下重复弹通知 | SW push 用 `tag`；前台标签用 BroadcastChannel 选主，只有主标签展示应用内 toast |

---

## 10. 交付清单（PR 拆分建议）

1. `feat(dashboard): manifest + icons + iOS meta`（无 SW，纯可安装度提升）。
2. `feat(dashboard): service worker with app shell precache + update prompt`。
3. `feat(dashboard): runtime caching for read-only api + offline banner`。
4. `feat(host): web-push endpoints & dispatcher`（含迁移与配置文档）。
5. `feat(dashboard): push subscription UI wired to existing notification prefs`。
6. `feat(dashboard): standalone/WCO polish + iOS splash`。
7. `chore: pwa metrics & kill-switch`。

每个 PR 独立可回滚，前 3 个不影响后端。

---

如需，我可以直接从 **PR#1（manifest + 图标 + iOS meta）** 开始落地，先跑通"可安装"，再逐步推进后续阶段。

---

## Appendix A — Why PWA over native (decision record)

Reproduced verbatim from the earlier turn in the same design session
(seq 1466). Kept here so future readers do not re-litigate the choice.

先说结论：**PWA（可安装的 Web App）**，不是原生。

理由按重要度：

## 1. 你的应用形态跟原生的优势不匹配

原生（RN / Flutter / Swift+Kotlin）真正赢的场景是：
- 深度硬件访问（相机、蓝牙、生物识别、后台定位）
- 极致 UI 性能（60fps 手势、复杂动画、游戏）
- 平台深度集成（Widget、Live Activity、Siri Shortcut）
- 离线优先（本地数据库、复杂同步）

你的应用是**agent 控制台**：
- 聊天/timeline/diff/文件浏览——都是**文本 + 列表 + 编辑器**
- 需要**长连 socket** 才能用（离线基本没意义，agent 在服务器跑）
- 核心 UI 就是 Monaco / DiffEditor / 各种 Panel——**这些本来就是 web tech**
- 没有相机、GPS、蓝牙需求

原生的优势项你一个都用不上。

## 2. 你现有的资产 100% 是 web

Dashboard 是 React + Tailwind + Monaco + Socket.IO + sonner + i18next + shadcn。这堆东西：
- **PWA**：零改动直接跑（响应式 layout 你已经做了：sm:/md: 断点、`env(safe-area-inset-bottom)`、Composer flip 卡片、attention popover 是 `fixed inset-x-2 bottom-...`）
- **RN**：Monaco 不能用（要换 CodeMirror 6 的 RN 移植，diff editor 基本没现成的），shadcn 不能用，Tailwind 要换 nativewind，socket.io-client 要换 RN 版本，i18next 部分能用。**等于重写 60%+ UI**
- **Flutter**：Dart 重写 100%
- **Swift+Kotlin**：写两遍

你现在一个人（看仓库形态）维护这么大摊 dashboard，再养一个原生 codebase = 迭代速度腰斩。

## 3. 移动端痛点用 PWA 都能治

- **安装到主屏**：manifest + service worker，iOS 16.4+ / Android 都支持"添加到主屏"，图标、启动画面、隐藏浏览器 chrome
- **通知**：Web Push 在 Android 早就有，iOS 16.4+ 也支持了（要求装到主屏后才能订阅）
- **后台保活**：agent 在服务器跑，本来就不需要客户端保活。手机锁屏了 agent 继续跑，回来看结果
- **离线**：service worker 缓存 dashboard 静态资源，socket 断了显示 offline banner（你已经有这个了）
- **文件访问**：File System Access API + `<input type="file">` + drag-drop，够用
- **性能**：Monaco 在移动 Safari 上有点重但能跑；真嫌卡可以在窄屏切成只读 `<pre>` + diff 显示

## 4. 唯一可能倒向原生的场景

**如果**你未来要做这些，才需要重新评估：
- Screen recording / screen sharing 让 agent 看用户手机屏幕
- 通过手机拍照/录音喂 multimodal agent
- iOS Share Sheet / Android Intent 让别的 app "分享到 agent-kernel"
- Widget 显示"当前 session 状态"在主屏
- Siri / Google Assistant 语音触发 agent

**目前你这个产品都不需要**。真需要时可以再套一层：Capacitor / Tauri Mobile 把现有 PWA 打包成原生 shell，只在需要原生 API 的地方开小窗，不用重写 UI。这是渐进路径，不是二选一。

## 具体建议：三步走

**Step 1（1-2 天）：把现有 dashboard 变成合格 PWA**
- 加 `manifest.webmanifest`（icon、name、theme_color、display: standalone、start_url）
- 加最小 service worker（cache-first for hashed assets, network-first for `/index.html`, offline fallback）
- 验证 iOS Safari / Android Chrome "添加到主屏" 后启动看不到浏览器地址栏
- Lighthouse PWA audit 拿到 installable

**Step 2（移动端 UX 打磨）**
- 你已经有响应式（sm/md/lg 断点），但要 review 一遍：Composer 在窄屏是否好用？attention/context popover 是否遮住 composer？transcript 长按选择是否顺？
- 底部安全区 (`env(safe-area-inset-bottom)`) 已经用了 ✓
- 顶部导航在窄屏折成汉堡菜单？还是底部 tab bar？（我建议底部 tab bar，符合 iOS/Android 习惯）
- 键盘弹出时 Composer 是否被顶上去？（visualViewport API）

**Step 3（按需加原生外壳）**
- 如果发现某个功能真的必须原生（例如后台推送延迟无法接受、需要相机），再用 Capacitor 套壳，只暴露那一个 native module 给 web 层
- 不要一开始就套 —— 套了之后 App Store 审核、签名、TestFlight 分发都是新成本

---

**一句话**：你的产品是"跑在服务器上的 agent 的浏览器界面"，移动端也应该保持"浏览器界面"这个本性，而不是伪装成 App。PWA 满足 95% 的需求，剩下 5% 等真的痛了再上 Capacitor。

要我把 Step 1 的 PWA 骨架搭起来吗？也可以先说你要设计的下一个事，一并规划。
