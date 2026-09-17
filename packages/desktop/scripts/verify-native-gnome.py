#!/usr/bin/env python3
"""Acceptance against distribution GNOME Shell and its real AppIndicator extension."""
import ctypes
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import threading
import time
from urllib.request import Request, urlopen

output = Path(os.environ.get("RUNLAB_DESKTOP_EVIDENCE", ".artifacts/gnome")).resolve()
output.mkdir(parents=True, exist_ok=True)
runtime = output / "runtime"
runtime.mkdir(mode=0o700, exist_ok=True)
env = {**os.environ, "DISPLAY": "127.0.0.1:96", "TMPDIR": str(runtime),
       "XDG_RUNTIME_DIR": str(runtime), "HOME": str(runtime / "home"),
       "XDG_DATA_HOME": str(runtime / "data"), "XDG_CONFIG_HOME": str(runtime / "config"),
       "XDG_CACHE_HOME": str(runtime / "cache"),
       "XDG_SESSION_TYPE": "x11", "XDG_CURRENT_DESKTOP": "GNOME",
       "DBUS_SESSION_BUS_ADDRESS": f"unix:abstract=runlab-gnome-test-{os.getpid()}"}
Path(env["HOME"]).mkdir(exist_ok=True)
env.pop("TAURI_WEBVIEW_AUTOMATION", None)
env.pop("SESSION_MANAGER", None)
if os.environ.get("RUNLAB_DESKTOP_SOFTWARE_GL") == "1":
    env["LIBGL_ALWAYS_SOFTWARE"] = "1"
elif os.environ.get("RUNLAB_DESKTOP_SOFTWARE_GL") == "0":
    env.pop("LIBGL_ALWAYS_SOFTWARE", None)
processes = []
logs = []
page_loads = []
page_checks = []
feature_commands = []
feature_checks = []
feature_failures = []
features = os.environ.get("RUNLAB_DESKTOP_TEST_FEATURES") == "1"
real_dashboard = os.environ.get("RUNLAB_DESKTOP_REAL_DASHBOARD") == "1"
measure_cpu = os.environ.get("RUNLAB_DESKTOP_MEASURE_CPU") == "1"
long_cpu = os.environ.get("RUNLAB_DESKTOP_LONG_CPU") == "1"
background_cpu = os.environ.get("RUNLAB_DESKTOP_BACKGROUND_CPU") == "1"
background_cpu_seconds = int(os.environ.get("RUNLAB_DESKTOP_BACKGROUND_CPU_SECONDS", "90"))
favicon_diagnostic = os.environ.get("RUNLAB_DESKTOP_FAVICON_DIAGNOSTIC") == "1"
render_diagnostic = os.environ.get("RUNLAB_DESKTOP_RENDER_DIAGNOSTIC") == "1"
targeted_cpu = os.environ.get("RUNLAB_DESKTOP_TARGETED_CPU") == "1"
targeted_cpu_seconds = int(os.environ.get("RUNLAB_DESKTOP_TARGETED_CPU_SECONDS", "90"))
composer_diagnostic = os.environ.get("RUNLAB_DESKTOP_COMPOSER_DIAGNOSTIC") == "1"
smooth_diagnostic = os.environ.get("RUNLAB_DESKTOP_SMOOTH_DIAGNOSTIC") == "1"
smooth_case_seconds = int(os.environ.get("RUNLAB_DESKTOP_SMOOTH_CASE_SECONDS", "8"))
smooth_batch = os.environ.get("RUNLAB_DESKTOP_SMOOTH_BATCH", "initial")
cpu_only = os.environ.get("RUNLAB_DESKTOP_CPU_ONLY") == "1"
untrusted_server = None
fixture_trust = None
probe = r"""
const instance=crypto.randomUUID();
const bridge=window.__RUNLAB_DESKTOP_BRIDGE__;
const composer=()=>document.querySelector('[data-testid="composer-input"]')||document.querySelector('input');
let faviconChanges=0;
let heldFavicon=null,heldFaviconWrites=0,pausedSheens=[],pausedThinkingIndicators=[];
let smoothDotRecords=[],smoothSheenClips=[];
new MutationObserver(records=>{
 faviconChanges+=records.filter(r=>r.target instanceof HTMLLinkElement&&r.target.rel==='icon').length;
}).observe(document.head,{subtree:true,attributes:true,attributeFilter:['href']});
async function report() {
 let denied=false; try { await window.__TAURI__.core.invoke('connect',{endpoint:'https://example.org'}); } catch {denied=true;}
 let infoDenied=false; try { await window.__TAURI__.core.invoke('desktop_info'); } catch {infoDenied=true;}
 await fetch('/checks',{method:'POST',body:JSON.stringify({instance,origin:location.origin,at:Date.now(),visibility:document.visibilityState,value:composer()?.value??null,label:document.querySelector('[data-testid="session-label"]')?.textContent??null,connectionStatus:document.querySelector('[data-testid="connection-status"]')?.dataset.status??null,remoteIpcDenied:denied,remoteInfoDenied:infoDenied,bridgeVersion:bridge?.version,updateAvailable:!!document.querySelector('[data-testid="desktop-update-available"]'),updateSecurity:document.querySelector('[data-testid="desktop-release-security"]')?.textContent??null})});
}
document.addEventListener('keydown',e=>{if(e.key==='F8') report()});
let busy=false, subscribed=false;
async function tick(){
 if(busy)return; busy=true;
 try {
  if(!subscribed && composer()){
   subscribed=true;
   bridge.subscribe(e=>fetch('/feature-checks',{method:'POST',body:JSON.stringify({...e,navigate:e.type==='open-session'?e.sessionId:undefined,instance})}));
  }
  for(const command of await (await fetch('/commands')).json()){
   let error=null, result=null;
   try{
    if(command.method==='navigate') { location.href=command.value; continue; }
    else if(command.method==='focusComposer') composer()?.focus();
    else if(command.method==='click') document.querySelector(command.value).click();
    else if(command.method==='blurFocus') document.activeElement?.blur();
    else if(command.method==='holdFavicon'){
     heldFavicon=document.querySelector('link[rel="icon"]');
     const descriptor=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'href');
     Object.defineProperty(heldFavicon,'href',{configurable:true,get(){return descriptor.get.call(this)},set(value){
      if(String(value).startsWith('data:image/svg+xml')){heldFaviconWrites++;return;}
      descriptor.set.call(this,value);
     }});
    }
    else if(command.method==='restoreFavicon'){if(heldFavicon)delete heldFavicon.href;heldFavicon=null;}
    else if(command.method==='pauseThinkingSheen'){pausedSheens=document.getAnimations().filter(a=>a.animationName==='ak-thinking-sheen');pausedSheens.forEach(a=>a.pause());result=pausedSheens.length;}
    else if(command.method==='resumeThinkingSheen'){pausedSheens.forEach(a=>a.play());pausedSheens=[];}
    else if(command.method==='pauseThinkingIndicators'){pausedThinkingIndicators=document.getAnimations().filter(a=>['ak-thinking-sheen','ak-thinking-dot','ak-session-status-spin'].includes(a.animationName));pausedThinkingIndicators.forEach(a=>a.pause());result=pausedThinkingIndicators.length;}
    else if(command.method==='pauseNamedThinkingIndicators'){pausedThinkingIndicators=document.getAnimations().filter(a=>command.value.includes(a.animationName));pausedThinkingIndicators.forEach(a=>a.pause());result=pausedThinkingIndicators.length;}
    else if(command.method==='resumeThinkingIndicators'){pausedThinkingIndicators.forEach(a=>a.play());pausedThinkingIndicators=[];}
    else if(command.method==='diagnosticCss'){let style=document.getElementById('native-cpu-render-control');if(!style){style=document.createElement('style');style.id='native-cpu-render-control';document.head.appendChild(style);}style.textContent=command.value;}
    else if(command.method==='prepareSmoothDom'){
     for(const row of document.querySelectorAll('.ak-thinking-row')){
      const dot=row.querySelector('span.absolute.h-2.w-2');if(dot){smoothDotRecords.push([dot,dot.className]);dot.classList.add('ak-thinking-dot');}
      const css=getComputedStyle(row);row.style.setProperty('--native-panel-background',css.backgroundColor);row.style.setProperty('--native-panel-blur',css.backdropFilter||css.webkitBackdropFilter||'none');
      const clip=document.createElement('span');clip.className='native-sheen-clip';clip.setAttribute('aria-hidden','true');const light=document.createElement('span');light.className='native-sheen-light';clip.append(light);row.append(clip);smoothSheenClips.push(clip);
      row.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
     }
     for(const panel of document.querySelectorAll('.ak-titlebar-surface')){const c=getComputedStyle(panel);panel.style.setProperty('--native-panel-background',c.backgroundColor);panel.style.setProperty('--native-panel-blur',c.backdropFilter||c.webkitBackdropFilter||'none');}
     result=smoothDotRecords.length;
    }
    else if(command.method==='restoreSmoothDom'){smoothDotRecords.forEach(([e,c])=>e.className=c);smoothSheenClips.forEach(e=>e.remove());smoothDotRecords=[];smoothSheenClips=[];document.querySelectorAll('.ak-thinking-row,.ak-titlebar-surface').forEach(e=>{e.style.removeProperty('--native-panel-background');e.style.removeProperty('--native-panel-blur');});}
    else if(command.method==='showSmoothEffects')document.querySelector('.ak-thinking-row')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    else if(command.method==='inspectSheenPointerEvents')result=getComputedStyle(document.querySelector('.ak-thinking-row'),'::after').pointerEvents;
    else if(command.method==='inspectLayers')result=[...document.querySelectorAll('.ak-thinking-row,.ak-session-status-spinner')].map(target=>{
     const ancestors=[];for(let e=target;e&&ancestors.length<12;e=e.parentElement){const c=getComputedStyle(e),r=e.getBoundingClientRect();ancestors.push({tag:e.tagName,classes:e.className,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},overflowX:c.overflowX,overflowY:c.overflowY,background:c.backgroundColor,backdrop:c.backdropFilter||c.webkitBackdropFilter,filter:c.filter,transform:c.transform,contain:c.contain,isolation:c.isolation,willChange:c.willChange});}return ancestors;
    });
    else if(command.method==='inspectRendering'){
     const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl');let webgl=null;
     if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');webgl={vendor:gl.getParameter(ext?ext.UNMASKED_VENDOR_WEBGL:gl.VENDOR),renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),version:gl.getParameter(gl.VERSION)};gl.getExtension('WEBGL_lose_context')?.loseContext();}
     result={webgl,userAgent:navigator.userAgent,devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},backdropSupported:CSS.supports('backdrop-filter','blur(1px)')};
    }
    else if(command.method==='inspectCpu') result={focused:document.hasFocus(),visibility:document.visibilityState,title:document.title,faviconChanges,heldFaviconWrites,faviconDataSvg:document.querySelector('link[rel="icon"]')?.href.startsWith('data:image/svg+xml')??false,activeElement:document.activeElement?.outerHTML?.slice(0,300),caretColor:composer()?getComputedStyle(composer()).caretColor:null,typewriterDone:document.querySelector('[data-testid="typewriter"]')?.dataset.done??null,elapsed:document.querySelector('[data-testid="inline-status-elapsed"]')?.textContent??null,animations:document.getAnimations().map(a=>({name:a.animationName,playState:a.playState,effectDurationMs:a.effect?.getTiming().duration,keyframeEasing:a.effect?.getKeyframes().map(k=>k.easing),cssDuration:a.effect?.target?getComputedStyle(a.effect.target).animationDuration:null,cssTiming:a.effect?.target?getComputedStyle(a.effect.target).animationTimingFunction:null,target:a.effect?.target?.outerHTML?.slice(0,400)}))};
    else result=await bridge[command.method](command.value);
   }catch(e){error=String(e)}
   await fetch('/feature-checks',{method:'POST',body:JSON.stringify({id:command.id,error,result})});
  }
  await report();
 }finally{busy=false}
}
let probeTimer=setInterval(tick,300);
document.addEventListener('keydown',e=>{
 if(e.key==='F9'){clearInterval(probeTimer);probeTimer=null;}
 if(e.key==='F10'&&probeTimer===null)probeTimer=setInterval(tick,300);
});
"""


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/probe.js":
            body = probe.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/commands":
            body = json.dumps(feature_commands[:]).encode()
            feature_commands.clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/downloads/desktop/release.json":
            version = "99.0.0~rc.1"
            body = json.dumps({"schemaVersion": 2, "platform": "linux-amd64", "version": version,
                "artifact": {"file": f"agent-runlab-desktop_{version}_amd64.deb", "sha256": "a" * 64, "size": 1},
                "dependencies": {"file": f"{version}-{'a' * 64}.dependencies.json", "sha256": "b" * 64},
                "checksums": {"file": f"{version}-{'a' * 64}.SHA256SUMS.txt", "sha256": "c" * 64},
                "signature": {"status": "unsigned"}}).encode() if features else b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        page_loads.append(self.path)
        body = ("""<!doctype html><title>Agent RunLab - GNOME acceptance</title>
<h1>GNOME tray acceptance</h1><input autofocus value="native-draft">
<script>""" + probe + "</script>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        (feature_checks if self.path == "/feature-checks" else page_checks).append(value)
        self.send_response(204)
        self.end_headers()

    def do_HEAD(self):
        self.send_response(200 if features and self.path.startswith("/downloads/desktop/") else 404)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", "1")
        self.end_headers()

    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()


def start(name, args):
    log = open(output / f"{name}.log", "w")
    logs.append(log)
    process = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    processes.append(process)
    return process


def run(*args):
    return subprocess.run(args, env=env, text=True, capture_output=True, check=True, timeout=20).stdout


def wait_for(predicate, description, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception:
            pass
        time.sleep(0.2)
    raise AssertionError(description)


def visible_windows():
    result = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(app.pid), "--name", "Agent RunLab"],
                            env=env, text=True, capture_output=True)
    managed = taskbar_windows()
    return [window for window in result.stdout.splitlines() if int(window) in managed]


def screenshot(name):
    run("import", "-display", env["DISPLAY"], "-window", "root", str(output / name))


def process_cpu_snapshot(root_pid):
    processes = {}
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            text = path.read_text()
            fields = text[text.rfind(")") + 2:].split()
            processes[int(path.parent.name)] = {
                "parent": int(fields[1]), "ticks": int(fields[11]) + int(fields[12]),
                "start": fields[19], "name": text[text.find("(") + 1:text.rfind(")")],
            }
        except (OSError, ValueError):
            continue
    selected = {root_pid}
    while True:
        children = {pid for pid, info in processes.items() if info["parent"] in selected}
        if children.issubset(selected):
            break
        selected.update(children)
    return {f'{pid}:{processes[pid]["start"]}': processes[pid] for pid in selected if pid in processes}


def process_gpu_snapshot(root_pid):
    clients = {}
    for identity, process in process_cpu_snapshot(root_pid).items():
        pid = identity.split(":", 1)[0]
        for path in Path(f"/proc/{pid}/fdinfo").glob("*"):
            try:
                fields = dict(line.split(":", 1) for line in path.read_text().splitlines() if ":" in line)
            except (OSError, ValueError):
                continue
            if "drm-driver" not in fields:
                continue
            device = fields.get("drm-pdev", "").strip()
            client_id = fields.get("drm-client-id", path.name).strip()
            engines = {}
            for name, value in fields.items():
                if name.startswith("drm-engine-") and value.strip().endswith(" ns"):
                    engines[name] = int(value.split()[0])
            clients[f"{pid}:{device}:{client_id}"] = {
                "pid": pid, "process": process["name"], "driver": fields["drm-driver"].strip(),
                "device": device, "enginesNs": engines,
            }
    return clients


def sample_cpu(name, seconds=8):
    roots = (("nativeTree", app.pid), ("gnomeShell", shell.pid))
    before = {key: process_cpu_snapshot(pid) for key, pid in roots}
    gpu_before = process_gpu_snapshot(app.pid)
    started = time.monotonic()
    intervals = []
    deadline = started + seconds
    while time.monotonic() < deadline:
        interval_started = time.monotonic()
        time.sleep(min(10, max(0, deadline - interval_started)))
        elapsed = time.monotonic() - interval_started
        interval = {"offsetSeconds": interval_started - started, "seconds": elapsed}
        for key, pid in roots:
            after = process_cpu_snapshot(pid)
            rows = [{"pidAndStart": process, "name": info["name"],
                     "ticks": info["ticks"] - before[key].get(process, {"ticks": 0})["ticks"]}
                    for process, info in after.items()]
            ticks = sum(row["ticks"] for row in rows)
            interval[key] = {"ticks": ticks, "percentOfOneCpu": ticks / os.sysconf("SC_CLK_TCK") / elapsed * 100,
                             "processes": rows, "exitedProcesses": sorted(set(before[key]) - set(after))}
            before[key] = after
        intervals.append(interval)
    elapsed = time.monotonic() - started
    result = {"state": name, "seconds": elapsed, "clockTicksPerSecond": os.sysconf("SC_CLK_TCK"),
              "intervals": intervals}
    for key, _ in roots:
        ticks = sum(interval[key]["ticks"] for interval in intervals)
        result[key] = {"ticks": ticks, "percentOfOneCpu": ticks / os.sysconf("SC_CLK_TCK") / elapsed * 100,
                       "peakIntervalPercentOfOneCpu": max(interval[key]["percentOfOneCpu"] for interval in intervals)}
    result["gpuClients"] = []
    for client, state in process_gpu_snapshot(app.pid).items():
        previous = gpu_before.get(client, {}).get("enginesNs", {})
        result["gpuClients"].append({**state, "engineDeltaNs": {
            engine: value - previous.get(engine, 0) for engine, value in state["enginesNs"].items()}})
    return result


def taskbar_windows():
    xlib = ctypes.CDLL("libX11.so.6")
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    xlib.XDefaultRootWindow.restype = ctypes.c_ulong
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    xlib.XFree.argtypes = [ctypes.c_void_p]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(env["DISPLAY"].encode())
    assert display
    data = ctypes.POINTER(ctypes.c_ubyte)()
    try:
        prop = xlib.XInternAtom(display, b"_NET_CLIENT_LIST", 0)
        actual = ctypes.c_ulong()
        fmt = ctypes.c_int()
        count, remaining = ctypes.c_ulong(), ctypes.c_ulong()
        assert xlib.XGetWindowProperty(display, xlib.XDefaultRootWindow(display), prop,
            0, 65536, 0, 33, ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(count),
            ctypes.byref(remaining), ctypes.byref(data)) == 0
        return list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:count.value]) if data else []
    finally:
        if data:
            xlib.XFree(data)
        xlib.XCloseDisplay(display)


def window_message(window, message_name, values):
    class Message(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
    class Event(ctypes.Union):
        _fields_ = [("message", Message), ("pad", ctypes.c_long * 24)]
    xlib = ctypes.CDLL("libX11.so.6")
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    xlib.XDefaultRootWindow.restype = ctypes.c_ulong
    xlib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    xlib.XInternAtom.restype = ctypes.c_ulong
    xlib.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    xlib.XFlush.argtypes = [ctypes.c_void_p]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(env["DISPLAY"].encode())
    try:
        event = Event()
        event.message.type = 33
        event.message.display = display
        event.message.window = int(window)
        event.message.message_type = xlib.XInternAtom(display, message_name.encode(), 0)
        event.message.format = 32
        for index, value in enumerate(values):
            event.message.data[index] = xlib.XInternAtom(display, value.encode(), 0) if isinstance(value, str) else value
        assert xlib.XSendEvent(display, xlib.XDefaultRootWindow(display), 0, (1 << 19) | (1 << 20), ctypes.byref(event))
        xlib.XFlush(display)
    finally:
        xlib.XCloseDisplay(display)


def maximize_window(window, enabled):
    run("wmctrl", "-ir", hex(int(window)), "-b",
        ("add" if enabled else "remove") + ",maximized_vert,maximized_horz")

def ui(method, value=None):
    identifier = f"command-{time.monotonic_ns()}"
    feature_commands.append({"id": identifier, "method": method, "value": value})
    return wait_for(lambda: next((v for v in feature_checks if v.get("id") == identifier), None),
                    f"Public bridge {method} timed out")


def change(session, status):
    request = Request(origin + "/__native/change",
                      data=json.dumps({"sessionId": session, "status": status}).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=10) as response:
        assert response.status == 204
    time.sleep(1)


try:
    origin = f"http://127.0.0.1:{server.server_port}"
    if real_dashboard:
        assert features, "Real Dashboard acceptance requires native feature checks"
        assert socket.gethostname() == "runlab-desktop-builder", "Test TLS trust is confined to the disposable builder"
        certificate, key = runtime / "fixture.crt", runtime / "fixture.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=RunLab isolated native acceptance", "-addext", "subjectAltName=IP:127.0.0.1",
                        "-keyout", str(key), "-out", str(certificate)], check=True, capture_output=True)
        key.chmod(0o600)
        fixture_trust = Path(f"/usr/local/share/ca-certificates/runlab-native-acceptance-{os.getpid()}.crt")
        shutil.copyfile(certificate, fixture_trust)
        subprocess.run(["update-ca-certificates"], check=True, capture_output=True)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certificate, key)
        untrusted_server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        untrusted_server.socket = tls.wrap_socket(untrusted_server.socket, server_side=True)
        threading.Thread(target=untrusted_server.serve_forever, daemon=True).start()
        env.update({"RUNLAB_DESKTOP_PROBE_ORIGIN": origin, "RUNLAB_DESKTOP_EVIDENCE": str(output)})
        start("real-host", ["node", "--import", "./packages/host/node_modules/tsx/dist/loader.mjs",
              "packages/desktop/tests/native-dashboard-host.mjs"])
        origin_file = output / "host-origin"
        wait_for(origin_file.exists, "Isolated real Host fixture did not start")
        origin = origin_file.read_text()
    start("xvfb", ["Xvfb", ":96", "-screen", "0", "1440x1000x24", "-nolisten", "unix",
                   "-listen", "tcp", "-nolock", "-ac"])
    bus_process = start("dbus", ["dbus-daemon", "--session", "--nofork",
                                  f"--address={env['DBUS_SESSION_BUS_ADDRESS']}"])
    time.sleep(1)
    assert bus_process.poll() is None
    if smooth_diagnostic:
        gl_probe = subprocess.run(["/usr/bin/python3", "-c", """
import ctypes,json,gi
gi.require_version('Gtk','3.0')
gi.require_version('WebKit2','4.1')
from gi.repository import Gtk,WebKit2
Gtk.init([])
window=Gtk.Window()
window.realize()
context=window.get_window().create_gl_context()
context.realize()
context.make_current()
gl=ctypes.CDLL('libGL.so.1')
gl.glGetString.argtypes=[ctypes.c_uint]
gl.glGetString.restype=ctypes.c_char_p
print(json.dumps({name:(gl.glGetString(value) or b'').decode() for name,value in [('vendor',0x1F00),('renderer',0x1F01),('version',0x1F02)]}|{'webkitDefaultAccelerationPolicy':WebKit2.Settings().get_hardware_acceleration_policy().value_nick}))
window.destroy()
"""], env=env, capture_output=True, text=True, timeout=30)
        renderer_audit = {
            "environment": {key: value for key, value in env.items()
                            if key.startswith(("LIBGL", "GALLIUM", "MESA", "WEBKIT", "GDK", "GSK"))},
            "gpuDevices": sorted(str(path) for path in Path("/dev/dri").glob("*")) if Path("/dev/dri").exists() else [],
            "display": "Xvfb 1440x1000x24 over X11 TCP, GNOME Shell compositor",
            "gdkGlProbe": {"exitCode": gl_probe.returncode, "stdout": gl_probe.stdout, "stderr": gl_probe.stderr},
            "scope": "Test-container rendering evidence, not evidence about user hardware.",
        }
    indicator_extension = "ubuntu-appindicators" + "@" + "ubuntu.com"
    run("gsettings", "set", "org.gnome.shell", "enabled-extensions", f"['{indicator_extension}']")
    run("gsettings", "set", "org.gnome.shell", "disable-user-extensions", "false")
    run("gsettings", "set", "org.gnome.desktop.session", "idle-delay", "0")
    run("gsettings", "set", "org.gnome.desktop.screensaver", "lock-enabled", "false")
    run("gsettings", "set", "org.gnome.desktop.lockdown", "disable-lock-screen", "true")
    shell = start("gnome-shell", ["gnome-shell", "--x11", "--sm-disable", "--unsafe-mode"])

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
                             Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()

    def watcher():
        return call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                    "org.freedesktop.DBus.Properties", "GetAll", "(s)",
                    ("org.kde.StatusNotifierWatcher",))[0]

    def shell_eval(expression):
        success, result = call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell", "Eval", "(s)", (expression,))
        assert success, result
        return json.loads(result) if result else None

    notifications = []
    if features:
        monitor = Gio.DBusConnection.new_for_address_sync(
            env["DBUS_SESSION_BUS_ADDRESS"],
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)

        def notification_filter(connection, message, incoming):
            if incoming and message.get_message_type() in (Gio.DBusMessageType.METHOD_CALL, Gio.DBusMessageType.SIGNAL):
                if message.get_interface() in ("org.gtk.Notifications", "org.freedesktop.Notifications"):
                    notifications.append({"method": message.get_member(), "destination": message.get_destination(),
                                          "sender": message.get_sender(), "body": message.get_body().unpack()})
            return None if incoming else message
        monitor.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.Monitoring",
            "BecomeMonitor", GLib.Variant("(asu)", ([
                "type='method_call',interface='org.gtk.Notifications'",
                "type='method_call',interface='org.freedesktop.Notifications'",
                "type='signal',interface='org.freedesktop.Notifications'"], 0)),
            None, Gio.DBusCallFlags.NONE, 3000, None)
        monitor.add_filter(notification_filter)
    wait_for(watcher, "The genuine GNOME AppIndicator watcher did not start", 60)
    if features:
        start("gnome-notifications", ["gjs", "-m", "/usr/share/gnome-shell/org.gnome.Shell.Notifications"])
        wait_for(lambda: call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                             "NameHasOwner", "(s)", ("org.freedesktop.Notifications",))[0],
                 "The distribution GNOME notification daemon did not start")
    assert shell.poll() is None
    app = start("desktop", [os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop")])
    launcher = wait_for(lambda: visible_windows()[-1] if visible_windows() else None, "Launcher missing")
    registered = wait_for(lambda: watcher()["RegisteredStatusNotifierItems"], "GNOME did not register the tray")
    time.sleep(5)
    run("xdotool", "key", "Escape")
    run("xdotool", "windowactivate", "--sync", launcher)
    time.sleep(1)
    window = launcher
    expect_bug = os.environ.get("RUNLAB_DESKTOP_EXPECT_BUG") == "1"
    if not expect_bug:
        run("xdotool", "key", "ctrl+a")
        run("xdotool", "type", "--clearmodifiers", origin)
        run("xdotool", "key", "Return")
        wait_for(lambda: page_checks and page_checks[-1]["value"] is not None, "Real GNOME Dashboard did not load")
        window = wait_for(lambda: next((x for x in visible_windows() if x != launcher), None), "Dashboard missing")
        run("xdotool", "windowactivate", "--sync", window)
        assert run("xdotool", "getwindowname", window).strip() == "Agent RunLab", "Native Dashboard title exposed remote title or endpoint"
        if real_dashboard:
            settings_path = Path(env["XDG_CONFIG_HOME"]) / "io.github.xingsy97.akernel.desktop/desktop-state.json"
            wait_for(lambda: json.loads(settings_path.read_text()).get("origin") == origin,
                     "Authenticated real Dashboard handshake did not confirm and persist its origin")
            wait_for(lambda: page_checks[-1]["updateAvailable"], "Real Dashboard newer-version entry missing")
            assert ui("click", '[data-testid="desktop-update-available"]')["error"] is None
            wait_for(lambda: page_checks[-1]["updateSecurity"], "Real Dashboard update installation dialog missing")
            assert "unsigned" in page_checks[-1]["updateSecurity"].lower()
            screenshot("gnome-real-dashboard-update-dialog.png")
            run("xdotool", "key", "Escape")
            wait_for(lambda: not page_checks[-1]["updateSecurity"], "Update dialog did not close")
        assert ui("focusComposer")["error"] is None
        run("xdotool", "key", "End")
        run("xdotool", "type", "--clearmodifiers", " preserved")
        run("xdotool", "key", "F8")
        wait_for(lambda: page_checks[-1]["value"].endswith(" preserved"), "Dashboard draft probe missing")
        wait_for(lambda: int(window) in taskbar_windows(),
                 f"Dashboard {window} was not managed in Mutter's taskbar {taskbar_windows()}; visible {visible_windows()}")
    screenshot("gnome-before-close.png")
    run("xdotool", "key", "alt+F4")
    time.sleep(2)
    screenshot("gnome-after-close.png")
    evidence = {"shell": run("gnome-shell", "--version").strip(),
                "binary": os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop"),
                "binarySha256": hashlib.sha256(Path(os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop")).read_bytes()).hexdigest(),
                "extension": run("dpkg-query", "-W", "gnome-shell-extension-appindicator").strip(),
                "watcherBeforeClose": registered, "watcherAfterClose": watcher(),
                "processAliveAfterClose": app.poll() is None, "visibleWindowsAfterClose": visible_windows(),
                "taskbarContainsWindowAfterClose": int(window) in taskbar_windows(),
                "driver": "genuine distribution GNOME Shell + Ubuntu AppIndicator extension, ordinary X11 input"}
    (output / "gnome-result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
    if expect_bug:
        assert app.poll() == 0, "Old GNOME bug was not reproduced"
        assert not watcher()["RegisteredStatusNotifierItems"]
    else:
        assert app.poll() is None, "Close killed the app despite its visible GNOME tray icon"
        assert not visible_windows(), "Window remained on the desktop after close"
        assert watcher()["RegisteredStatusNotifierItems"], "Close removed the tray icon"
        assert int(window) not in taskbar_windows(), "Hidden window remained in Mutter's taskbar list"

        def click_icon():
            x, y = shell_eval("(()=>{const a=Object.entries(Main.panel.statusArea).find(([k,a])=>k.startsWith('appindicator-')&&a)[1];const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();return [Math.round(x+w/2),Math.round(y+h/2)]})()")
            run("xdotool", "mousemove", str(x), str(y))
            time.sleep(0.3)
            run("xdotool", "click", "1")
            time.sleep(0.5)

        def exported_menu():
            item = watcher()["RegisteredStatusNotifierItems"][0]
            destination, path = item.split("@", 1)
            props = call(destination, path, "org.freedesktop.DBus.Properties", "GetAll",
                         "(s)", ("org.kde.StatusNotifierItem",))[0]
            menu = props["Menu"]
            revision, layout = call(destination, menu, "com.canonical.dbusmenu", "GetLayout",
                                    "(iias)", (0, -1, []))
            labels = {}

            def visit(node):
                item_id, properties, children = node
                if "label" in properties:
                    labels[properties["label"]] = item_id
                for child in children:
                    visit(child)
            visit(layout)
            assert list(labels) == ["Open Agent RunLab", "Change server…", "Quit"], layout
            return {"destination": destination, "path": menu, "revision": revision, "layout": layout}

        def menu_action(label):
            exported_menu()
            if not shell_eval("Object.entries(Main.panel.statusArea).find(([k,a])=>k.startsWith('appindicator-')&&a)[1].menu.isOpen"):
                click_icon()
            x, y = shell_eval(f"(()=>{{const a=Object.entries(Main.panel.statusArea).find(([k,a])=>k.startsWith('appindicator-')&&a)[1].menu._getMenuItems().find(i=>i.label?.text==={json.dumps(label)});const [x,y]=a.get_transformed_position();const [w,h]=a.get_transformed_size();return [Math.round(x+w/2),Math.round(y+h/2)]}})()")
            run("xdotool", "mousemove", str(x), str(y))
            time.sleep(0.3)
            run("xdotool", "click", "1")

        def tray_icon_path():
            item = watcher()["RegisteredStatusNotifierItems"][0]
            destination, path = item.split("@", 1)
            props = call(destination, path, "org.freedesktop.DBus.Properties", "GetAll",
                         "(s)", ("org.kde.StatusNotifierItem",))[0]
            icon = Path(props["IconName"])
            if not icon.is_absolute():
                icon = Path(props["IconThemePath"]) / icon
            if not icon.suffix:
                icon = icon.with_suffix(".png")
            return icon

        def badge_pixels():
            return hashlib.sha256(tray_icon_path().read_bytes()).hexdigest()

        native_icon = tray_icon_path()
        source_icon = Path("packages/desktop/src-tauri/icons/icon.png")
        rgba = lambda path: subprocess.check_output(["convert", str(path), "-depth", "8", "rgba:-"], env=env)
        assert rgba(native_icon) == rgba(source_icon), "The registered idle tray did not export the current native branding"
        shutil.copyfile(native_icon, output / "native-tray-idle-icon.png")
        evidence["nativeTrayIconMatchesSourcePixels"] = True
        evidence["nativeIconSourceSha256"] = hashlib.sha256(source_icon.read_bytes()).hexdigest()

        if measure_cpu:
            assert real_dashboard, "CPU acceptance requires the real production Dashboard"
            binary = os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop")
            samples = []

            def profile_state(name, hide=False, seconds=None):
                run("xdotool", "windowactivate", "--sync", window)
                page_state = ui("inspectCpu")["result"]
                run("xdotool", "key", "F9")
                if hide:
                    run("xdotool", "key", "alt+F4")
                    wait_for(lambda: not visible_windows(), "CPU hidden state did not hide to tray")
                time.sleep(3)
                screenshot(f"gnome-cpu-{name}.png")
                sample = sample_cpu(name, seconds=seconds if seconds is not None else
                                    90 if long_cpu and name in ("connected-idle", "hidden-connected-idle") else 8)
                sample["pageState"] = page_state
                samples.append(sample)
                if hide:
                    subprocess.run([binary], env=env, check=True, capture_output=True, timeout=10)
                    wait_for(lambda: window in visible_windows(), "CPU sample could not restore the same Dashboard")
                run("xdotool", "windowactivate", "--sync", window)
                run("xdotool", "key", "F10")
                after_state = ui("inspectCpu")["result"]
                sample["pageStateAfter"] = after_state
                sample["faviconChangesIncludingSetupAndRestore"] = after_state["faviconChanges"] - page_state["faviconChanges"]
                assert run("xdotool", "getwindowname", window).strip() == "Agent RunLab"
                return sample

            def baseline(hold):
                with urlopen(Request(origin + "/__native/baseline", method="POST",
                                     data=json.dumps({"sessionId": "session-cpu", "hold": hold}).encode(),
                                     headers={"Content-Type": "application/json"}), timeout=10) as response:
                    assert response.status == 204

            menu_action("Open Agent RunLab")
            wait_for(lambda: window in visible_windows() and page_checks[-1]["connectionStatus"] == "ready",
                     "Connected-idle CPU baseline not ready")
            if smooth_diagnostic:
                assert ui("blurFocus")["error"] is None
                change("session-viewed", "thinking")
                assert ui("prepareSmoothDom")["result"] == 1, "Original breathing-dot target missing"
                renderer_audit["webKitWebGL"] = ui("inspectRendering")["result"]
                (output / "native-renderer-audit.json").write_text(json.dumps(renderer_audit, indent=2) + "\n")
                original_smooth = """
.ak-session-status-spinner {animation:ak-session-status-spin 900ms linear infinite!important}
.ak-thinking-dot {animation:ak-thinking-dot 1.4s ease-in-out infinite!important}
.ak-thinking-row::after {content:'';position:absolute;inset:0;transform:translateX(-120%);background:linear-gradient(90deg,transparent,hsl(var(--foreground)/0.04),transparent);animation:ak-thinking-sheen 2.2s ease-in-out infinite}
.native-sheen-clip {display:none}
@keyframes ak-session-status-spin {from {transform:rotate(0deg)}to {transform:rotate(360deg)}}
@keyframes ak-thinking-dot {0%,100% {opacity:.18;transform:scale(.82)}50% {opacity:.36;transform:scale(1.25)}}
@keyframes ak-thinking-sheen {0% {transform:translateX(-120%)}55%,100% {transform:translateX(120%)}}
"""
                promoted = """
.ak-session-status-spinner,.ak-thinking-dot,.ak-thinking-row::after {will-change:transform,opacity;backface-visibility:hidden}
@keyframes ak-session-status-spin {from {transform:translate3d(0,0,0) rotate(0deg)}to {transform:translate3d(0,0,0) rotate(360deg)}}
@keyframes ak-thinking-dot {0%,100% {opacity:.18;transform:translate3d(0,0,0) scale(.82)}50% {opacity:.36;transform:translate3d(0,0,0) scale(1.25)}}
@keyframes ak-thinking-sheen {0% {transform:translate3d(-120%,0,0)}55%,100% {transform:translate3d(120%,0,0)}}
"""
                variants = [
                    ("original-smooth", ""),
                    ("css-border-spinner", ".ak-session-status-spinner{position:relative}.ak-session-status-spinner>svg{visibility:hidden}.ak-session-status-spinner::after{content:'';position:absolute;inset:0;box-sizing:border-box;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%}"),
                    ("explicit-3d-keyframes", promoted),
                    ("isolated-glass-background", promoted + ".ak-thinking-row{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:transparent!important;isolation:isolate}.ak-thinking-row::before{content:'';position:absolute;inset:0;border-radius:inherit;background:var(--native-panel-background);backdrop-filter:var(--native-panel-blur);z-index:0;pointer-events:none}"),
                    ("bounded-sheen-layer", promoted + ".ak-thinking-row::after{content:none}.native-sheen-clip{display:block;position:absolute;inset:0;overflow:hidden;contain:paint;isolation:isolate;border-radius:inherit;pointer-events:none}.native-sheen-light{position:absolute;inset:0;background:linear-gradient(90deg,transparent,hsl(var(--foreground)/0.04),transparent);animation:ak-thinking-sheen 2.2s ease-in-out infinite;will-change:transform}"),
                ]
                if smooth_batch == "layers":
                    titlebar_glass = ".ak-titlebar-surface{position:relative;isolation:isolate;background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.ak-titlebar-surface::before{content:'';position:absolute;inset:0;border-radius:inherit;background:var(--native-panel-background);backdrop-filter:var(--native-panel-blur);z-index:-1;pointer-events:none}"
                    row_glass = ".ak-thinking-row{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;isolation:isolate}.ak-thinking-row::before{content:'';position:absolute;inset:0;border-radius:inherit;background:var(--native-panel-background);backdrop-filter:var(--native-panel-blur);z-index:0;pointer-events:none}"
                    variants = [
                        ("original-visible-effects", ""),
                        ("isolated-titlebar-glass", titlebar_glass),
                        ("isolated-both-glass-panels", titlebar_glass + row_glass),
                        ("no-panel-backdrop-causal-control", ".ak-titlebar-surface,.ak-thinking-row{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}"),
                        ("release-finished-chat-transform", ".ak-motion-session-swap{animation-fill-mode:backwards!important}"),
                    ]
                elif smooth_batch in ("baseline", "lifecycle"):
                    variants = [("gpu-check-original-smooth", "")]
                    if smooth_batch == "lifecycle":
                        variants.append(("gpu-check-original-smooth-hidden", ""))
                elif smooth_batch == "geometry":
                    variants = [("viewport-1100x760-before", ""), ("viewport-800x600", ""), ("viewport-1100x760-after", "")]
                for name, css in variants:
                    if smooth_batch == "geometry":
                        width, height = (800, 600) if name == "viewport-800x600" else (1100, 760)
                        run("wmctrl", "-ir", hex(int(window)), "-e", f"0,-1,-1,{width},{height}")
                        wait_for(lambda: f"WIDTH={width}\nHEIGHT={height}\n" in run("xdotool", "getwindowgeometry", "--shell", window),
                                 "Native viewport resize did not settle")
                        assert ui("showSmoothEffects")["error"] is None
                    assert ui("diagnosticCss", original_smooth + css)["error"] is None
                    sample = profile_state("smooth-" + name, hide=name.endswith("-hidden"), seconds=smooth_case_seconds)
                    sample["layers"] = ui("inspectLayers")["result"]
                    names = {animation["name"] for animation in sample["pageState"]["animations"]}
                    assert {"ak-session-status-spin", "ak-thinking-dot", "ak-thinking-sheen"}.issubset(names), names
                    for animation in sample["pageState"]["animations"]:
                        expected = {"ak-session-status-spin": 900, "ak-thinking-dot": 1400, "ak-thinking-sheen": 2200}
                        if animation["name"] in expected:
                            assert animation["effectDurationMs"] == expected[animation["name"]], animation
                            assert not any("steps" in easing for easing in animation["keyframeEasing"]), animation
                renderer_audit["nativeRenderingLibraries"] = []
                for identity, process in process_cpu_snapshot(app.pid).items():
                    pid = identity.split(":", 1)[0]
                    try:
                        lines = Path(f"/proc/{pid}/maps").read_text().splitlines()
                    except OSError:
                        continue
                    libraries = sorted({line.split()[-1] for line in lines if any(
                        marker in line.lower() for marker in ("swrast", "libllvm", "libegl", "libglx", "libgbm", "libwebkit"))})
                    renderer_audit["nativeRenderingLibraries"].append({"process": process["name"], "pid": pid, "libraries": libraries})
                (output / "native-renderer-audit.json").write_text(json.dumps(renderer_audit, indent=2) + "\n")
                assert ui("diagnosticCss", "")["error"] is None
                assert ui("restoreSmoothDom")["error"] is None
                change("session-viewed", "idle")
                evidence["smoothRendering"] = "Original 900ms linear spinner, 1.4s breathing dot and 2.2s sheen restored in fixture only. All variants retain smooth timing; no production pause, steps, throttling or timer changes."
                evidence["rendererAudit"] = renderer_audit
            elif composer_diagnostic:
                assert ui("focusComposer")["error"] is None
                run("xdotool", "key", "ctrl+a", "BackSpace")
                wait_for(lambda: ui("inspectCpu")["result"]["typewriterDone"] != "false", "Finite welcome transition did not settle")
                profile_state("settled-focused-composer-baseline", seconds=15)
                assert ui("diagnosticCss", '[data-testid="composer-full-shell"] > div {backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')["error"] is None
                profile_state("settled-focused-composer-without-backdrop-blur", seconds=15)
                assert ui("diagnosticCss", "")["error"] is None
                assert ui("blurFocus")["error"] is None
                profile_state("settled-unfocused-composer-control", seconds=15)
                evidence["composerIsolation"] = "Finite welcome transition settled first; native caret retained; only composer backdrop filter removed for one test sample and restored."
            elif targeted_cpu:
                assert ui("blurFocus")["error"] is None
                change("session-viewed", "thinking")
                assert ui("showSmoothEffects")["error"] is None
                assert ui("inspectSheenPointerEvents")["result"] == "none"
                visible = profile_state("fixed-thinking-visible", seconds=targeted_cpu_seconds)
                assert visible["pageState"]["elapsed"] != visible["pageStateAfter"]["elapsed"], "Live elapsed feedback stopped"
                animations = {a["name"]: a for a in visible["pageState"]["animations"]}
                for name, duration in {"ak-session-status-spin": 900, "ak-thinking-dot": 1400, "ak-thinking-sheen": 2200}.items():
                    animation = animations[name]
                    assert animation["effectDurationMs"] == duration and animation["playState"] == "running", animation
                    assert not any("steps" in easing for easing in animation["keyframeEasing"]), animation
                spinner = animations["ak-session-status-spin"]
                assert spinner["effectDurationMs"] == 900 and spinner["cssTiming"] == "linear", spinner
                profile_state("fixed-thinking-hidden", hide=True, seconds=targeted_cpu_seconds)
                change("session-viewed", "idle")
                baseline(True)
                subprocess.run([binary, "agent-runlab://session/session-cpu"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "connecting", "Fixed Connecting CPU scenario not ready")
                assert ui("focusComposer")["error"] is None
                run("xdotool", "key", "ctrl+a", "BackSpace")
                connecting = profile_state("fixed-connecting-focused-composer", seconds=targeted_cpu_seconds)
                pulse = next(a for a in connecting["pageState"]["animations"] if a["name"] == "ak-status-pulse")
                assert pulse["effectDurationMs"] == 2000 and pulse["playState"] == "running", pulse
                assert not any("steps" in easing for easing in pulse["keyframeEasing"]), pulse
                baseline(False)
                subprocess.run([binary, "agent-runlab://session/session-viewed"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "ready", "Fixed CPU scenarios did not recover selected session")
                assert ui("focusComposer")["error"] is None
                run("xdotool", "key", "ctrl+a", "BackSpace")
                wait_for(lambda: ui("inspectCpu")["result"]["typewriterDone"] != "false", "Finite welcome transition did not settle")
                profile_state("fixed-ready-focused-composer", seconds=targeted_cpu_seconds)
                evidence["targetedCpuFix"] = "Actual rebuilt Dashboard; no diagnostic CSS or paused production animations/timers; original smooth spinner, breathing dot, sheen and Connecting pulse, live elapsed labels, intact focused composer caret, and non-intercepting decorative sheen."
            elif render_diagnostic:
                assert ui("blurFocus")["error"] is None
                change("session-viewed", "thinking")
                profile_state("thinking-render-baseline", seconds=8)
                for label, names in [
                    ("dot-paused", ["ak-thinking-dot"]),
                    ("spinner-paused", ["ak-session-status-spin"]),
                    ("dot-spinner-paused", ["ak-thinking-dot", "ak-session-status-spin"]),
                ]:
                    assert ui("pauseNamedThinkingIndicators", names)["result"] >= len(names)
                    profile_state("thinking-" + label, seconds=8)
                    assert ui("resumeThinkingIndicators")["error"] is None
                stepped = ".ak-thinking-dot {animation:ak-thinking-dot 4s steps(2,end) infinite!important}.ak-session-status-spinner {animation:ak-session-status-spin 4s steps(4,end) infinite!important}.ak-thinking-row::after {animation:none!important}"
                assert ui("diagnosticCss", stepped)["error"] is None
                profile_state("thinking-stepped-indicators", seconds=8)
                assert ui("diagnosticCss", stepped + ".ak-thinking-dot {animation:none!important}")["error"] is None
                profile_state("thinking-stepped-spinner-static-dot", seconds=8)
                assert ui("diagnosticCss", "")["error"] is None
                change("session-viewed", "idle")
                baseline(True)
                subprocess.run([binary, "agent-runlab://session/session-cpu"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "connecting", "Connecting composer diagnostic not ready")
                assert ui("focusComposer")["error"] is None
                run("xdotool", "key", "ctrl+a", "BackSpace")
                profile_state("focused-empty-composer-baseline", seconds=8)
                loading_static = '[data-testid="transcript-history-loading-indicator"] .animate-spin {animation:none!important}'
                assert ui("diagnosticCss", loading_static)["error"] is None
                profile_state("focused-empty-composer-loading-spinner-static", seconds=8)
                assert ui("diagnosticCss", loading_static + '[data-testid="composer-full-shell"] > div {backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')["error"] is None
                profile_state("focused-empty-composer-without-backdrop-blur", seconds=8)
                assert ui("diagnosticCss", "")["error"] is None
                baseline(False)
                subprocess.run([binary, "agent-runlab://session/session-viewed"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "ready", "Render diagnostic did not restore session")
                evidence["renderIsolation"] = "Test-only named dot/spinner pauses, stepped indicator CSS, then composer-only backdrop removal. All controls restored; no timer/cursor shutdown."
            elif favicon_diagnostic:
                assert ui("blurFocus")["error"] is None
                change("session-viewed", "thinking")
                profile_state("selected-thinking-favicon-live-control", seconds=15)
                assert ui("holdFavicon")["error"] is None
                held = profile_state("selected-thinking-favicon-assignments-held", seconds=15)
                assert held["faviconChangesIncludingSetupAndRestore"] == 0
                assert held["pageStateAfter"]["heldFaviconWrites"] > held["pageState"]["heldFaviconWrites"], "Ticker timer did not remain active during favicon isolation"
                assert ui("restoreFavicon")["error"] is None
                assert ui("pauseThinkingSheen")["result"] > 0, "Thinking sheen diagnostic target missing"
                profile_state("selected-thinking-only-sheen-paused", seconds=15)
                assert ui("resumeThinkingSheen")["error"] is None
                assert ui("pauseThinkingIndicators")["result"] >= 3, "Thinking indicator diagnostic targets missing"
                indicators = profile_state("selected-thinking-indicator-animations-paused", seconds=15)
                assert indicators["faviconChangesIncludingSetupAndRestore"] > 0, "Favicon ticker must remain active while isolating thinking indicators"
                assert ui("resumeThinkingIndicators")["error"] is None
                change("session-viewed", "idle")
                evidence["faviconIsolation"] = "Test-only holds favicon href assignments while its timer runs; separately pauses only ak-thinking-sheen, then only the three named thinking-indicator CSS animations; restores all. Favicon timer, notifications and streaming are not disabled. No frontend source changes."
            elif background_cpu:
                assert ui("blurFocus")["error"] is None
                change("session-viewed", "done")
                change("session-other", "thinking")
                profile_state("selected-done-other-thinking-visible", seconds=background_cpu_seconds)
                profile_state("selected-done-other-thinking-hidden", hide=True, seconds=background_cpu_seconds)
                change("session-other", "done")
                change("session-viewed", "thinking")
                active_visible = profile_state("selected-thinking-static-visible", seconds=background_cpu_seconds)
                active_hidden = profile_state("selected-thinking-static-hidden", hide=True, seconds=background_cpu_seconds)
                assert active_visible["faviconChangesIncludingSetupAndRestore"] > 0, "Selected thinking session did not activate the actual favicon ticker"
                assert active_hidden["faviconChangesIncludingSetupAndRestore"] > 0, "Hidden selected thinking session did not retain the actual favicon ticker"
                change("session-viewed", "idle")
                change("session-other", "idle")
                evidence["backgroundRunningCpuScenario"] = "Selected session done, other thinking; then selected thinking/static control. Fixture state changes only; no LLM/streaming calls."
            else:
                if long_cpu:
                    assert ui("focusComposer")["error"] is None
                    run("xdotool", "key", "ctrl+a", "BackSpace")
                    wait_for(lambda: page_checks[-1]["value"] == "", "Long CPU baseline needs an empty, focused composer")
                profile_state("connected-idle")
                baseline(True)
                subprocess.run([binary, "agent-runlab://session/session-cpu"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "connecting", "Withheld real session baseline did not show Connecting")
                profile_state("connecting")
                assert page_checks[-1]["connectionStatus"] == "connecting", "Connecting state did not persist throughout CPU sample"
                assert ui("blurFocus")["error"] is None
                profile_state("connecting-unfocused-composer")
                baseline(False)
                subprocess.run([binary, "agent-runlab://session/session-viewed"], env=env, check=True, capture_output=True, timeout=10)
                wait_for(lambda: page_checks[-1]["connectionStatus"] == "ready" and page_checks[-1]["label"] == "Private session-viewed",
                         "Real session baseline did not recover after Connecting sample")
                profile_state("hidden-connected-idle", hide=True)
            evidence["nativeCpuSamples"] = samples
            (output / "native-cpu.json").write_text(json.dumps({
                "samples": samples, "driver": "installed WebKit + genuine GNOME + real isolated Host",
                "probe": "Acceptance polling suspended via F9/F10; production timers and streaming untouched; any test-only animation/asset isolation is explicitly identified per scenario",
                "connecting": "Fixture withholds only session-cpu session:ready; real control connection remains online",
                "backgroundRunning": evidence.get("backgroundRunningCpuScenario"),
                "faviconIsolation": evidence.get("faviconIsolation"),
                "renderIsolation": evidence.get("renderIsolation"),
                "targetedFix": evidence.get("targetedCpuFix"),
                "composerIsolation": evidence.get("composerIsolation"),
                "smoothRendering": evidence.get("smoothRendering"),
                "limits": "Software-rendered Xvfb samples; exited processes are listed, not attributed; no claim of zero periodic CPU",
            }, indent=2) + "\n")
            run("xdotool", "key", "alt+F4")
            wait_for(lambda: not visible_windows(), "CPU acceptance did not restore initial hidden state")
            if cpu_only:
                menu_action("Quit")
                assert app.wait(timeout=10) == 0
                wait_for(lambda: not watcher()["RegisteredStatusNotifierItems"], "CPU acceptance left the tray registered")
                evidence.update({"cpuOnly": True, "nativeDashboardTitle": "Agent RunLab", "realQuitExitsAndRemovesTray": True})
                (output / "gnome-result.json").write_text(json.dumps(evidence, indent=2) + "\n")
                raise SystemExit(0)

        count = len(page_loads)
        original = page_checks[-1]
        before_menu = exported_menu()
        click_icon()
        after_menu = exported_menu()
        (output / "native-menu-dbus-layout.json").write_text(json.dumps(
            {"beforeOpening": before_menu, "afterOpening": after_menu}, indent=2) + "\n")
        menu_labels = shell_eval("(()=>{const a=Object.entries(Main.panel.statusArea).find(([k,a])=>k.startsWith('appindicator-')&&a)[1];return a.menu._getMenuItems().map(i=>({text:i.label?.text,visible:i.visible,mapped:i.mapped,opacity:i.label?.get_paint_opacity(),width:i.label?.width,height:i.label?.height,color:i.label?.get_theme_node().get_foreground_color().to_string(),position:i.label?.get_transformed_position()}))})()")
        (output / "native-menu-labels.json").write_text(json.dumps(menu_labels, indent=2) + "\n")
        assert [item["text"] for item in menu_labels] == ["Open Agent RunLab", "Change server…", "Quit"], menu_labels
        assert all(item["visible"] and item["mapped"] and item["opacity"] > 0 and item["width"] > 0 and item["height"] > 0 for item in menu_labels), menu_labels
        def painted_menu_labels():
            # Actor text/opacity can be correct before GNOME actually paints its glyphs.
            screenshot("gnome-visible-menu-text.png")
            counts = []
            for item in menu_labels:
                x, y = (round(value) for value in item["position"])
                crop = f'{round(item["width"])}x{round(item["height"])}+{x}+{y}'
                pixels = subprocess.run(["convert", str(output / "gnome-visible-menu-text.png"),
                    "-crop", crop, "-depth", "8", "rgb:-"], env=env, capture_output=True,
                    check=True, timeout=20).stdout
                color = item["color"].lstrip("#")
                foreground = tuple(int(color[index:index + 2], 16) for index in (0, 2, 4))
                counts.append(sum(all(abs(pixels[index + channel] - foreground[channel]) < 40
                                      for channel in range(3))
                                  for index in range(0, len(pixels), 3)))
            evidence["nativeMenuPaintedForegroundPixels"] = counts
            return all(count >= 10 for count in counts)

        wait_for(painted_menu_labels, "GNOME exported menu labels but did not paint visible text", timeout=10)
        assert not visible_windows(), "Opening the native tray menu stole focus and restored the hidden window"
        menu_action("Open Agent RunLab")
        wait_for(lambda: window in visible_windows(), "Physically selecting native Open did not restore")
        run("xdotool", "windowactivate", "--sync", window)
        run("xdotool", "key", "F8")
        wait_for(lambda: len(page_checks) >= 3, "Restored Dashboard state missing")
        assert all(page_checks[-1][key] == original[key] for key in ("instance", "value", "label")), "Tray restore lost the same document/draft state"
        assert len(page_loads) == count
        wait_for(lambda: int(window) in taskbar_windows(), "Restored Dashboard missing from taskbar")

        run("xdotool", "windowminimize", window)
        wait_for(lambda: not visible_windows(), "GNOME minimize did not hide to tray")
        wait_for(lambda: int(window) not in taskbar_windows(), "Minimized window remained in taskbar")
        screenshot("gnome-minimized-to-tray.png")
        menu_action("Open Agent RunLab")
        wait_for(lambda: window in visible_windows(), "Native tray Open did not restore")
        assert len(page_loads) == count
        run("xdotool", "windowactivate", "--sync", window)
        run("xdotool", "key", "alt+F4")
        wait_for(lambda: not visible_windows(), "Second close did not hide")
        run("gnome-extensions", "disable", indicator_extension)
        wait_for(lambda: window in visible_windows(), "Disabling genuine GNOME extension stranded the app")
        screenshot("gnome-extension-loss-restored.png")
        run("gnome-extensions", "enable", indicator_extension)
        wait_for(lambda: watcher()["RegisteredStatusNotifierItems"], "Reenabled GNOME tray did not recover")
        time.sleep(2)
        if features:
            binary = os.environ.get("RUNLAB_DESKTOP_BINARY", "/usr/bin/agent-runlab-desktop")
            run("xdotool", "windowactivate", "--sync", window)
            run("xdotool", "key", "alt+F4")
            wait_for(lambda: not visible_windows(), "Close before repeat launch failed")
            second = subprocess.run([binary], env=env, capture_output=True, timeout=10)
            assert second.returncode == 0
            wait_for(lambda: window in visible_windows(), "Repeat native launch failed to restore existing window")
            assert app.poll() is None and len(page_loads) == count
            link = subprocess.run([binary, "agent-runlab://session/session-link"], env=env, capture_output=True, timeout=10)
            assert link.returncode == 0
            wait_for(lambda: any(v.get("navigate") == "session-link" for v in feature_checks), "Native session link was not routed")
            bad = subprocess.run([binary, "agent-runlab://session/id?token=secret"], env=env, capture_output=True, timeout=10)
            assert bad.returncode == 2
            assert len(page_loads) == count

            info = ui("getInfo")
            assert info["error"] is None and info["result"]["version"] == json.loads(Path("packages/desktop/package.json").read_text())["version"], info
            assert info["result"]["notificationsAvailable"] and info["result"]["trayAvailable"], info
            base = {"status": "running", "running": 1, "attention": 0, "completed": 0}
            assert ui("setActivity", {**base, "status": "idle", "running": 0})["error"] is None
            idle_badge = wait_for(lambda: badge_pixels() if rgba(tray_icon_path()) == rgba(source_icon) else None,
                                 "Explicit idle activity did not restore the unbadged native icon")
            assert ui("setActivity", base)["error"] is None
            running_badge = wait_for(lambda: badge_pixels() if badge_pixels() != idle_badge else None,
                                     "Running badge did not reach native tray")
            screenshot("gnome-working-badge.png")
            sent = lambda: [n for n in notifications if n["method"] == "Notify"
                            and n["destination"] == "org.freedesktop.Notifications"]
            notice = {"id": "approval", "sessionId": "session-approval", "title": "Agent RunLab",
                      "body": "A session needs your attention.", "silent": True}
            for invalid in [
                {**notice, "body": "x" * 513}, {**notice, "title": "Private transcript"},
                {**notice, "sessionId": "invalid/session"}, {**notice, "id": "x" * 257},
                {**notice, "id": "-invalid"}, {**notice, "body": "control\u0001"},
                {**notice, "unexpected": True},
            ]:
                assert ui("notify", invalid)["error"], invalid
            assert ui("setActivity", {**base, "running": -1})["error"]
            assert ui("setActivity", {**base, "status": "working"})["error"]
            assert ui("setActivity", {**base, "unknown": True})["error"]
            baseline = len(sent())
            run("xdotool", "mousemove", "946", "58", "click", "1")
            run("xdotool", "mousemove", "500", "500")
            if real_dashboard:
                subprocess.run([binary, "agent-runlab://session/session-viewed"], env=env, check=True, timeout=10)
                wait_for(lambda: page_checks[-1]["label"] == "Private session-viewed", "Real Dashboard session route missing")
                run("xdotool", "windowactivate", "--sync", window)
                time.sleep(2)
                change("session-viewed", "thinking")
                wait_for(lambda: badge_pixels() == running_badge, "Real Dashboard did not publish running activity")
                change("session-viewed", "done")
                assert len(sent()) == baseline, "Focused selected Dashboard session was not suppressed"
                change("session-approval", "thinking")
                change("session-approval", "awaiting_approval")
            else:
                assert ui("notify", notice)["error"] is None
            wait_for(lambda: len(sent()) == baseline + 1, "Real native approval notification missing")
            if not real_dashboard:
                assert ui("setActivity", {**base, "status": "attention"})["error"] is None
            attention_badge = wait_for(lambda: badge_pixels() if badge_pixels() != running_badge else None,
                                       "Attention badge did not reach native tray")
            time.sleep(0.5)
            if features:
                def active_banner():
                    return shell_eval("Main.messageTray._notification ? {title: Main.messageTray._notification.title, body: Main.messageTray._notification.body} : null")
                expected_banner = {"title": "Agent RunLab", "body": sent()[-1]["body"][4]}
                for _ in range(12):
                    banner = active_banner()
                    if banner == expected_banner:
                        break
                    if banner is not None and banner["title"] == "Agent RunLab":
                        # CPU scenarios may have queued an earlier completion banner.
                        shell_eval("Main.messageTray._notification.destroy()")
                    elif banner is not None:
                        run("xdotool", "mousemove", "946", "58")
                        time.sleep(0.3)
                        run("xdotool", "click", "1")
                        run("xdotool", "mousemove", "500", "500")
                    time.sleep(0.5)
                assert active_banner() == expected_banner, f"Actual GNOME banner is {active_banner()!r}"
            screenshot("gnome-private-approval-notification.png")
            assert sent()[-1]["body"][3] == "Agent RunLab"
            assert sent()[-1]["body"][6]["suppress-sound"] is True
            assert all("Private session" not in json.dumps(n) and "native-draft" not in json.dumps(n) for n in sent())
            run("xdotool", "mousemove", "720", "78", "click", "1")
            wait_for(lambda: any(v.get("navigate") == "session-approval" for v in feature_checks), "Native notification click did not route its session")
            if real_dashboard:
                wait_for(lambda: page_checks[-1]["label"] == "Private session-approval", "Physical OS click failed to select real Dashboard session")
                assert page_checks[-1]["instance"] == original["instance"], "Native click reloaded Dashboard"
                time.sleep(2)
                change("session-approval", "done")
                change("session-complete", "thinking")
                change("session-complete", "done")
            else:
                assert ui("notify", {**notice, "id": "completion", "sessionId": "session-complete"})["error"] is None
            wait_for(lambda: len(sent()) == baseline + 2, "Native completion notification missing")
            if not real_dashboard:
                assert ui("setActivity", {**base, "status": "completed"})["error"] is None
            completed_badge = wait_for(lambda: badge_pixels() if badge_pixels() not in (running_badge, attention_badge, idle_badge) else None,
                                       "Completed badge did not reach native tray")
            screenshot("gnome-completed-badge.png")
            assert not any("desktop-update" in json.dumps(n) for n in notifications), "Duplicate native update notification must not exist"
            if real_dashboard:
                change("session-approval", "thinking")
                run("xdotool", "windowactivate", "--sync", window)
                run("xdotool", "key", "alt+F4")
                wait_for(lambda: not visible_windows(), "Selected Dashboard session did not hide")
                wait_for(lambda: any(v.get("type") == "window-state" and v.get("visible") is False for v in feature_checks),
                         "Public native hidden-window event missing")
                time.sleep(2)
                change("session-approval", "done")
                try:
                    wait_for(lambda: len(sent()) == baseline + 3, "Hidden selected real Dashboard session did not notify", 8)
                except AssertionError as error:
                    feature_failures.append(str(error))
                    print(f"FAIL: {error}", flush=True)
                menu_action("Open Agent RunLab")
                wait_for(lambda: window in visible_windows(), "Hidden completion did not preserve existing window")
                subprocess.run([binary, "agent-runlab://session/session-viewed"], env=env, check=True, timeout=10)
                wait_for(lambda: page_checks[-1]["label"] == "Private session-viewed" and page_checks[-1]["value"] == original["value"],
                         "Real Dashboard per-session draft was lost across notification navigation")
                assert page_checks[-1]["instance"] == original["instance"]
            duplicate = {**notice, "id": "duplicate:boundary._-"}
            assert ui("notify", duplicate)["error"] is None
            delivered_count = len(sent())
            assert ui("notify", duplicate)["error"] is None
            time.sleep(0.5)
            assert len(sent()) == delivered_count, "Duplicate notification reached OS twice"
            assert ui("notify", {**notice, "id": "sound-on", "silent": False})["error"] is None
            assert sent()[-1]["body"][6]["suppress-sound"] is False
            rate_error = None
            for index in range(31):
                result = ui("notify", {**notice, "id": f"rate-{index}"})
                if result["error"]:
                    rate_error = result["error"]
                    break
            assert rate_error and "rate limit" in rate_error.lower(), rate_error
            time.sleep(2)
            run("xdotool", "key", "Escape")
            run("xdotool", "mousemove", "500", "500")
            run("xdotool", "windowactivate", "--sync", window)
            settings_path = Path(env["XDG_CONFIG_HOME"]) / "io.github.xingsy97.akernel.desktop/desktop-state.json"
            maximize_window(window, False)
            wait_for(lambda: not json.loads(settings_path.read_text())["windows"]["dashboard"]["maximized"], "Window manager did not unmaximize")
            time.sleep(1)
            run("wmctrl", "-ir", hex(int(window)), "-e", "0,120,160,1000,700")
            wait_for(lambda: json.loads(settings_path.read_text())["windows"]["dashboard"]["width"] == 1000, "Window dimensions were not persisted", 10)
            normal_geometry = json.loads(settings_path.read_text())["windows"]["dashboard"]
            maximize_window(window, True)
            wait_for(lambda: json.loads(settings_path.read_text())["windows"]["dashboard"]["maximized"], "Maximized state was not saved")
            evidence.update({"singleInstanceRestores": True, "canonicalSessionLinkRoutes": True,
                "invalidDeepLinkDenied": True, "boundedUiBridge": True, "focusedSessionNotificationSuppressed": real_dashboard,
                "privacySafeApprovalAndCompletionNotifications": True, "realNotificationClickRoutesSession": True,
                "staticActivityBadges": True, "dashboardOwnsUpdatePrompt": True, "savedNormalAndMaximizedGeometry": True,
                "realHostProductionDashboard": real_dashboard, "duplicateAndRateLimited": True, "nativeSoundControls": True,
                "hiddenSelectedDashboardCompletionNotifies": real_dashboard and not feature_failures,
                "nativeBadgeDigests": {"running": running_badge, "attention": attention_badge, "completed": completed_badge},
                "nativeNotifications": notifications, "featureChecks": feature_checks})
        menu_action("Change server…")
        wait_for(lambda: launcher in visible_windows(), "Native Change server did not restore local launcher")
        if real_dashboard:
            before_reconnect = page_checks[-1]["instance"]
            time.sleep(2)
            assert launcher in visible_windows(), "Change server automatically reconnected instead of staying editable"
            assert page_checks[-1]["instance"] == before_reconnect
            run("xdotool", "windowactivate", "--sync", launcher)
            run("xdotool", "key", "ctrl+a")
            run("xdotool", "type", "--clearmodifiers", origin)
            run("xdotool", "key", "Return")
            wait_for(lambda: launcher not in visible_windows() and window in visible_windows(),
                     "Reselecting the confirmed server did not restore the Dashboard")
            assert page_checks[-1]["instance"] == before_reconnect, "Same-origin reconnect reloaded the live Dashboard"
            menu_action("Change server…")
            wait_for(lambda: launcher in visible_windows(), "Cannot edit the server again")
            with socket.socket() as refused:
                refused.bind(("127.0.0.1", 0))
                bad_origin = f"http://127.0.0.1:{refused.getsockname()[1]}"
                run("xdotool", "windowactivate", "--sync", launcher)
                run("xdotool", "key", "ctrl+a")
                run("xdotool", "type", "--clearmodifiers", bad_origin)
                run("xdotool", "key", "Return")
                wait_for(lambda: f"Unable to load {bad_origin}" in (output / "desktop.log").read_text(),
                         "An unreachable endpoint did not report its native load error")
                wait_for(lambda: launcher in visible_windows(), "Load failure did not restore the editable connection form")
                assert json.loads(settings_path.read_text())["origin"] == origin, "Failed endpoint replaced the confirmed server"
                screenshot("gnome-failed-endpoint-editable.png")
            evidence.update({"authenticatedHandshakePersistsOrigin": True, "changeServerStaysEditable": True,
                             "sameOriginReconnectPreservesDocument": True, "failedEndpointDoesNotReplaceGoodOrigin": True,
                             "loadFailureReturnsEditableLauncher": True})
        menu_action("Quit")
        assert app.wait(timeout=10) == 0
        wait_for(lambda: not watcher()["RegisteredStatusNotifierItems"], "Quit left the tray registered")
        if features:
            assert json.loads(settings_path.read_text())["windows"]["dashboard"]["maximized"], "Quit lost the maximized preference"
            (output / "native-settings-before-restart.json").write_text(settings_path.read_text())
            def reconnect_after_restart(name):
                global app
                previous_instance = page_checks[-1]["instance"]
                app = start(name, [binary, "agent-runlab://session/cold-session"] if name == "geometry-restart" else [binary])
                if real_dashboard:
                    wait_for(lambda: page_checks[-1]["instance"] != previous_instance and page_checks[-1]["origin"] == origin,
                             "Restart did not automatically reconnect to the last confirmed server", 45)
                    remote = wait_for(lambda: next((x for x in visible_windows()
                        if run("xdotool", "getwindowname", x).strip() == "Agent RunLab"), None), "Automatically restored Dashboard missing")
                    assert len(visible_windows()) == 1, "Automatic restart left the connection form visible"
                    assert json.loads(settings_path.read_text())["origin"] == origin
                    evidence["restartAutomaticallyReusesConfirmedOrigin"] = True
                    return remote
                local = wait_for(lambda: visible_windows()[-1] if visible_windows() else None, "Restart launcher missing")
                time.sleep(2)
                run("xdotool", "windowactivate", "--sync", local)
                run("xdotool", "key", "ctrl+a")
                run("xdotool", "type", "--clearmodifiers", origin)
                run("xdotool", "key", "Return")
                remote = wait_for(lambda: next((x for x in visible_windows() if x != local), None), "Restored dashboard missing")
                time.sleep(1)
                return remote

            restored = reconnect_after_restart("geometry-restart")
            wait_for(lambda: any(v.get("label") == "Private cold-session" for v in page_checks)
                     or any(v.get("navigate") == "cold-session" for v in feature_checks), "Cold native session link was lost before the UI initialized")
            geometry = lambda: {k: int(v) for k, v in (line.split("=", 1) for line in run("xdotool", "getwindowgeometry", "--shell", restored).splitlines())}
            wait_for(lambda: geometry()["WIDTH"] > normal_geometry["width"], "Maximized window was not restored after restart")
            maximize_window(restored, False)
            wait_for(lambda: geometry()["WIDTH"] == normal_geometry["width"] and geometry()["HEIGHT"] == normal_geometry["height"], "Normal dimensions were lost across maximized restart")
            assert not any("desktop-update" in json.dumps(n) for n in notifications), "Native updater must not produce duplicate prompts"
            menu_action("Quit")
            assert app.wait(timeout=10) == 0
            wait_for(lambda: not watcher()["RegisteredStatusNotifierItems"], "Restarted app did not quit")
            saved = json.loads(settings_path.read_text())
            saved["windows"]["dashboard"].update({"x": 90000, "y": 90000, "maximized": False})
            settings_path.write_text(json.dumps(saved))
            restored = reconnect_after_restart("offscreen-recovery")
            wait_for(lambda: 0 <= geometry()["X"] < 1440 and 0 <= geometry()["Y"] < 1000, "Off-screen saved placement was not recovered")
            screenshot("gnome-offscreen-placement-recovered.png")
            if real_dashboard:
                wait_for(lambda: page_checks[-1]["origin"] == origin and page_checks[-1]["label"] == "Private session-viewed",
                         "Offscreen-recovery Dashboard did not finish loading")
                untrusted_origin = f"https://127.0.0.1:{untrusted_server.server_port}"
                feature_commands.append({"id": "navigate-untrusted", "method": "navigate",
                                         "value": untrusted_origin + "/untrusted"})
                wait_for(lambda: page_checks[-1]["origin"] == untrusted_origin, "Unselected HTTPS origin navigation failed")
                assert ui("getInfo")["error"], "Unselected origin read native window state"
                assert ui("setActivity", base)["error"], "Unselected origin changed tray activity"
                assert ui("notify", {**notice, "id": "untrusted"})["error"], "Unselected origin sent native notification"
                evidence["unselectedOriginAllBridgeMethodsDenied"] = True
            menu_action("Quit")
            assert app.wait(timeout=10) == 0
            evidence.update({"actualGeometryRestoredAfterRestart": True, "offscreenPlacementRecovered": True,
                             "coldSessionLinkRetainedUntilConnect": True})
        evidence.update({"actualGnomeMenuOpenClickRestores": True, "trayMenuDoesNotStealFocus": True,
                         "nativeDashboardTitle": "Agent RunLab",
                         "visibleNativeMenuLabels": menu_labels, "sameWindowDocumentAndDraft": True,
                         "noReloadOnRestore": True, "closeRemovesTaskbarEntry": True,
                         "actualGnomeMinimizeRemovesTaskbarEntry": True, "minimalNativeTrayMenu": True,
                         "realGnomeExtensionLossRestores": True,
                         "localLauncherReconnect": True, "realQuitExitsAndRemovesTray": True,
                         "pageChecks": page_checks})
        assert all(check["remoteIpcDenied"] and check["remoteInfoDenied"] for check in page_checks)
        (output / "gnome-result.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence, indent=2))
        assert not feature_failures, "; ".join(feature_failures)
finally:
    if features and "notifications" in globals():
        (output / "native-feature-debug.json").write_text(json.dumps({"notifications": notifications, "checks": feature_checks,
            "pageChecks": page_checks[-20:]}, indent=2) + "\n")
    try:
        screenshot("gnome-final-screen.png")
    except Exception:
        pass
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    for log in logs:
        log.close()
    server.shutdown()
    server.server_close()
    if untrusted_server:
        untrusted_server.shutdown()
        untrusted_server.server_close()
    if fixture_trust:
        fixture_trust.unlink()
        subprocess.run(["update-ca-certificates"], check=True, capture_output=True)
