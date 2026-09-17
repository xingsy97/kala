use gtk::{gio, glib, prelude::*};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};

pub struct State {
    available: AtomicBool,
    uncertain: AtomicBool,
    hidden_window: Mutex<Option<String>>,
    item_path: Mutex<Option<String>>,
    status_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            available: AtomicBool::new(false),
            uncertain: AtomicBool::new(true),
            hidden_window: Mutex::new(None),
            item_path: Mutex::new(None),
            status_item: Mutex::new(None),
        }
    }
}

pub fn available(app: &tauri::AppHandle) -> bool {
    app.state::<State>().available.load(Ordering::Acquire)
}

pub fn keep_open_when_uncertain(window: &tauri::Window) -> bool {
    if !window.app_handle().state::<State>().uncertain.load(Ordering::Acquire) {
        return false;
    }
    if let Ok(parent) = window.gtk_window() {
        let dialog = gtk::MessageDialog::new(
            Some(&parent), gtk::DialogFlags::MODAL, gtk::MessageType::Info,
            gtk::ButtonsType::Ok,
            "The system tray is not responding. Agent RunLab will stay open so it remains reachable. Try again, or press Ctrl+Q to quit.",
        );
        dialog.connect_response(|dialog, _| dialog.close());
        dialog.show();
    }
    true
}

pub fn reveal(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    crate::desktop::publish_window_state(window.app_handle());
}

pub fn show_launcher(app: &tauri::AppHandle) {
    *app.state::<State>().hidden_window.lock().unwrap() = None;
    if let Some(launcher) = app.get_webview_window("launcher") {
        reveal(&launcher);
    }
}

pub fn restore(app: &tauri::AppHandle) {
    let hidden = app.state::<State>().hidden_window.lock().unwrap().take();
    let label = hidden.as_deref().unwrap_or("dashboard");
    if let Some(window) = app.get_webview_window(label).or_else(|| app.get_webview_window("launcher")) {
        reveal(&window);
    }
}

pub fn hide_if_available(app: &tauri::AppHandle, label: &str) -> bool {
    let state = app.state::<State>();
    if !state.available.load(Ordering::Acquire) {
        return false;
    }

    pub fn set_status(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
        let bounded = if label.chars().count() > 96 {
            label.chars().take(96).collect::<String>()
        } else {
            label.to_owned()
        };
        if let Some(item) = app.state::<State>().status_item.lock().unwrap().as_ref() {
            item.set_text(&bounded).map_err(|error| error.to_string())?;
        }
        if let Some(tray) = app.tray_by_id("runlab") {
            tray.set_tooltip(Some(format!("Agent RunLab - {bounded}"))).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    crate::placement::capture(app);
    *state.hidden_window.lock().unwrap() = Some(label.to_owned());
    for window in app.webview_windows().values() {
        if window.hide().is_err() {
            restore(app);
            return false;
        }
    }
    crate::desktop::publish_window_state(app);
    true
}

#[derive(Debug, PartialEq)]
enum Probe {
    Ready(String),
    MissingRegistration,
    Unavailable,
    Unknown,
}

fn availability(probe: &Probe, since_confirmed: Option<std::time::Duration>) -> (bool, bool) {
    match probe {
        Probe::Ready(_) => (true, false),
        Probe::Unknown => (since_confirmed.is_some_and(|age| age.as_secs() < 5), true),
        Probe::MissingRegistration if since_confirmed.is_some_and(|age| age.as_secs() < 1) => (true, false),
        Probe::Unavailable | Probe::MissingRegistration => (false, false),
    }
}

fn item_address(item: &str) -> (&str, &str) {
    // GNOME AppIndicator uses "bus@/path"; KDE uses "bus/path" or a service name.
    if let Some((bus, path)) = item.split_once('@') {
        (bus, path)
    } else if let Some(index) = item.find('/') {
        (&item[..index], &item[index..])
    } else {
        (item, "/StatusNotifierItem")
    }
}

fn name_owner(connection: &gio::DBusConnection, name: &str) -> Result<String, glib::Error> {
    connection.call_sync(
        Some("org.freedesktop.DBus"), "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "GetNameOwner", Some(&(name,).to_variant()), None,
        gio::DBusCallFlags::NO_AUTO_START, 1000, gio::Cancellable::NONE,
    ).map(|reply| reply.get::<(String,)>().map(|(owner,)| owner).unwrap_or_default())
}

fn missing_bus_name(error: &glib::Error) -> bool {
    use glib::translate::{from_glib_full, ToGlibPtr};
    // gio 0.18 does not expose a safe wrapper for this GIO error accessor.
    let name: Option<glib::GString> = unsafe {
        from_glib_full(gio::ffi::g_dbus_error_get_remote_error(error.to_glib_none().0))
    };
    matches!(name.as_deref(), Some("org.freedesktop.DBus.Error.NameHasNoOwner" | "org.freedesktop.DBus.Error.ServiceUnknown"))
}

fn registered_item(connection: &gio::DBusConnection) -> Probe {
    match name_owner(connection, "org.kde.StatusNotifierWatcher") {
        Err(error) if missing_bus_name(&error) => return Probe::Unavailable,
        Err(_) => return Probe::Unknown,
        Ok(_) => {}
    }
    let Ok(reply) = connection.call_sync(
        Some("org.kde.StatusNotifierWatcher"), "/StatusNotifierWatcher",
        "org.freedesktop.DBus.Properties", "GetAll",
        Some(&("org.kde.StatusNotifierWatcher",).to_variant()), None,
        gio::DBusCallFlags::NO_AUTO_START, 2000, gio::Cancellable::NONE,
    ) else { return Probe::Unknown; };
    let Some((properties,)) = reply.get::<(std::collections::HashMap<String, glib::Variant>,)>()
        else { return Probe::Unknown; };
    match properties.get("IsStatusNotifierHostRegistered").and_then(|value| value.get::<bool>()) {
        Some(true) => {}
        Some(false) => return Probe::Unavailable,
        None => return Probe::Unknown,
    }
    let Some(owner) = connection.unique_name() else { return Probe::Unknown; };
    let Some(items) = properties.get("RegisteredStatusNotifierItems").and_then(|value| value.get::<Vec<String>>())
        else { return Probe::Unknown; };
    for item in items {
        let (bus, path) = item_address(&item);
        if !path.starts_with('/') {
            continue;
        }
        if bus == owner {
            return Probe::Ready(path.to_owned());
        }
        if !bus.starts_with(':') {
            match name_owner(connection, bus) {
                Ok(resolved) if resolved == owner => return Probe::Ready(path.to_owned()),
                Err(error) if !missing_bus_name(&error) => return Probe::Unknown,
                _ => {}
            }
        }
    }
    Probe::MissingRegistration
}

fn is_item_activation(interface: Option<&str>, member: Option<&str>, path: Option<&str>, our_path: Option<&str>) -> bool {
    // DBusMenu AboutToShow only opens the popup; restoring here steals its focus.
    interface == Some("org.kde.StatusNotifierItem")
        && matches!(member, Some("Activate" | "SecondaryActivate" | "XAyatanaSecondaryActivate"))
        && our_path.is_some() && path == our_path
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)?;
    let status = MenuItem::with_id(app, "tray-status", "Idle", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "tray-open", "Open Agent RunLab", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "tray-change-server", "Change server…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &change, &quit])?;
    *app.state::<State>().status_item.lock().unwrap() = Some(status);
    let icon = app.default_window_icon().ok_or("Missing application icon")?.clone();
    TrayIconBuilder::with_id("runlab")
        .icon(icon)
        .temp_dir_path(app.path().app_cache_dir()?.join("tray-icon"))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => restore(app),
            "tray-change-server" => show_launcher(app),
            "tray-quit" => { crate::placement::capture(app); app.exit(0); }
            _ => {}
        })
        .build(app)?;

    let handle = app.handle().clone();
    // AppIndicator does not forward Linux click events through TrayIconEvent.
    // Observe only native activation of our own registered item on the session bus.
    connection.add_filter(move |_, message, incoming| {
        let state = handle.state::<State>();
        let our_path = state.item_path.lock().unwrap().clone();
        let item_activation = is_item_activation(message.interface().as_deref(),
            message.member().as_deref(), message.path().as_deref(), our_path.as_deref());
        if incoming && message.message_type() == gio::DBusMessageType::MethodCall
            && item_activation
        {
            let restore_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || restore(&restore_handle));
        }
        Some(message.clone())
    });

    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut last_confirmed: Option<std::time::Instant> = None;
        loop {
            let state = handle.state::<State>();
            let probe = registered_item(&connection);
            let (available, uncertain) = availability(&probe, last_confirmed.map(|at| at.elapsed()));
            state.available.store(available, Ordering::Release);
            state.uncertain.store(uncertain, Ordering::Release);
            match probe {
                Probe::Ready(path) => {
                    last_confirmed = Some(std::time::Instant::now());
                    *state.item_path.lock().unwrap() = Some(path);
                }
                Probe::Unknown => {}
                Probe::MissingRegistration if available => {}
                Probe::Unavailable | Probe::MissingRegistration => {
                    last_confirmed = None;
                    *state.item_path.lock().unwrap() = None;
                }
            }
            if !state.available.load(Ordering::Acquire) && state.hidden_window.lock().unwrap().is_some() {
                let restore_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || restore(&restore_handle));
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_activation_of_our_item_restores_the_window() {
        let path = Some("/org/ayatana/NotificationItem/tray_icon_tray_app_runlab");
        for member in ["Activate", "SecondaryActivate", "XAyatanaSecondaryActivate"] {
            assert!(is_item_activation(Some("org.kde.StatusNotifierItem"), Some(member), path, path));
            assert!(!is_item_activation(Some("org.kde.StatusNotifierItem"), Some(member), path, None));
            assert!(!is_item_activation(Some("org.kde.StatusNotifierItem"), Some(member), Some("/another/item"), path));
        }
        for member in ["AboutToShow", "AboutToShowGroup", "Event"] {
            assert!(!is_item_activation(Some("com.canonical.dbusmenu"), Some(member), path, path));
        }
    }

    #[test]
    fn accepts_real_gnome_and_kde_registration_encodings() {
        assert_eq!(item_address(":1.12@/org/ayatana/NotificationItem/tray_icon_tray_app_runlab"),
                   (":1.12", "/org/ayatana/NotificationItem/tray_icon_tray_app_runlab"));
        assert_eq!(item_address(":1.12/StatusNotifierItem"), (":1.12", "/StatusNotifierItem"));
        assert_eq!(item_address("org.kde.StatusNotifierItem-42-1"),
                   ("org.kde.StatusNotifierItem-42-1", "/StatusNotifierItem"));
    }

    #[test]
    fn transient_errors_do_not_discard_confirmed_tray_or_silently_quit() {
        use std::time::Duration;
        assert_eq!(availability(&Probe::Unknown, Some(Duration::from_secs(1))), (true, true));
        assert_eq!(availability(&Probe::Unknown, Some(Duration::from_secs(5))), (false, true));
        assert_eq!(availability(&Probe::Unknown, None), (false, true));
        assert_eq!(availability(&Probe::MissingRegistration, Some(Duration::from_millis(500))), (true, false));
        assert_eq!(availability(&Probe::MissingRegistration, Some(Duration::from_secs(1))), (false, false));
        assert_eq!(availability(&Probe::Unavailable, Some(Duration::ZERO)), (false, false));
    }
}
