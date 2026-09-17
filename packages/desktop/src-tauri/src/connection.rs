use gtk::{glib, prelude::*};
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::Manager;

#[derive(Clone, Copy)]
struct CancelledNavigation;

impl glib::error::ErrorDomain for CancelledNavigation {
    fn domain() -> glib::Quark { glib::Quark::from_str("WebKitNetworkError") }
    fn code(self) -> i32 { 302 }
    fn from(code: i32) -> Option<Self> { (code == 302).then_some(Self) }
}

#[derive(Default)]
pub struct State {
    bootstrapped: AtomicBool,
    attempt: Mutex<Attempt>,
}

#[derive(Default)]
struct Attempt {
    generation: u64,
    origin: String,
    loaded: bool,
    confirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    origin: Option<String>,
    auto_connect: bool,
}

#[tauri::command]
pub async fn launcher_bootstrap(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Bootstrap, String> {
    crate::desktop::on_ui(app, move |app| {
        crate::authorize_launcher(&window)?;
        let first = !app.state::<State>().bootstrapped.swap(true, Ordering::AcqRel);
        let origin = crate::placement::load_result()?.origin
            .map(|origin| crate::endpoint_url(&origin).map(|url| url.origin().ascii_serialization())).transpose()?;
        Ok(Bootstrap { auto_connect: first && origin.is_some(), origin })
    }).await
}

pub fn confirmed(app: &tauri::AppHandle, origin: &str) -> bool {
    let state = app.state::<State>();
    let attempt = state.attempt.lock().unwrap();
    attempt.origin == origin && attempt.confirmed
}

pub fn begin(app: &tauri::AppHandle, origin: &str) {
    let generation = {
        let state = app.state::<State>();
        let mut attempt = state.attempt.lock().unwrap();
        let generation = attempt.generation + 1;
        *attempt = Attempt { generation, origin: origin.to_owned(), ..Attempt::default() };
        generation
    };
    let app = app.clone();
    glib::timeout_add_local_once(std::time::Duration::from_secs(20), move || {
        let pending = {
            let state = app.state::<State>();
            let attempt = state.attempt.lock().unwrap();
            attempt.generation == generation && !attempt.loaded && !attempt.confirmed
        };
        if pending {
            show_error(&app, "The server did not finish loading. Check the address and network, then retry. Your last successful server has not been changed.");
        }
    });
}

pub fn loaded(app: &tauri::AppHandle) {
    app.state::<State>().attempt.lock().unwrap().loaded = true;
}

pub fn confirm(app: &tauri::AppHandle, origin: &str) -> Result<(), String> {
    let state = app.state::<State>();
    let mut attempt = state.attempt.lock().unwrap();
    if attempt.origin != origin { return Err("This connection attempt has been superseded.".into()); }
    crate::placement::remember_origin(origin)?;
    attempt.confirmed = true;
    attempt.loaded = true;
    Ok(())
}

fn show_error(app: &tauri::AppHandle, message: &str) {
    eprintln!("{message}");
    if let Some(launcher) = app.get_webview_window("launcher") {
        let message = serde_json::to_string(message).expect("connection error string is serializable");
        if let Err(error) = launcher.eval(&format!("window.dispatchEvent(new CustomEvent('runlab:connection-error',{{detail:{message}}}));")) {
            eprintln!("Unable to display the connection error: {error}");
        }
        crate::tray::show_launcher(app);
    }
}

pub fn watch_load_failures(window: &tauri::WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    window.with_webview(move |platform| {
        // Use the existing GLib signal API rather than add a second WebKit dependency.
        platform.inner().connect_local("load-failed", false, move |values| {
            let uri = values.get(2).and_then(|value| value.get::<String>().ok());
            let error = values.get(3).and_then(|value| value.get::<glib::Error>().ok());
            if let (Some(uri), Some(error)) = (uri, error) {
                // WebKit uses 302 for navigation cancelled by a newer load.
                let cancelled = error.matches(CancelledNavigation);
                let current = app.state::<crate::ConnectionOrigin>().0.lock().unwrap().clone();
                let failed_origin = tauri::Url::parse(&uri).ok().map(|url| url.origin().ascii_serialization());
                if !cancelled && failed_origin.as_deref() == Some(current.as_str()) {
                    loaded(&app);
                    show_error(&app, &format!("Unable to load {current}: {error}. Check the address, network and certificate, then retry."));
                }
            } else {
                eprintln!("Unable to decode the Dashboard load-failed signal.");
            }
            Some(false.to_value())
        });
    }).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cancelled_webkit_navigation_is_ignored() {
        assert!(glib::Error::new(CancelledNavigation, "cancelled").matches(CancelledNavigation));
        assert!(!glib::Error::new(gtk::gio::IOErrorEnum::HostNotFound, "unreachable").matches(CancelledNavigation));
    }
}
