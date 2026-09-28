use gtk::prelude::*;
use std::{collections::HashSet, sync::Mutex};
use tauri::Manager;
use webkit2gtk::{
    PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
};

#[derive(Default)]
pub struct State {
    allowed_audio_origins: Mutex<HashSet<String>>,
}

pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    window.with_webview(move |platform| {
        platform.inner().connect_permission_request(move |webview, request| {
            let Ok(media) = request.clone().downcast::<UserMediaPermissionRequest>() else {
                return false;
            };
            let origin = webview.uri()
                .and_then(|uri| tauri::Url::parse(uri.as_str()).ok())
                .map(|url| url.origin().ascii_serialization());
            let Some(origin) = origin else {
                request.deny();
                return true;
            };
            let expected = app.state::<crate::ConnectionOrigin>().0.lock().unwrap().clone();
            let audio_only = media.is_for_audio_device() && !media.is_for_video_device();
            if !audio_only || origin != expected || !crate::connection::confirmed(&app, &origin) {
                request.deny();
                return true;
            }
            if app.state::<State>().allowed_audio_origins.lock().unwrap().contains(&origin) {
                request.allow();
                return true;
            }
            let parent = webview
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok());
            let dialog = gtk::MessageDialog::new(
                parent.as_ref(),
                gtk::DialogFlags::MODAL,
                gtk::MessageType::Question,
                gtk::ButtonsType::None,
                "Allow microphone access?",
            );
            dialog.set_secondary_text(Some(&format!(
                "Kala Desktop will allow the connected Dashboard at {origin} to use your microphone for voice input."
            )));
            dialog.add_button("Deny", gtk::ResponseType::Cancel);
            dialog.add_button("Allow microphone", gtk::ResponseType::Accept);
            let allowed = dialog.run() == gtk::ResponseType::Accept;
            dialog.close();
            if allowed {
                app.state::<State>().allowed_audio_origins.lock().unwrap().insert(origin);
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    }).map_err(|error| error.to_string())
}
