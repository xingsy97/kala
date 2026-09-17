use gtk::{glib, prelude::*};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, io::Write, os::unix::fs::{OpenOptionsExt, PermissionsExt}, sync::{LazyLock, Mutex}};
use tauri::Manager;

static FILE_LOCK: Mutex<()> = Mutex::new(());
static READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct Settings {
    pub origin: Option<String>,
    #[serde(default)]
    windows: HashMap<String, Placement>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Placement { width: u32, height: u32, x: Option<i32>, y: Option<i32>, maximized: bool }

fn directory() -> std::path::PathBuf { glib::user_config_dir().join("io.github.xingsy97.akernel.desktop") }
fn read() -> Result<Settings, String> {
    let bytes = match std::fs::read(directory().join("desktop-state.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(error) => return Err(format!("Unable to read desktop settings: {error}")),
    };
    if bytes.len() > 16384 { return Err("Desktop settings exceed the supported size.".into()); }
    serde_json::from_slice(&bytes).map_err(|error| format!("Unable to read desktop settings: {error}"))
}
pub fn load_result() -> Result<Settings, String> { let _lock = FILE_LOCK.lock().unwrap(); read() }
pub fn load() -> Settings {
    load_result().unwrap_or_else(|error| { eprintln!("{error}"); Settings::default() })
}
pub fn modify(change: impl FnOnce(&mut Settings)) {
    if let Err(error) = try_modify(change) { eprintln!("Unable to save desktop settings: {error}"); }
}
fn try_modify(change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let _lock = FILE_LOCK.lock().unwrap();
    let mut state = read()?;
    let previous = state.clone();
    change(&mut state);
    if previous == state { return Ok(()); }
    let dir = directory();
    let save = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        if std::fs::symlink_metadata(&dir)?.file_type().is_symlink() {
            return Err(std::io::Error::other("Desktop settings directory must not be a symbolic link."));
        }
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let pending = dir.join("desktop-state.json.pending");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&pending)?;
        file.write_all(&serde_json::to_vec(&state)?)?;
        file.sync_all()?;
        std::fs::rename(pending, dir.join("desktop-state.json"))?;
        std::fs::File::open(&dir)?.sync_all()
    };
    save().map_err(|error| error.to_string())
}
pub fn remember_origin(origin: &str) -> Result<(), String> {
    try_modify(|state| state.origin = Some(origin.to_owned()))
}

fn bounded_size(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    (width.clamp(320, max_width.max(320)), height.clamp(240, max_height.max(240)))
}

pub fn initial_size(app: &tauri::AppHandle, label: &str, fallback: (f64, f64)) -> (f64, f64) {
    let desired = load().windows.get(label).map(|p| (p.width as f64, p.height as f64)).unwrap_or(fallback);
    let bounds = app.get_webview_window("launcher").and_then(|window| window.current_monitor().ok().flatten())
        .map(|monitor| (((monitor.size().width as f64 / monitor.scale_factor()) as u32).saturating_sub(64),
                        ((monitor.size().height as f64 / monitor.scale_factor()) as u32).saturating_sub(128)))
        .unwrap_or((8192, 8192));
    let size = bounded_size(desired.0 as u32, desired.1 as u32, bounds.0, bounds.1);
    (size.0 as f64, size.1 as f64)
}

pub fn restore(window: &tauri::WebviewWindow) {
    READY.lock().unwrap().remove(window.label());
    restore_saved(window);
    READY.lock().unwrap().insert(window.label().to_owned());
}

fn restore_saved(window: &tauri::WebviewWindow) {
    let Some(saved) = load().windows.get(window.label()).cloned() else { return; };
    let Ok(monitors) = window.available_monitors() else { return; };
    let chosen = monitors.iter().find(|monitor| {
        saved.x.zip(saved.y).is_some_and(|(x, y)| {
            let p = monitor.position(); let s = monitor.size();
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
    }).or_else(|| monitors.first());
    let Some(monitor) = chosen else { return; };
    let max_width = (monitor.size().width as f64 / monitor.scale_factor()) as u32;
    let max_height = (monitor.size().height as f64 / monitor.scale_factor()) as u32;
    let (width, height) = bounded_size(saved.width, saved.height, max_width.saturating_sub(32), max_height.saturating_sub(64));
    if !saved.maximized { let _ = window.unmaximize(); }
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if std::env::var("XDG_SESSION_TYPE").as_deref() != Ok("wayland") {
        let p = monitor.position(); let s = monitor.size();
        let physical_width = (width as f64 * monitor.scale_factor()) as i32;
        let physical_height = (height as f64 * monitor.scale_factor()) as i32;
        let x = saved.x.unwrap_or(p.x + 32).clamp(p.x, p.x + (s.width as i32 - physical_width - 16).max(0));
        let y = saved.y.unwrap_or(p.y + 32).clamp(p.y + 32, p.y + (s.height as i32 - physical_height - 64).max(32));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    if saved.maximized { let _ = window.maximize(); }
}

pub fn capture(app: &tauri::AppHandle) {
    modify(|settings| {
        for (label, window) in app.webview_windows() {
            if !READY.lock().unwrap().contains(&label) || !window.is_visible().unwrap_or(false) { continue; }
            let Ok(native) = window.gtk_window() else { continue; };
            let maximized = native.is_maximized();
            let (width, height) = native.size();
            if width < 100 || height < 100 { continue; }
            let entry = settings.windows.entry(label).or_insert(Placement {
                width: width as u32, height: height as u32,
                x: None, y: None, maximized,
            });
            entry.maximized = maximized;
        }
    });
}

pub fn event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !READY.lock().unwrap().contains(window.label()) { return; }
    let Ok(native) = window.gtk_window() else { return; };
    if native.is_maximized() || native.window().is_some_and(|window| window.state().contains(gtk::gdk::WindowState::ICONIFIED)) {
        return;
    }
    // Configure-event payloads are authoritative; querying allocation here can return the preceding frame.
    modify(|settings| {
        let Some(entry) = settings.windows.get_mut(window.label()) else { return; };
        match event {
            tauri::WindowEvent::Resized(size) if size.width >= 100 && size.height >= 100 => {
                let scale = window.scale_factor().unwrap_or(1.0);
                entry.width = (size.width as f64 / scale) as u32;
                entry.height = (size.height as f64 / scale) as u32;
            }
            tauri::WindowEvent::Moved(position) if std::env::var("XDG_SESSION_TYPE").as_deref() != Ok("wayland") => {
                entry.x = Some(position.x); entry.y = Some(position.y);
            }
            _ => {}
        }
    });
}

pub fn setup(app: &tauri::AppHandle) {
    if let Some(launcher) = app.get_webview_window("launcher") { restore(&launcher); }
    let app = app.clone();
    let mut layout = Vec::new();
    glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
        if let Some(window) = app.webview_windows().values().next() {
            if let Ok(monitors) = window.available_monitors() {
                let current: Vec<_> = monitors.iter().map(|m| (m.position().x, m.position().y, m.size().width, m.size().height)).collect();
                if !layout.is_empty() && current != layout {
                    for window in app.webview_windows().values() { restore(window); }
                }
                layout = current;
            }
        }
        capture(&app);
        glib::ControlFlow::Continue
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_dimensions_are_bounded_by_current_display() {
        assert_eq!(bounded_size(9000, 8000, 1280, 720), (1280, 720));
        assert_eq!(bounded_size(0, 1, 1280, 720), (320, 240));
    }
}
