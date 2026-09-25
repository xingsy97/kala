import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('native window stays menu-free with local keyboard shortcuts and safe close fallback', () => {
  const native = read('../src-tauri/src/main.rs')
  const config = JSON.parse(read('../src-tauri/tauri.conf.json'))
  const html = read('../frontend/index.html')
  assert.doesNotMatch(native, /MenuItem|Submenu|set_menu|on_menu_event|xdg-open|history\.back|WindowEvent::Destroyed/)
  assert.match(native, /connect_key_press_event/)
  assert.match(native, /WindowEvent::CloseRequested[\s\S]*window\.app_handle\(\)\.exit\(0\)/)
  assert.match(native, /tray::hide_if_available[\s\S]*api\.prevent_close\(\)/)
  assert.match(native, /connect_window_state_event[\s\S]*WindowState::ICONIFIED/)
  assert.match(native, /install_shortcuts\(&dashboard\)/)
  assert.match(native, /install_shortcuts\(&launcher\)/)
  assert.match(native, /\.title\("Kala"\)/)
  assert.match(native, /on_document_title_changed[\s\S]*set_title\("Kala"\)/)
  assert.doesNotMatch(native, /set_title\(&format!|let title = format!\("Kala/)
  assert.equal(config.productName, 'kala-desktop')
  assert.equal(config.app.windows[0].title, 'Kala — Connect')
  assert.equal(config.app.windows[0].width, 560)
  assert.equal(config.app.windows[0].height, 430)
  assert.equal(config.app.windows[0].decorations, false)
  assert.match(config.app.security.csp, /media-src blob:; frame-src blob:; object-src 'none'/)
  assert.doesNotMatch(config.app.security.csp, /media-src[^;]*(?:https?:|'self')/)
  assert.doesNotMatch(config.app.security.csp, /frame-src[^;]*(?:https?:|'self')/)
  assert.match(native, /\.decorations\(false\)/)
  assert.match(html, /class="launcher-heading"[\s\S]*<h1>Kala<\/h1>[\s\S]*data-window-action="minimize"[\s\S]*data-window-action="toggle-maximize"[\s\S]*data-window-action="close"/)
  assert.doesNotMatch(html, /class="titlebar"|<header/)
  const init = read('../src-tauri/src/desktop-init.js')
  assert.match(init, /data-kala-desktop-window-controls-slot[\s\S]*appendChild\(host\)/)
  assert.match(init, /data-docked[\s\S]*background:transparent[\s\S]*box-shadow:none/)
  assert.doesNotMatch(init, /workbench-toolbar[\s\S]*appendChild\(host\)|margin-left:auto|ak-app-shell|kala-desktop-titlebar|viewport-h[^']*- 36px/)
  assert.match(html, /<details>\s*<summary>Help and shortcuts<\/summary>/)
  assert.doesNotMatch(html, /<details[^>]*\bopen|Connection.*menu/)
  assert.match(html, /<details>[\s\S]*Remote servers require HTTPS[\s\S]*Ctrl\+Shift\+O[\s\S]*<\/details>/)
})

test('official tray is minimal and cannot hide an app without registered host support', () => {
  const native = read('../src-tauri/src/tray.rs')
  const cargo = read('../src-tauri/Cargo.toml')
  assert.match(cargo, /tauri = \{ version = "=2\.11\.5", features = \["tray-icon"\] \}/)
  assert.doesNotMatch(native, /set_menu|Submenu|http:|TcpListener/)
  assert.match(native, /"Open Kala"/)
  assert.match(native, /"Change server…"/)
  assert.match(native, /"tray-quit" => \{ crate::placement::capture\(app\); app\.exit\(0\); \}/)
  assert.match(native, /IsStatusNotifierHostRegistered/)
  assert.match(native, /RegisteredStatusNotifierItems/)
  assert.match(native, /fn is_item_activation[\s\S]*interface == Some\("org\.kde\.StatusNotifierItem"\)[\s\S]*Some\("Activate" \| "SecondaryActivate" \| "XAyatanaSecondaryActivate"\)/)
  assert.match(native, /fn only_explicit_activation_of_our_item_restores_the_window/)
  assert.match(native, /for member in \["AboutToShow", "AboutToShowGroup", "Event"\][\s\S]*assert!\(!is_item_activation/)
  const acceptance = read('../scripts/verify-native-gnome.py')
  assert.match(acceptance, /native-menu-dbus-layout\.json/)
  assert.match(acceptance, /wait_for\(painted_menu_labels/)
  assert.match(acceptance, /Opening the native tray menu stole focus/)
  assert.match(native, /bus == owner/)
  assert.match(native, /!state\.available\.load[\s\S]*return false/)
  assert.match(native, /!state\.available\.load[\s\S]*restore\(&restore_handle\)/)
  assert.match(native, /item\.split_once\('@'\)/)
  assert.match(native, /Probe::Unknown/)
  assert.match(native, /keep_open_when_uncertain/)
  assert.match(native, /temp_dir_path\(app\.path\(\)\.app_cache_dir/)
  assert.match(native, /com\.canonical\.dbusmenu[\s\S]*"opened"[\s\S]*"closed"[\s\S]*from_millis\(700\)/)
  assert.doesNotMatch(native, /show_menu_on_left_click/)
  assert.match(acceptance, /Double-clicking the native tray icon did not restore Kala/)
  const icon = readFileSync(new URL('../src-tauri/icons/icon.png', import.meta.url))
  assert.equal(icon[24], 8, 'Tray requires an RGBA8 PNG, not a 16-bit image')
  assert.equal(icon[25], 6)
})

async function launcherPage({ saved = null, legacy = null, autoConnect = false, failure = '' } = {}) {
  const nodes = Object.fromEntries(['endpoint', 'status', 'submit', 'connect'].map(id => [id, { value: 'http://remote.example', textContent: '' }]))
  let submitHandler
  const events = new Map(), calls = []
  nodes.connect.addEventListener = (_, callback) => { submitHandler = callback }
  const window = {
    addEventListener: (name, handler) => events.set(name, handler),
    __TAURI__: { core: { invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'launcher_bootstrap') return { origin: saved, autoConnect }
      if (failure) throw failure
      return args.endpoint
    } } },
  }
  vm.runInNewContext(read('../frontend/launcher.js'), {
    document: {
      getElementById: id => nodes[id],
      querySelectorAll: () => [],
      querySelector: () => ({ addEventListener() {} }),
    },
    localStorage: { getItem: () => legacy, setItem: () => assert.fail('Native confirmed settings are the only write source') },
    window, console,
  })
  await new Promise(resolve => setImmediate(resolve))
  return { nodes, window, calls, events, submit: () => submitHandler({ preventDefault() {} }) }
}

test('local launcher exposes validation errors and never remembers a merely accepted WebView', async () => {
  const { nodes, window, calls, submit } = await launcherPage({ failure: 'Use an HTTPS origin.' })
  await submit()
  assert.equal(nodes.status.textContent, 'Use an HTTPS origin.')
  assert.equal(nodes.submit.disabled, false)
  window.__TAURI__.core.invoke = async () => 'https://dashboard.example'
  await submit()
  assert.equal(nodes.endpoint.value, 'https://dashboard.example')
  assert.equal(nodes.status.textContent, '')
  assert.equal(calls[0].command, 'launcher_bootstrap')
})

test('normal startup automatically reuses native saved origin rather than stale localStorage', async () => {
  const { nodes, calls, events } = await launcherPage({ saved: 'https://saved.example', legacy: 'https://old.example', autoConnect: true })
  assert.equal(nodes.endpoint.value, 'https://saved.example')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { command: 'launcher_bootstrap' },
    { command: 'connect', args: { endpoint: 'https://saved.example' } },
  ])
  events.get('runlab:connection-error')({ detail: 'Network unavailable. Retry or change server.' })
  assert.match(nodes.status.textContent, /Network unavailable/)
  assert.equal(nodes.submit.disabled, false)
})

test('explicit Change server/reloaded launcher stays editable without reconnecting automatically', async () => {
  const { nodes, calls } = await launcherPage({ saved: 'https://saved.example', autoConnect: false })
  assert.equal(nodes.endpoint.value, 'https://saved.example')
  assert.equal(calls.length, 1)
  assert.equal(nodes.submit.disabled, false)
  assert.match(read('../src-tauri/src/connection.rs'), /bootstrapped\.swap\(true/)
  assert.doesNotMatch(read('../src-tauri/src/desktop.rs'), /remember_origin/)
  assert.match(read('../src-tauri/src/connection.rs'), /remember_origin\(origin\)\?/)
})

test('desktop release versions stay in sync without changing dependencies', () => {
  const version = JSON.parse(read('../package.json')).version
  assert.equal(version, '0.2.0-rc.13')
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, version)
  assert.match(read('../src-tauri/Cargo.toml'), /name = "kala-desktop"[\s\S]*version = "0\.2\.0-rc\.13"/)
  assert.match(read('../src-tauri/Cargo.lock'), /name = "kala-desktop"\nversion = "0\.2\.0-rc\.13"/)
})

test('connect remains local; selected-origin v1 UI hints get no general native privileges', () => {
  const config = JSON.parse(read('../src-tauri/tauri.conf.json'))
  const capability = JSON.parse(read('../src-tauri/capabilities/launcher.json'))
  assert.deepEqual(config.bundle.targets, ['deb'])
  assert.deepEqual(config.app.security.capabilities, ['launcher'])
  assert.deepEqual(capability.windows, ['launcher'])
  assert.deepEqual(capability.permissions, ['allow-connect', 'allow-window-control'])
  const windowPermission = read('../src-tauri/permissions/window-control.toml')
  assert.match(windowPermission, /commands\.allow = \["desktop_window"\]/)
  assert.doesNotMatch(windowPermission, /shell|filesystem|allow-connect/)
  const main = read('../src-tauri/src/main.rs')
  const desktopUiPermission = read('../src-tauri/permissions/desktop-ui.toml')
  assert.match(main, /authorize_window_control[\s\S]*authorize_dashboard/)
  assert.match(main, /desktop_clipboard_image[\s\S]*authorize_dashboard/)
  assert.match(main, /8192[\s\S]*40_000_000[\s\S]*20 \* 1024 \* 1024/)
  assert.match(desktopUiPermission, /desktop_clipboard_image/)
  assert.doesNotMatch(desktopUiPermission, /clipboard_text|read_text/)
  assert.match(main, /"start-dragging"[\s\S]*"minimize"[\s\S]*"toggle-maximize"[\s\S]*"close"/)
  assert.equal(capability.local, true)
  assert.equal(capability.remote, undefined)
  assert.match(read('../src-tauri/src/main.rs'), /window\.label\(\) != "launcher"/)
  assert.match(read('../src-tauri/src/main.rs'), /NewWindowResponse::Deny/)
  assert.match(read('../src-tauri/src/main.rs'), /set_do_overwrite_confirmation\(true\)/)
  assert.match(read('../src-tauri/src/main.rs'), /\.data_directory\(profile\)/)
  const desktop = read('../src-tauri/src/desktop.rs')
  assert.match(desktop, /\.local\(false\)\.window\("dashboard"\)\.remote\(format!\("\{origin\}\/\*"\)\)\.permission\("allow-desktop-ui"\)/)
  assert.match(desktop, /window\.label\(\) != "dashboard"/)
  assert.match(desktop, /ascii_serialization\(\) != origin/)
  assert.match(desktop, /deny_unknown_fields/)
  assert.match(desktop, /native\.is_active\(\) && visible/)
  assert.match(desktop, /org\.freedesktop\.Notifications/)
  assert.match(desktop, /"suppress-sound", notice\.silent\.to_variant\(\)/)
  assert.match(desktop, /validate_notice/)
  assert.doesNotMatch(read('../src-tauri/permissions/desktop-ui.toml'), /shell|filesystem|allow-connect/)
})

test('single instance and canonical session links run before native windows and never autostart', () => {
  const main = read('../src-tauri/src/main.rs')
  assert.ok(main.indexOf('desktop::instance()') < main.indexOf('tauri::Builder::default()'))
  const desktop = read('../src-tauri/src/desktop.rs')
  assert.match(desktop, /app\.is_remote\(\)/)
  assert.match(desktop, /agent-runlab:\/\/session\//)
  assert.match(read('../src-tauri/desktop.desktop'), /MimeType=x-scheme-handler\/agent-runlab;/)
  assert.doesNotMatch(read('../src-tauri/desktop.service'), /Restart=|WantedBy=|autostart/)
})

test('window persistence remains private and updates are Dashboard-only', () => {
  const placement = read('../src-tauri/src/placement.rs')
  assert.match(placement, /Permissions::from_mode\(0o700\)/)
  assert.match(placement, /\.mode\(0o600\)/)
  assert.match(placement, /wayland/)
  assert.doesNotMatch(read('../src-tauri/src/main.rs'), /updates::|mod updates|sudo|pkexec/)
  assert.doesNotMatch(read('../frontend/launcher.js'), /desktop-update|updateAvailable/)
})

function nativePage(url = 'https://dashboard.example/') {
  const handlers = new Map()
  const calls = []
  const window = {}
  let click
  class Element {
    target = '_blank'
    closest() { return this }
    hasAttribute() { return false }
  }
  window.addEventListener = (name, handler) => handlers.set(name, handler)
  window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push({ command, args }); return command === 'desktop_status' ? { version: '0.2.0-rc.5', focused: true, visible: true } : undefined } } }
  const location = { href: url }
  const history = { state: {}, replaceState: (_state, _title, value) => { location.href = String(value) } }
  vm.runInNewContext(read('../src-tauri/src/desktop-init.js'), {
    window, Element, URL, location, history, document: { addEventListener: (_, handler) => { click = handler } },
  })
  return { window, Element, handlers, calls, location, click }
}

test('desktop marker and public v1 bridge cannot be replaced; blank links remain unprivileged', () => {
  const { window, Element, click } = nativePage()
  assert.equal(window.__RUNLAB_DESKTOP__, true)
  assert.equal(Object.getOwnPropertyDescriptor(window, '__RUNLAB_DESKTOP__').writable, false)
  assert.equal(Object.getOwnPropertyDescriptor(window, '__RUNLAB_DESKTOP_BRIDGE__').writable, false)
  assert.equal(Object.isFrozen(window.__RUNLAB_DESKTOP_BRIDGE__), true)
  const link = new Element()
  click({ target: link })
  assert.equal(link.target, '_self')
})

test('public v1 methods preserve exact payloads and promise errors', async () => {
  const { window, calls } = nativePage()
  const bridge = window.__RUNLAB_DESKTOP_BRIDGE__
  assert.equal(bridge.version, 1)
  assert.deepEqual(Object.keys(bridge).sort(), ['confirmConnection', 'getInfo', 'notify', 'readClipboardImage', 'setActivity', 'subscribe', 'version'])
  assert.equal((await bridge.getInfo()).version, '0.2.0-rc.5')
  const activity = { status: 'running', running: 1, attention: 0, completed: 0 }
  const notice = { id: 'done:abc.1', sessionId: 'session:abc.1', title: 'Kala', body: 'A session completed.', silent: true }
  await bridge.setActivity(activity)
  await bridge.notify(notice)
  await bridge.readClipboardImage()
  await bridge.confirmConnection()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { command: 'desktop_status' },
    { command: 'desktop_ui', args: { state: activity } },
    { command: 'desktop_notify', args: { notification: notice } },
    { command: 'desktop_clipboard_image' },
    { command: 'desktop_connection_ready' },
  ])
  window.__TAURI__.core.invoke = async () => { throw new Error('Native delivery unavailable') }
  await assert.rejects(bridge.notify(notice), /Native delivery unavailable/)
})

test('cold native link is queued until subscription and current-window events never reload', () => {
  const page = nativePage('https://dashboard.example/?desktopSession=cold:session.1#/docs')
  const events = []
  const unsubscribe = page.window.__RUNLAB_DESKTOP_BRIDGE__.subscribe(event => events.push(JSON.parse(JSON.stringify(event))))
  assert.deepEqual(events, [{ type: 'open-session', sessionId: 'cold:session.1' }])
  assert.equal(page.location.href, 'https://dashboard.example/#/docs')
  page.handlers.get('runlab:window-state')({ detail: { focused: false, visible: false } })
  page.handlers.get('runlab:navigate-session')({ detail: { sessionId: 'valid.session:2_-'}})
  page.handlers.get('runlab:navigate-session')({ detail: { sessionId: 'invalid/id'}})
  assert.deepEqual(events.slice(1), [{ type: 'window-state', focused: false, visible: false }, { type: 'open-session', sessionId: 'valid.session:2_-' }])
  unsubscribe()
  page.handlers.get('runlab:window-state')({ detail: { focused: true, visible: true } })
  assert.equal(events.length, 3)
})

async function installPage(response, checks = true) {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: id === 'available', addEventListener() {} })
    return nodes.get(id)
  }
  const requests = []
  const releaseData = read('../../dashboard/public/downloads/desktop/release-data.js').replace(/^export /gm, '')
  const install = read('../../dashboard/public/downloads/desktop/install.js').replace(/^import .* from '\.\/release-data\.js'\n/, '')
  const run = vm.runInNewContext(`(async () => { ${releaseData}\n${install} })()`, {
    document: { getElementById: node },
    location: { origin: 'https://dashboard.example' },
    AbortSignal,
    URL,
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url === '/downloads/desktop/release.json') return response
      return { ok: checks, headers: { get: () => checks ? 'application/octet-stream' : 'text/html' } }
    },
  })
  await run
  return { nodes, requests }
}

const good = {
  schemaVersion: 2, platform: 'linux-amd64', version: '0.2.0~rc.1',
  artifact: { file: 'kala-desktop_0.2.0~rc.1_amd64.deb', sha256: 'a'.repeat(64), size: 1234 },
  dependencies: { file: `0.2.0~rc.1-${'a'.repeat(64)}.dependencies.json`, sha256: 'b'.repeat(64) },
  checksums: { file: `0.2.0~rc.1-${'a'.repeat(64)}.SHA256SUMS.txt`, sha256: 'c'.repeat(64) },
}

test('download entry exposes only existing validated local artifacts', async () => {
  const { nodes, requests } = await installPage({ ok: true, json: async () => good })
  assert.equal(nodes.get('available').hidden, false)
  assert.equal(nodes.get('deb').href, `/downloads/desktop/${good.artifact.file}`)
  assert.match(nodes.get('commands').textContent, /bash -o pipefail[\s\S]*\/install\/assets\/desktop-install\.sh/)
  assert.doesNotMatch(nodes.get('commands').textContent, /\n|ignore-missing|; exit "\$status"/)
  assert.match(nodes.get('commands').textContent, /Cloudflare Access/)
  assert.equal(nodes.get('manifest').href, `/downloads/desktop/${good.dependencies.file}`)
  assert.equal(requests.filter(({ options }) => options.method === 'HEAD').length, 3)
})

test('unpublished, incomplete or unsafe releases never expose a download link', async () => {
  for (const metadata of [
    { ok: false },
    { ok: true, json: async () => ({ ...good, artifact: { ...good.artifact, file: '../../secret.deb' } }) },
    { ok: true, json: async () => ({ ...good, artifact: { ...good.artifact, file: 'https://evil.example/package.deb' } }) },
    { ok: true, json: async () => ({ ...good, checksums: { ...good.checksums, file: 'SHA256SUMS.txt' } }) },
  ]) {
    const { nodes } = await installPage(metadata)
    assert.notEqual(nodes.get('available')?.hidden, false)
    assert.equal(nodes.get('deb')?.href, undefined)
  }
  const { nodes } = await installPage({ ok: true, json: async () => good }, false)
  assert.equal(nodes.get('deb')?.href, undefined)
})
