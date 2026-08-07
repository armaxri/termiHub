//! File-browser projection: the client-scoped `file-browser@<clientId>` region
//! and the `fileBrowser.*` intents (#2228, Phase 5 of #2139 / #2153).
//!
//! Exposes the authoritative [`FileBrowserStore`] to each attached client as its
//! own versioned, multi-subscriber projection region and turns the file-browser
//! view transitions the frontend currently drives into [`Intent`]s — mirroring
//! the client-scoped `broadcast` ([`crate::broadcast_projection`]) and
//! `workflow-run` ([`crate::workflow_projection`]) siblings and the reference
//! substrate registration pattern ([`crate::projection`]).
//!
//! # The `file-browser@<clientId>` region
//!
//! **Client-scoped** (Open Design Decision #4 / #6: an open file browser — its
//! cwd, listing, active pane and clipboard — is a property of the viewing
//! client's pane, not shared infrastructure; the filesystem/SFTP backend is
//! shared, the *browser view over it* is not). Each client gets its own region,
//! seeded lazily and mutated via `intent.client_id`. The view model:
//!
//! ```json
//! {
//!   "mode": "none" | "local" | "session",
//!   "local":   { "path": "/", "entries": [ …FileEntry ], "loading": false, "error": null },
//!   "session": { … },
//!   "clipboard": null | { "entries": [ …FileEntry ], "operation": "copy" | "cut",
//!                         "sourceMode": "local" | "session",
//!                         "sourcePath": "…", "terminalSessionId": "…"? }
//! }
//! ```
//!
//! # Intents
//!
//! | kind                        | payload                                | effect                                              |
//! | --------------------------- | -------------------------------------- | --------------------------------------------------- |
//! | `fileBrowser.setMode`       | `{ mode }`                             | set the active pane (`local`/`session`/`none`)      |
//! | `fileBrowser.loadStarted`   | `{ pane }`                             | mark the pane loading, clear its error              |
//! | `fileBrowser.loadSucceeded` | `{ pane, path, entries }`              | commit the pane's path + listing, clear loading     |
//! | `fileBrowser.loadFailed`    | `{ pane, error? }`                     | clear loading, record the error, keep last listing  |
//! | `fileBrowser.reset`         | `{ pane }`                             | reset the pane to the idle baseline (`/`, empty)    |
//! | `fileBrowser.setClipboard`  | `{ clipboard }` (`null` clears)        | set / clear the copy-cut clipboard                  |
//! | `fileBrowser.replace`       | `{ mode?, local?, session?, clipboard? }` | overwrite the whole client view (render-cut mirror) |
//!
//! `fileBrowser.replace` is the whole-slice seed the frontend render cut (#2228)
//! uses to keep the client's region a faithful copy of `appStore`'s file-browser
//! UI-state slice while `appStore` stays authoritative — the analog of the
//! connections bridge's `connection.replace`. The per-transition intents above
//! drive the store for the (later) mutation cut.
//!
//! `pane` is the concrete browser being acted on (`local` / `session`); `mode` is
//! which pane is *active* and additionally accepts `"none"`. Since the SFTP
//! convergence (#2313 / #2422) SSH browses through the `session` pane, so the
//! legacy standalone `sftp` pane is gone. The directory-list side-effects (the
//! actual `localListDir` / `sessionListFiles` calls) stay frontend orchestration;
//! the store learns of a list only through these `loadStarted` → `loadSucceeded`
//! / `loadFailed` intents. The backend session model (live session ids, connect
//! status, transfers) is out of scope; see
//! [`crate::file_browser_projection::store`].
//!
//! # Shadow only (#2228)
//!
//! Registered and fully served, but nothing in the live UI subscribes to or
//! dispatches these intents yet — a pure shadow foundation. Later steps cut
//! rendering, then the mutations, over to it, keeping the `appStore` reducers as
//! the parity-safe fallback. Per the substrate contract the result of an intent
//! is never returned inline — it always arrives as a projection diff on the
//! client's region.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::file_browser_projection::store::{
    ClientView, Clipboard, FileBrowserKind, FileBrowserStore, FileEntry,
};
use crate::projection::{HandlerRegistry, Intent, ProducedRegion, Projector};

/// The projection region id for a client's file browser
/// (`file-browser@<clientId>`).
pub fn file_browser_region(client_id: &str) -> String {
    format!("file-browser@{client_id}")
}

/// Publish a client's `file-browser` region from the store, fanning a diff out
/// to every subscriber and returning the advanced region for the intent ack
/// (empty when the view did not change).
pub fn publish_file_browser(
    projector: &Projector,
    store: &FileBrowserStore,
    client_id: &str,
) -> Vec<ProducedRegion> {
    let region = file_browser_region(client_id);
    match projector.publish(&region, store.snapshot(client_id)) {
        Some(version) => vec![ProducedRegion { region, version }],
        None => Vec::new(),
    }
}

/// Register the `fileBrowser.*` intents on a handler registry.
///
/// Each route resolves the managed [`FileBrowserStore`] lazily (so it rejects
/// gracefully rather than panicking if the store is somehow absent), mutates the
/// dispatching client's browser view via [`intent.client_id`](Intent::client_id),
/// and publishes that client's region. All transitions are pure/fast map edits,
/// so they run inline on the dispatcher's single writer.
pub fn register_file_browser_intents(registry: &mut HandlerRegistry, app_handle: AppHandle) {
    let handle = app_handle.clone();
    registry.route("fileBrowser.setMode", move |intent, projector| {
        let store = store_of(&handle)?;
        let mode = parse_mode(intent)?;
        store.set_mode(&intent.client_id, mode);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("fileBrowser.loadStarted", move |intent, projector| {
        let store = store_of(&handle)?;
        let pane = parse_pane(intent)?;
        store.load_started(&intent.client_id, pane);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("fileBrowser.loadSucceeded", move |intent, projector| {
        let store = store_of(&handle)?;
        let pane = parse_pane(intent)?;
        let path = required_str(intent, "path")?;
        let entries = parse_entries(intent)?;
        store.load_succeeded(&intent.client_id, pane, &path, entries);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("fileBrowser.loadFailed", move |intent, projector| {
        let store = store_of(&handle)?;
        let pane = parse_pane(intent)?;
        let error = optional_str(intent, "error");
        store.load_failed(&intent.client_id, pane, error);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("fileBrowser.reset", move |intent, projector| {
        let store = store_of(&handle)?;
        let pane = parse_pane(intent)?;
        store.reset_pane(&intent.client_id, pane);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle.clone();
    registry.route("fileBrowser.setClipboard", move |intent, projector| {
        let store = store_of(&handle)?;
        let clipboard = parse_clipboard(intent)?;
        store.set_clipboard(&intent.client_id, clipboard);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });

    let handle = app_handle;
    registry.route("fileBrowser.replace", move |intent, projector| {
        let store = store_of(&handle)?;
        let view = parse_view(intent)?;
        store.replace(&intent.client_id, view);
        Ok(publish_file_browser(projector, &store, &intent.client_id))
    });
}

/// Resolve the managed file-browser store, or a rejectable error if absent.
fn store_of(app_handle: &AppHandle) -> Result<Arc<FileBrowserStore>, (String, String)> {
    app_handle
        .try_state::<Arc<FileBrowserStore>>()
        .map(|state| (*state).clone())
        .ok_or_else(|| {
            (
                "unavailable".to_string(),
                "file-browser store is not initialized".to_string(),
            )
        })
}

/// Parse the active-mode field (`"local"` / `"session"` / `"none"`) into an
/// optional [`FileBrowserKind`] (`"none"` → `None`).
fn parse_mode(intent: &Intent) -> Result<Option<FileBrowserKind>, (String, String)> {
    match intent.payload.get("mode").and_then(Value::as_str) {
        Some("none") => Ok(None),
        Some("local") => Ok(Some(FileBrowserKind::Local)),
        Some("session") => Ok(Some(FileBrowserKind::Session)),
        Some(_) => Err(("bad_payload".to_string(), "invalid 'mode'".to_string())),
        None => Err(("bad_payload".to_string(), "missing 'mode'".to_string())),
    }
}

/// Parse the target-pane field into a concrete [`FileBrowserKind`]. Unlike
/// `mode`, a pane must be concrete — `"none"` is rejected.
fn parse_pane(intent: &Intent) -> Result<FileBrowserKind, (String, String)> {
    match intent.payload.get("pane").and_then(Value::as_str) {
        Some("local") => Ok(FileBrowserKind::Local),
        Some("session") => Ok(FileBrowserKind::Session),
        Some(_) => Err(("bad_payload".to_string(), "invalid 'pane'".to_string())),
        None => Err(("bad_payload".to_string(), "missing 'pane'".to_string())),
    }
}

/// Parse the required `entries` array into typed [`FileEntry`]s, rejecting a
/// missing or malformed listing.
fn parse_entries(intent: &Intent) -> Result<Vec<FileEntry>, (String, String)> {
    let value = intent
        .payload
        .get("entries")
        .ok_or_else(|| ("bad_payload".to_string(), "missing 'entries'".to_string()))?;
    serde_json::from_value(value.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid 'entries': {e}")))
}

/// Parse a `fileBrowser.replace` payload into a whole-client [`ClientView`] — the
/// render-cut mirror's snapshot of `appStore`'s file-browser slice (`{ mode,
/// local, session, clipboard }`, the shape of the region view model). Any
/// field absent defaults to the idle baseline; a present-but-malformed field is a
/// `bad_payload` rejection that advances nothing.
fn parse_view(intent: &Intent) -> Result<ClientView, (String, String)> {
    serde_json::from_value(intent.payload.clone())
        .map_err(|e| ("bad_payload".to_string(), format!("invalid view: {e}")))
}

/// Parse the `clipboard` field into an optional [`Clipboard`]; a missing or
/// `null` value clears the clipboard.
fn parse_clipboard(intent: &Intent) -> Result<Option<Clipboard>, (String, String)> {
    match intent.payload.get("clipboard") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| {
                (
                    "bad_payload".to_string(),
                    format!("invalid 'clipboard': {e}"),
                )
            }),
    }
}

/// Extract a required string field from an intent payload.
fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ("bad_payload".to_string(), format!("missing '{key}'")))
}

/// Extract an optional string field (e.g. a failure reason); absent → `None`.
fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
