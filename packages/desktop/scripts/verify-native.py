#!/usr/bin/env python3
"""Legacy shared-context WebDriver regression probe.

Production uses isolated WebKit contexts for safe downloads. WebKitWebDriver
supports only one automation context, so use verify-native-download.py for the
final installed package; this probe documents pre-isolation integration coverage.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


def main():
    output = Path(os.environ.get("RUNLAB_DESKTOP_EVIDENCE", ".artifacts")).resolve()
    output.mkdir(parents=True, exist_ok=True)
    runtime = output / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    env = {
        **os.environ,
        "TMPDIR": str(runtime),
        "XDG_RUNTIME_DIR": str(runtime),
        "DISPLAY": "127.0.0.1:97",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/session-bus",
        "TAURI_WEBVIEW_AUTOMATION": "true",
    }
    processes = []
    logs = []
    session = None

    def request(method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            f"http://127.0.0.1:4444{path}", data=body, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error
        return value.get("value")

    def start(name, args):
        log = open(output / f"{name}.log", "w")
        logs.append(log)
        processes.append(subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT))

    try:
        # TCP-only X11 with no lock avoids implicit /tmp socket/lock files.
        start("xvfb", ["Xvfb", ":97", "-screen", "0", "1440x1000x24", "-nolisten", "unix", "-listen", "tcp", "-nolock", "-ac"])
        start("dbus", ["dbus-daemon", "--session", "--nofork", f"--address={env['DBUS_SESSION_BUS_ADDRESS']}"])
        start("webkit-driver", ["WebKitWebDriver", "--host=127.0.0.1", "--port=4444"])
        deadline = time.monotonic() + 20
        while True:
            try:
                request("GET", "/status")
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.25)
        result = request("POST", "/session", {
            "capabilities": {"alwaysMatch": {"webkitgtk:browserOptions": {
                "binary": os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop")
            }}}
        })
        session = result["sessionId"]
        prefix = f"/session/{session}"

        def execute(script):
            return request("POST", f"{prefix}/execute/sync", {"script": script, "args": []})

        def async_execute(script):
            return request("POST", f"{prefix}/execute/async", {"script": script, "args": []})

        launcher = request("GET", f"{prefix}/window")
        assert execute("return document.title").startswith("Agent RunLab")
        invalid = async_execute("""
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('connect', {endpoint:'http://remote.example'})
              .then(() => done({allowed:true}), error => done({allowed:false,error:String(error)}));
        """)
        assert invalid["allowed"] is False, invalid
        connected = async_execute("""
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('connect', {endpoint:'http://127.0.0.1:13000'})
              .then(origin => done({origin}), error => done({error:String(error)}));
        """)
        assert connected.get("origin") == "http://127.0.0.1:13000", connected
        handles = request("GET", f"{prefix}/window/handles")
        if len(handles) == 1:
            print(json.dumps({"skipped": "WebKitWebDriver exposes only the launcher context; use verify-native-download.py for the production isolated-profile package"}))
            return
        dashboard = next(handle for handle in handles if handle != launcher)
        request("POST", f"{prefix}/window", {"handle": dashboard})
        deadline = time.monotonic() + 40
        while True:
            state = execute("return {origin:location.origin, ready:document.readyState, text:document.body?.innerText || '', desktop:window.__RUNLAB_DESKTOP__ === true}")
            if state["ready"] == "complete" and len(state["text"]) > 100:
                break
            if time.monotonic() > deadline:
                raise AssertionError(state)
            time.sleep(0.5)
        assert state["origin"] == "http://127.0.0.1:13000", state
        assert state["desktop"] is True, state
        ipc = async_execute("""
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('connect', {endpoint:'https://example.org'})
              .then(() => done({denied:false}), error => done({denied:true,error:String(error)}));
        """)
        assert ipc["denied"], ipc
        session_result = async_execute("""
            const done = arguments[arguments.length - 1];
            fetch('/auth/me', {credentials:'same-origin',signal:AbortSignal.timeout(5000)}).then(async response =>
              done({status:response.status,body:await response.json()})).catch(error => done({error:String(error)}));
        """)
        api = async_execute("""
            const done = arguments[arguments.length - 1];
            fetch('/models', {credentials:'same-origin',signal:AbortSignal.timeout(5000)})
              .then(response => done({status:response.status})).catch(error => done({error:String(error)}));
        """)
        assert api.get("status") == 200, api
        sw = async_execute("""
            const done = arguments[arguments.length - 1];
            if (!navigator.serviceWorker) { done([]); return; }
            navigator.serviceWorker.getRegistrations().then(rs => done(rs.map(r => r.scope)));
        """)
        assert sw == [], sw
        assert execute("return document.querySelector('[data-testid=\"app-shell-download-desktop\"]') === null")
        deadline = time.monotonic() + 30
        while True:
            connection = execute("return document.querySelector('[data-testid=\"connection-status\"]')?.getAttribute('data-status') || null")
            if connection == "ready" or time.monotonic() > deadline:
                break
            time.sleep(1)
        execute("document.querySelector('[data-testid=\"connection-status\"]')?.click(); return true")
        connection_details = execute("return document.querySelector('[data-testid=\"connection-status-popover\"]')?.innerText || ''")
        screenshot = request("GET", f"{prefix}/screenshot")
        (output / "native-dashboard.png").write_bytes(base64.b64decode(screenshot))
        fixture = runtime / "desktop-upload-check.txt"
        fixture.write_text("Desktop file selection smoke test; never submitted.\n")
        execute("const input = document.createElement('input'); input.type='file'; input.id='desktop-upload-check'; document.body.append(input); return true")
        element = request("POST", f"{prefix}/element", {"using": "css selector", "value": "#desktop-upload-check"})
        element_id = element["element-6066-11e4-a52e-4f735466cecf"]
        request("POST", f"{prefix}/element/{element_id}/value", {"text": str(fixture), "value": [str(fixture)]})
        assert execute("return document.querySelector('#desktop-upload-check').files[0].name") == fixture.name
        execute("document.querySelector('#desktop-upload-check').remove(); return true")
        # Reject top-level navigation to local files even though this window has no ACL.
        execute("location.assign('file:///etc/passwd'); return true")
        time.sleep(0.5)
        assert execute("return location.origin") == "http://127.0.0.1:13000"
        evidence = {
            "testedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "binary": "/usr/bin/agent-runlab-desktop",
            "driver": "distribution WebKitWebDriver (real GTK/WebKit)",
            "origin": state["origin"],
            "desktopMarker": state["desktop"],
            "remoteIpcDenied": ipc,
            "insecureOriginRejected": invalid,
            "serviceWorkers": sw,
            "authSession": session_result,
            "sameOriginApi": api,
            "connectionStatus": connection,
            "connectionDetails": connection_details,
            "renderedTextLength": len(state["text"]),
            "localFileNavigationBlocked": True,
            "localFileSelection": True,
            "nativeDownloadConfirmation": "See separate non-WebDriver verify-native-download.py",
        }
        (output / "native-smoke.json").write_text(json.dumps(evidence, indent=2) + "\n")
        request("POST", f"{prefix}/window", {"handle": launcher})
        reconnected = async_execute("""
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('connect', {endpoint:'http://127.0.0.1:13000'})
              .then(origin => done({origin}), error => done({error:String(error)}));
        """)
        assert reconnected.get("origin") == "http://127.0.0.1:13000", reconnected
        evidence["reconnect"] = True
        (output / "native-smoke.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence, indent=2))
    finally:
        if session:
            try:
                request("DELETE", f"/session/{session}")
            except Exception:
                pass
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for log in logs:
            log.close()


if __name__ == "__main__":
    main()
