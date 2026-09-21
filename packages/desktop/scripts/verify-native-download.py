#!/usr/bin/env python3
"""Exercise the GTK save prompt without WebKitWebDriver's download restrictions."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time


output = Path(os.environ.get("RUNLAB_DESKTOP_EVIDENCE", ".artifacts")).resolve()
output.mkdir(parents=True, exist_ok=True)
runtime = output / "download-runtime"
runtime.mkdir(mode=0o700, exist_ok=True)
env = {**os.environ, "DISPLAY": "127.0.0.1:98", "TMPDIR": str(runtime),
       "XDG_RUNTIME_DIR": str(runtime), "DBUS_SESSION_BUS_ADDRESS": f"unix:abstract=runlab-desktop-test-{os.getpid()}",
       "XDG_DATA_HOME": str(runtime / "data"), "XDG_CONFIG_HOME": str(runtime / "config"),
       "XDG_CACHE_HOME": str(runtime / "cache")}
env.pop("TAURI_WEBVIEW_AUTOMATION", None)
processes = []
logs = []
requested = []
browser_checks = []
page_requests = []
binary = os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/kala-desktop")


class Fixture(BaseHTTPRequestHandler):
    def do_POST(self):
        browser_checks.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/file.txt":
            requested.append(True)
            body = b"Desktop native download confirmation test.\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="desktop-check.txt"')
        else:
            page_requests.append(self.path)
            body = b'''<!doctype html><title>Desktop download fixture</title><a href="/file.txt" download autofocus>Download fixture</a>
<script>
(async () => {
  let denied = false;
  try { await window.__TAURI__.core.invoke('connect', {endpoint:'https://example.org'}); }
  catch { denied = true; }
  const bridge=window.__RUNLAB_DESKTOP_BRIDGE__;
  const info=await bridge.getInfo();
  await bridge.setActivity({status:'idle',running:0,attention:0,completed:0});
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'O',ctrlKey:true,shiftKey:true,bubbles:true}));
  await fetch('/checks', {method:'POST',body:JSON.stringify({remoteIpcDenied:denied,desktopMarker:window.__RUNLAB_DESKTOP__ === true,bridgeVersion:bridge.version,version:info.version})});
})();
</script>'''
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()


def start(name, args):
    log = open(output / f"{name}.log", "w")
    logs.append(log)
    processes.append(subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT))
    return processes[-1]


def xdo(*args):
    return subprocess.run(["xdotool", *args], env=env, text=True, capture_output=True)


def window_named(name):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        found = xdo("search", "--onlyvisible", "--name", name)
        if found.returncode == 0 and found.stdout.strip():
            return found.stdout.splitlines()[-1]
        time.sleep(0.2)
    raise AssertionError(f"Native window not found: {name}")


def connect_to(launcher, origin):
    xdo("windowfocus", launcher)
    # The compact launcher's endpoint is autofocus, with no native menu taking focus.
    xdo("mousemove", "--window", launcher, "250", "166", "click", "1")
    xdo("key", "ctrl+a")
    xdo("type", "--clearmodifiers", origin)
    xdo("key", "Return")


def screenshot(window, name):
    subprocess.run(["import", "-display", env["DISPLAY"], "-window", window, str(output / name)],
                   env=env, check=True)


def listening_ports():
    return subprocess.check_output(["ss", "-H", "-ltn"], env=env, text=True).splitlines()


def close_window(window):
    # Send the same WM_DELETE_WINDOW protocol as a window manager's close button,
    # not XDestroyWindow (which skips GTK/Tauri's normal CloseRequested event).
    class Data(ctypes.Union):
        _fields_ = [("l", ctypes.c_long * 5), ("b", ctypes.c_char * 20)]

    class ClientMessage(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                    ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                    ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("data", Data)]

    class Event(ctypes.Union):
        _fields_ = [("client", ClientMessage), ("pad", ctypes.c_long * 24)]

    xlib = ctypes.CDLL("libX11.so.6")
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    xlib.XFlush.argtypes = [ctypes.c_void_p]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(env["DISPLAY"].encode())
    assert display
    try:
        event = Event()
        event.client.type = 33
        event.client.display = display
        event.client.window = int(window)
        event.client.message_type = xlib.XInternAtom(display, b"WM_PROTOCOLS", 0)
        event.client.format = 32
        event.client.data.l[0] = xlib.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
        assert xlib.XSendEvent(display, int(window), 0, 0, ctypes.byref(event))
        xlib.XFlush(display)
    finally:
        xlib.XCloseDisplay(display)


def verify_tray():
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
    bus = Gio.DBusConnection.new_for_address_sync(
        env["DBUS_SESSION_BUS_ADDRESS"],
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        None, None)

    def call(destination, path, interface, method, signature=None, args=()):
        parameters = GLib.Variant(signature, args) if signature else None
        return bus.call_sync(destination, path, interface, method, parameters, None,
                             Gio.DBusCallFlags.NO_AUTO_START, 2000, None).unpack()

    def watcher_call(method, signature=None, args=()):
        return call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                    "io.runlab.TrayTest", method, signature, args)

    def wait_for(predicate, description):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return
            except GLib.Error:
                pass
            time.sleep(0.1)
        raise AssertionError(description)

    def visible(window):
        return window in xdo("search", "--onlyvisible", "--name", ".*").stdout.splitlines()

    def registered():
        items = call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                     "org.freedesktop.DBus.Properties", "GetAll", "(s)",
                     ("org.kde.StatusNotifierWatcher",))[0]["RegisteredStatusNotifierItems"]
        return items

    def set_minimized(window, minimized):
        # Send the same EWMH state change a window manager sends after minimizing.
        xlib = ctypes.CDLL("libX11.so.6")
        xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        xlib.XOpenDisplay.restype = ctypes.c_void_p
        xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        xlib.XInternAtom.restype = ctypes.c_ulong
        xlib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                        ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
        xlib.XFlush.argtypes = [ctypes.c_void_p]
        xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        display = xlib.XOpenDisplay(env["DISPLAY"].encode())
        assert display
        try:
            prop = xlib.XInternAtom(display, b"_NET_WM_STATE", 0)
            hidden = xlib.XInternAtom(display, b"_NET_WM_STATE_HIDDEN", 0)
            values = (ctypes.c_ulong * 1)(hidden)
            xlib.XChangeProperty(display, int(window), prop, 4, 32, 0, values, 1 if minimized else 0)
            xlib.XFlush(display)
        finally:
            xlib.XCloseDisplay(display)

    def registered_app(name):
        app = start(name, [binary])
        launcher = window_named("Kala.*Connect")
        wait_for(registered, "Tray item did not register with the native watcher")
        time.sleep(1)
        item = registered()[-1]
        destination, path = item.split("/", 1)
        return app, launcher, destination, "/" + path

    def menu_action(destination, path, label):
        props = call(destination, path, "org.freedesktop.DBus.Properties", "GetAll",
                     "(s)", ("org.kde.StatusNotifierItem",))[0]
        menu = props["Menu"]
        layout = call(destination, menu, "com.canonical.dbusmenu", "GetLayout",
                      "(iias)", (0, -1, []))[1]
        labels = {}

        def visit(node):
            item, properties, children = node
            if "label" in properties:
                labels[properties["label"]] = item
            for child in children:
                visit(child)
        visit(layout)
        assert set(labels) == {"Open Kala", "Change server…", "Quit"}, labels
        call(destination, menu, "com.canonical.dbusmenu", "Event", "(isvu)",
             (labels[label], "clicked", GLib.Variant("i", 0), 0))

    watcher = start("tray-watcher", ["python3", str(Path(__file__).with_name("tray-watcher-fixture.py"))])
    wait_for(lambda: registered() == [], "Watcher fixture did not start")
    app, launcher, destination, path = registered_app("tray-app")
    time.sleep(1)
    connect_to(launcher, f"http://127.0.0.1:{server.server_port}")
    dashboard = window_named("^Kala$")
    time.sleep(1)
    count = len(page_requests)
    close_window(dashboard)
    wait_for(lambda: not visible(dashboard), "Close did not hide to tray")
    assert app.poll() is None
    screenshot("root", "native-hidden-in-tray.png")
    # AppIndicator hosts request the exported DBusMenu on icon click.
    props = call(destination, path, "org.freedesktop.DBus.Properties", "GetAll",
                 "(s)", ("org.kde.StatusNotifierItem",))[0]
    call(destination, props["Menu"], "com.canonical.dbusmenu", "AboutToShow", "(i)", (0,))
    time.sleep(0.5)
    assert not visible(dashboard), "Opening the tray popup restored the hidden Dashboard"
    menu_action(destination, path, "Open Kala")
    wait_for(lambda: visible(dashboard), "Tray Open did not restore")
    screenshot("root", "native-tray-menu-restored.png")
    xdo("key", "Escape")
    assert len(page_requests) == count, "Tray restore reloaded the existing dashboard"
    set_minimized(dashboard, True)
    wait_for(lambda: not visible(dashboard), "Native minimize state did not hide to tray")
    set_minimized(dashboard, False)
    menu_action(destination, path, "Open Kala")
    wait_for(lambda: visible(dashboard), "Tray menu did not restore minimized dashboard")
    assert len(page_requests) == count
    menu_action(destination, path, "Change server…")
    window_named("Kala.*Connect")
    assert len(page_requests) == count
    menu_action(destination, path, "Open Kala")
    assert visible(dashboard)
    menu_action(destination, path, "Quit")
    assert app.wait(timeout=10) == 0

    watcher_call("ClearItems")
    app, launcher, destination, path = registered_app("tray-uncertain-app")
    watcher_call("FailProperties", "(b)", (True,))
    time.sleep(1)
    close_window(launcher)
    wait_for(lambda: not visible(launcher), "Transient probe failure discarded confirmed tray support")
    assert app.poll() is None
    watcher_call("FailProperties", "(b)", (False,))
    time.sleep(1)
    menu_action(destination, path, "Open Kala")
    wait_for(lambda: visible(launcher), "Tray recovery failed")
    watcher_call("FailProperties", "(b)", (True,))
    time.sleep(7)
    close_window(launcher)
    time.sleep(0.5)
    assert app.poll() is None and visible(launcher), "Uncertain tray response silently exited the app"
    screenshot("root", "native-tray-unresponsive-keeps-open.png")
    watcher_call("FailProperties", "(b)", (False,))
    menu_action(destination, path, "Quit")
    assert app.wait(timeout=10) == 0

    watcher_call("ClearItems")
    app, launcher, _, _ = registered_app("tray-host-loss-app")
    close_window(launcher)
    wait_for(lambda: not visible(launcher), "Launcher close did not hide to tray")
    watcher_call("SetHost", "(b)", (False,))
    wait_for(lambda: visible(launcher), "Missing tray host stranded hidden launcher")
    close_window(launcher)
    assert app.wait(timeout=10) == 0

    watcher_call("SetHost", "(b)", (True,))
    watcher_call("ClearItems")
    app, launcher, _, _ = registered_app("tray-registration-loss-app")
    close_window(launcher)
    wait_for(lambda: not visible(launcher), "Launcher close did not hide to tray")
    watcher_call("ClearItems")
    wait_for(lambda: visible(launcher), "Removed tray registration stranded hidden launcher")
    close_window(launcher)
    assert app.wait(timeout=10) == 0

    app, launcher, _, _ = registered_app("tray-watcher-loss-app")
    close_window(launcher)
    wait_for(lambda: not visible(launcher), "Launcher close did not hide to tray")
    watcher.terminate()
    watcher.wait(timeout=10)
    wait_for(lambda: visible(launcher), "Tray watcher loss stranded hidden launcher")
    close_window(launcher)
    assert app.wait(timeout=10) == 0
    return {"registeredTrayCloseHides": True, "registeredTrayMinimizeHides": True,
            "nativeTrayOpenRestoresWithoutReload": True, "trayPopupDoesNotStealFocus": True,
            "transientProbeFailureKeepsTray": True, "prolongedProbeFailureKeepsWindowReachable": True,
            "minimalTrayMenu": True, "trayChangeServerUsesLocalLauncher": True, "trayQuitExits": True,
            "lostHostRestores": True, "lostRegistrationRestores": True, "lostWatcherRestores": True}


try:
    start("download-xvfb", ["Xvfb", ":98", "-screen", "0", "1440x1000x24", "-nolisten", "unix", "-listen", "tcp", "-nolock", "-ac"])
    dbus = start("download-dbus", ["dbus-daemon", "--session", "--nofork", f"--address={env['DBUS_SESSION_BUS_ADDRESS']}"])
    time.sleep(1)
    assert dbus.poll() is None, "Native test session bus failed to start"
    subprocess.run(["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus",
                    "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"],
                   env=env, check=True, capture_output=True)
    baseline_ports = listening_ports()
    app = start("download-app", [binary])
    launcher = window_named("Kala.*Connect")
    xdo("windowfocus", launcher)
    deadline = time.monotonic() + 15
    while True:
        screenshot(launcher, "native-launcher-screen.png")
        pixel = subprocess.check_output(
            ["convert", str(output / "native-launcher-screen.png"), "-format", "%[pixel:p{0,0}]", "info:"],
            env=env, text=True).strip()
        if pixel == "srgb(17,24,39)":
            break
        assert time.monotonic() < deadline, "Launcher did not render"
        time.sleep(0.2)
    xdo("key", "Tab", "Tab", "Return")
    time.sleep(0.2)
    screenshot(launcher, "native-launcher-help.png")
    xdo("key", "Return")
    connect_to(launcher, "http://remote.example")
    time.sleep(0.5)
    assert not page_requests
    window_named("Kala.*Connect")
    screenshot(launcher, "native-invalid-origin.png")
    with socket.socket() as refused:
        refused.bind(("127.0.0.1", 0))
        bad_origin = f"http://127.0.0.1:{refused.getsockname()[1]}"
        connect_to(launcher, bad_origin)
        deadline = time.monotonic() + 15
        while f"Unable to load {bad_origin}" not in (output / "download-app.log").read_text():
            assert time.monotonic() < deadline, "First unreachable endpoint did not report its native load error"
            time.sleep(0.1)
        launcher = window_named("Kala.*Connect")
        settings_path = Path(env["XDG_CONFIG_HOME"]) / "io.github.xingsy97.akernel.desktop/desktop-state.json"
        assert not settings_path.exists() or not json.loads(settings_path.read_text()).get("origin"), "Unreachable first endpoint was remembered"
        screenshot(launcher, "native-first-endpoint-error.png")
    connect_to(launcher, f"http://127.0.0.1:{server.server_port}")
    dashboard = window_named("^Kala$")
    assert xdo("getwindowname", dashboard).stdout.strip() == "Kala", "Remote title or endpoint leaked into native title"
    xdo("windowfocus", dashboard)
    time.sleep(1)
    assert xdo("search", "--onlyvisible", "--name", "Kala.*Connect").returncode != 0
    screenshot(dashboard, "native-menu-free-dashboard.png")
    # With no menu bar the HTML viewport starts at the top of the native window.
    top_pixel = subprocess.check_output(
        ["convert", str(output / "native-menu-free-dashboard.png"), "-format", "%[pixel:p{0,0}]", "info:"],
        env=env, text=True).strip()
    assert top_pixel in ("srgb(255,255,255)", "gray(255)", "gray(255,255,255)"), top_pixel
    count = len(page_requests)
    xdo("key", "ctrl+r")
    deadline = time.monotonic() + 10
    while len(page_requests) == count and time.monotonic() < deadline:
        time.sleep(0.1)
    assert len(page_requests) > count, "Native Ctrl+R did not reload"
    time.sleep(0.5)
    xdo("mousemove", "--window", dashboard, "70", "15", "click", "1")
    dialog = window_named("Save Dashboard download")
    assert requested, "No download request reached the fixture"
    screenshot(dialog, "native-save-confirmation.png")
    xdo("windowfocus", dialog)
    xdo("key", "--window", dialog, "Escape")
    assert not list(Path.cwd().glob("desktop-check*.txt"))
    assert not list(runtime.rglob("desktop-check*.txt"))
    assert browser_checks and browser_checks[0] == {"remoteIpcDenied": True, "desktopMarker": True,
        "bridgeVersion": 1, "version": json.loads(Path("packages/desktop/package.json").read_text())["version"]}, browser_checks
    xdo("windowfocus", dashboard)
    xdo("key", "ctrl+shift+o")
    launcher = window_named("Kala.*Connect")
    count = len(page_requests)
    connect_to(launcher, f"http://127.0.0.1:{server.server_port}")
    dashboard = window_named("^Kala$")
    deadline = time.monotonic() + 10
    while len(page_requests) == count and time.monotonic() < deadline:
        time.sleep(0.1)
    assert len(page_requests) > count, "Reconnect did not navigate the existing dashboard"
    assert listening_ports() == baseline_ports, "Desktop created a listening TCP port"
    live_origin = os.environ.get("RUNLAB_DESKTOP_LIVE_ORIGIN")
    if live_origin:
        xdo("windowfocus", dashboard)
        xdo("key", "ctrl+shift+o")
        launcher = window_named("Kala.*Connect")
        connect_to(launcher, live_origin)
        time.sleep(30)
        screenshot("root", "native-final-live-dashboard.png")
        dashboard = window_named("Kala")
    close_window(dashboard)
    assert app.wait(timeout=10) == 0
    assert xdo("search", "--onlyvisible", "--name", "Kala").returncode != 0
    app = start("quit-app", [binary])
    launcher = window_named("Kala.*Connect")
    time.sleep(0.5)
    xdo("windowfocus", launcher)
    xdo("key", "ctrl+q")
    assert app.wait(timeout=10) == 0
    app = start("launcher-close-app", [binary])
    launcher = window_named("Kala.*Connect")
    close_window(launcher)
    assert app.wait(timeout=10) == 0
    tray_checks = verify_tray() if os.environ.get("RUNLAB_DESKTOP_TEST_TRAY") == "1" else {}
    assert listening_ports() == baseline_ports
    evidence = {"nativeDownloadConfirmation": True, "cancelledWithoutWriting": True,
                "binary": binary, "binarySha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
                "isolatedProfile": True, "nativeKeyboardReconnect": True, "nativeReload": True,
                "nativeQuit": True, "normalDashboardCloseExits": True, "normalLauncherCloseExits": True,
                "noVisibleMenuBar": True, "viewportTopPixel": top_pixel, "noNewListeningPort": True,
                "syntheticRemoteShortcutIgnored": True, "invalidOriginStaysOnLauncher": True,
                "liveHostReconnect": bool(live_origin), "remotePageChecks": browser_checks,
                "trayChecks": tray_checks,
                "automation": "ordinary production native executable + X11 user input, not WebDriver",
                "fixture": "ephemeral loopback-only server, no Host/Runtime changes"}
    (output / "native-download.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
finally:
    print(json.dumps({"downloadRequests": len(requested)}))
    subprocess.run(["import", "-display", env["DISPLAY"], "-window", "root", str(output / "native-download-screen.png")], env=env, capture_output=True)
    server.shutdown()
    server.server_close()
    for process in reversed(processes):
        if process.poll() is not None:
            continue
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    for log in logs:
        log.close()
