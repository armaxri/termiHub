//! Native macOS Services provider for the app-level "Open in termiHub"
//! Services-menu entry (#1409).
//!
//! #1369 declared an app-level [`NSServices`] entry (`openInTermiHub`) in
//! `src-tauri/Info.plist` so the Finder integration is discoverable in file
//! managers that surface *app* Services rather than the per-entry Automator
//! Quick Action bundles. That declaration alone is inert: an app-provided
//! Service is only functional once a native Cocoa object implementing the
//! declared `NSMessage` selector is registered on `NSApp.servicesProvider`.
//! Tauri does not expose that hook, so this module registers one.
//!
//! When the user picks the entry, macOS invokes
//! `openInTermiHub:userData:error:` on our provider with the selected
//! file-system objects on an [`NSPasteboard`]. We read the selected paths and
//! forward each into the **same** spawn flow the Quick Action bundles use: a
//! [`SpawnRequest`] re-emitted as the [`SPAWN_REQUEST_EVENT`] Tauri event, which
//! the running instance already handles (see `lib.rs`). This is the internal
//! equivalent of the bundles' `termiHub spawn --location <path>` invocation — no
//! separate spawn mechanism is introduced.
//!
//! Everything here is `#[cfg(target_os = "macos")]`-gated at the module
//! declaration in `lib.rs`, so Windows/Linux builds never see this code. The
//! only unavoidable `unsafe` is the Objective-C FFI (declaring the class,
//! reading the AppKit pasteboard-type constant, and installing the provider);
//! each block is kept tight and documented.
//!
//! [`NSServices`]: https://developer.apple.com/documentation/bundleresources/information_property_list/nsservices

use crate::spawn::{SpawnRequest, SPAWN_REQUEST_EVENT};
use anyhow::{Context, Result};
use objc2::rc::Retained;
use objc2::runtime::NSObject;
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSPasteboard, NSUpdateDynamicServices};
// `NSFilenamesPboardType` is deprecated in favour of per-item file URLs, but it
// is the pasteboard format the system fills for a legacy `NSSendFileTypes`
// service invocation, so it is the correct constant to read here (#1409).
#[allow(deprecated)]
use objc2_app_kit::NSFilenamesPboardType;
use objc2_foundation::{NSArray, NSString};
use tauri::{AppHandle, Emitter};

/// Map the file-system paths carried by a Services invocation into the spawn
/// requests forwarded to the running instance.
///
/// Each non-empty (trimmed) path becomes a location-only [`SpawnRequest`]: the
/// app-level Services entry is generic (not bound to a specific configured
/// context-menu entry), so it carries no `entry_id`, letting the downstream
/// resolver fall back to the configured default connection — exactly the
/// semantics of a plain "Open in termiHub".
///
/// Pure and free of Objective-C so the path→request mapping is unit-testable
/// without a GUI.
pub fn spawn_requests_from_paths(paths: &[String]) -> Vec<SpawnRequest> {
    paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .map(|path| SpawnRequest {
            location: Some(path.to_string()),
            ..SpawnRequest::default()
        })
        .collect()
}

/// Instance state for the provider: the handle used to re-emit spawn requests.
struct Ivars {
    app_handle: AppHandle,
}

define_class!(
    /// Objective-C object registered on `NSApp.servicesProvider`. Its single
    /// method implements the `openInTermiHub` `NSMessage` selector declared in
    /// `Info.plist`.
    #[unsafe(super(NSObject))]
    #[name = "TermiHubServicesProvider"]
    #[ivars = Ivars]
    struct ServicesProvider;

    impl ServicesProvider {
        /// Handler for the app-level "Open in termiHub" Service.
        ///
        /// macOS forms the selector by appending `:userData:error:` to the
        /// declared `NSMessage` (`openInTermiHub`). `pboard` carries the
        /// selected file-system objects; `user_data` and `error` are unused
        /// (we never report a Service error back to the system).
        #[unsafe(method(openInTermiHub:userData:error:))]
        fn open_in_termihub(
            &self,
            pboard: &NSPasteboard,
            _user_data: *mut NSString,
            _error: *mut *mut NSString,
        ) {
            let paths = read_filenames(pboard);
            self.forward_spawn_requests(&paths);
        }
    }
);

impl ServicesProvider {
    /// Allocate a provider bound to `app_handle`.
    fn new(app_handle: AppHandle) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { app_handle });
        // SAFETY: standard NSObject designated-initializer chain for a class
        // defined via `define_class!`.
        unsafe { msg_send![super(this), init] }
    }

    /// Emit one [`SPAWN_REQUEST_EVENT`] per selected path, reusing the running
    /// instance's existing spawn handling.
    fn forward_spawn_requests(&self, paths: &[String]) {
        let handle = &self.ivars().app_handle;
        for request in spawn_requests_from_paths(paths) {
            if let Err(e) = handle.emit(SPAWN_REQUEST_EVENT, &request) {
                tracing::warn!("failed to emit spawn-request from Services provider: {e}");
            }
        }
    }
}

/// Read the selected file-system paths from a Services-invocation pasteboard.
///
/// The classic Services pasteboard format stores the selection under
/// `NSFilenamesPboardType` as an `NSArray<NSString>` of absolute paths, which
/// is what a `NSSendFileTypes` service receives. Returns an empty vec when the
/// type is absent or holds an unexpected shape.
///
/// `NSFilenamesPboardType` is formally deprecated in favour of per-item file
/// URLs, but it remains the format the system fills for a legacy
/// `NSSendFileTypes` service invocation, so it is the correct constant here.
#[allow(deprecated)]
fn read_filenames(pboard: &NSPasteboard) -> Vec<String> {
    // SAFETY: reading the AppKit-provided static pasteboard-type constant.
    let file_type = unsafe { NSFilenamesPboardType };
    let Some(plist) = pboard.propertyListForType(file_type) else {
        return Vec::new();
    };
    let Ok(array) = plist.downcast::<NSArray>() else {
        return Vec::new();
    };
    array
        .to_vec()
        .into_iter()
        .filter_map(|obj| obj.downcast::<NSString>().ok())
        .map(|s| s.to_string())
        .collect()
}

/// Register the native Services provider on `NSApp` so the app-level
/// "Open in termiHub" Services-menu entry becomes functional (#1409).
///
/// Must run on the main thread, after `NSApplication` exists (i.e. from the
/// Tauri `setup` hook). Best-effort: a failure to acquire the main-thread
/// marker leaves the entry inert but never blocks startup.
pub fn register(app_handle: AppHandle) -> Result<()> {
    let mtm = MainThreadMarker::new()
        .context("register macOS Services provider must run on the main thread")?;
    let provider = ServicesProvider::new(app_handle);
    let app = NSApplication::sharedApplication(mtm);
    // SAFETY: installing the provider. AppKit does *not* retain the services
    // provider, so we intentionally leak the single app-lifetime instance
    // (below) to keep it alive for as long as the Service can be invoked.
    unsafe { app.setServicesProvider(Some(&*provider)) };
    // Keep the provider alive for the process lifetime; `setServicesProvider`
    // stores an unretained reference.
    std::mem::forget(provider);
    // Refresh the dynamic services table so the freshly-installed provider is
    // picked up without requiring a re-login.
    NSUpdateDynamicServices();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_each_path_to_a_location_only_request() {
        let paths = vec!["/Users/me/project".to_string(), "/tmp/file.txt".to_string()];
        let requests = spawn_requests_from_paths(&paths);

        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].location.as_deref(), Some("/Users/me/project"));
        assert_eq!(requests[1].location.as_deref(), Some("/tmp/file.txt"));
        // The generic app-level entry carries no entry-id / connection override,
        // and never forces a new window or the picker.
        for request in &requests {
            assert!(request.entry_id.is_none());
            assert!(request.connection.is_none());
            assert!(!request.new_window);
            assert!(!request.pick);
        }
    }

    #[test]
    fn trims_paths_and_drops_blank_entries() {
        let paths = vec![
            "  /Users/me/dir  ".to_string(),
            "   ".to_string(),
            String::new(),
        ];
        let requests = spawn_requests_from_paths(&paths);

        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].location.as_deref(), Some("/Users/me/dir"));
    }

    #[test]
    fn empty_selection_yields_no_requests() {
        assert!(spawn_requests_from_paths(&[]).is_empty());
    }
}
