//! Native macOS `NSPasteboard` binding for pasting remote-copied RDP clipboard
//! files into local apps with **delayed rendering** (#1804).
//!
//! Follow-up to #1793: the RDP sidecar surfaces the list of files the remote
//! copied to its clipboard (via `GraphicalBackend::remote_clipboard_files`) and
//! streams a file's bytes on demand (`fetch_remote_clipboard_file`) — but nothing
//! binds that transport to the host OS clipboard. This module does, on macOS.
//!
//! ## Delayed rendering, the AppKit way
//!
//! When the user chooses "make the remote files pasteable" in the RemoteDesktop
//! UI, [`bind_remote_clipboard_files`] declares the deprecated-but-still-honoured
//! `NSFilenamesPboardType` on the general pasteboard with an **owner** object but
//! writes no data. This is AppKit's *promised data* pattern: the owner's
//! `pasteboard:provideDataForType:` is invoked only when another app actually
//! reads that type — i.e. on the real paste gesture. Only then do we fetch each
//! file's bytes from the remote (streamed into a sanitized, bounded temp file by
//! the sidecar) and hand the receiver the staged paths. No bytes move on copy;
//! memory stays bounded to whatever a single fetch stages.
//!
//! The provider object is kept alive as the current pasteboard owner in a
//! main-thread [`thread_local`]; each new bind replaces (and drops) the previous
//! one, so at most one owner is ever retained. AppKit stores the owner
//! **unretained**, exactly like the Services provider in
//! [`crate::macos_services`], which this module mirrors.
//!
//! Everything here is `#[cfg(target_os = "macos")]`-gated at the module
//! declaration in `lib.rs`. Windows (`CF_HDROP` / `WM_RENDERFORMAT`) and Linux
//! (X11/Wayland `text/uri-list` data source) bindings are tracked as follow-ups;
//! on those platforms `clipboard_delayed_render` stays off and the eager
//! shared-folder download (#1765) remains the behaviour.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_app_kit::NSPasteboard;
// `NSFilenamesPboardType` is deprecated in favour of per-item file URLs, but it
// is the type the general pasteboard's promised-data (owner) mechanism serves for
// a multi-file selection, and the type Finder and most apps accept on paste.
#[allow(deprecated)]
use objc2_app_kit::NSFilenamesPboardType;
use objc2_foundation::{NSArray, NSString};
use tauri::AppHandle;

use crate::session::graphical_manager::GraphicalSessionManager;
use termihub_core::connection::RemoteClipboardFile;

/// The advertised indices of the files worth offering to the OS clipboard — the
/// regular files, in order. Directories carry no bytes to fetch (they are
/// surfaced only so a copied tree can be recreated), so they are dropped.
///
/// Pure and Objective-C-free so the selection logic is unit-testable without a
/// pasteboard.
fn pasteable_indices(files: &[RemoteClipboardFile]) -> Vec<u32> {
    files
        .iter()
        .filter(|f| !f.is_dir)
        .map(|f| f.index)
        .collect()
}

/// Instance state for the pasteboard owner: how to fetch each promised file when
/// the receiver pastes.
struct Ivars {
    /// Clone of the graphical manager (Arc-backed) used to reach the session's
    /// backend for on-demand byte fetches.
    manager: GraphicalSessionManager,
    /// The session whose remote clipboard these files belong to.
    session_id: String,
    /// Advertised indices to fetch, in paste order.
    indices: Vec<u32>,
}

define_class!(
    /// Objective-C object installed as the general pasteboard's owner for the
    /// promised `NSFilenamesPboardType`. Its single method fetches the remote
    /// bytes lazily when a paste reads the type (#1804).
    #[unsafe(super(NSObject))]
    #[name = "TermiHubRemoteClipboardProvider"]
    #[ivars = Ivars]
    struct RemoteClipboardProvider;

    impl RemoteClipboardProvider {
        /// AppKit promised-data callback: the receiver is pasting and wants the
        /// data for `_type`. We only ever declared `NSFilenamesPboardType`, so we
        /// fetch every promised file's bytes now (delayed rendering) and set the
        /// staged paths as the property list.
        #[unsafe(method(pasteboard:provideDataForType:))]
        fn provide_data(&self, pboard: &NSPasteboard, _ptype: &NSString) {
            self.provide(pboard);
        }
    }
);

impl RemoteClipboardProvider {
    /// Allocate a provider bound to a session and its promised file indices.
    fn new(
        manager: GraphicalSessionManager,
        session_id: String,
        indices: Vec<u32>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars {
            manager,
            session_id,
            indices,
        });
        // SAFETY: standard NSObject designated-initializer chain for a class
        // defined via `define_class!`.
        unsafe { msg_send![super(this), init] }
    }

    /// Fetch each promised file's bytes on demand and hand the receiver the
    /// staged paths as an `NSArray<NSString>` under `NSFilenamesPboardType`.
    ///
    /// Runs on the main thread (the pasteboard invokes the owner there). The
    /// per-file fetch is a bounded, sanitized temp-file stage in the sidecar, so
    /// blocking here for the duration of a paste keeps memory bounded and cannot
    /// deadlock: the fetch drives the tokio runtime's worker threads, never the
    /// main thread.
    fn provide(&self, pboard: &NSPasteboard) {
        let ivars = self.ivars();
        let mut staged: Vec<Retained<NSString>> = Vec::new();
        for &index in &ivars.indices {
            match tauri::async_runtime::block_on(
                ivars
                    .manager
                    .fetch_remote_clipboard_file(&ivars.session_id, index),
            ) {
                Ok(path) => staged.push(NSString::from_str(&path.to_string_lossy())),
                Err(e) => {
                    tracing::warn!(
                        "failed to fetch remote clipboard file {index} for paste: {e}"
                    );
                }
            }
        }
        if staged.is_empty() {
            return;
        }
        let array = NSArray::from_retained_slice(&staged);
        let plist: &AnyObject = &array;
        // SAFETY: `NSFilenamesPboardType` is an AppKit static; the property list is
        // an `NSArray<NSString>` of paths, the shape that type requires.
        #[allow(deprecated)]
        let file_type = unsafe { NSFilenamesPboardType };
        unsafe {
            pboard.setPropertyList_forType(plist, file_type);
        }
    }
}

thread_local! {
    /// The pasteboard owner for the most recent bind. AppKit keeps the owner
    /// unretained, so we must hold it ourselves; a new bind replaces (drops) the
    /// previous one, since it is no longer the pasteboard's owner. Main-thread
    /// only — `Retained` is neither `Send` nor `Sync`, and every access runs on
    /// the main thread.
    static CURRENT_OWNER: RefCell<Option<Retained<RemoteClipboardProvider>>> =
        const { RefCell::new(None) };
}

/// Bind the remote-copied clipboard `files` onto the general OS pasteboard with
/// delayed rendering (#1804), so they can be pasted into any local app. The bytes
/// are fetched only on the actual paste, via `manager` and `session_id`.
///
/// Dispatches the pasteboard mutation to the main thread (AppKit requires it) and
/// keeps the owner alive for as long as it is the current pasteboard owner.
pub fn bind_remote_clipboard_files(
    app_handle: &AppHandle,
    manager: GraphicalSessionManager,
    session_id: String,
    files: Vec<RemoteClipboardFile>,
) -> anyhow::Result<()> {
    let indices = pasteable_indices(&files);
    if indices.is_empty() {
        return Ok(());
    }

    app_handle
        .run_on_main_thread(move || {
            let provider = RemoteClipboardProvider::new(manager, session_id, indices);
            let pboard = NSPasteboard::generalPasteboard();
            #[allow(deprecated)]
            let file_type = unsafe { NSFilenamesPboardType };
            let types = NSArray::from_slice(&[file_type]);
            let owner: &AnyObject = &provider;
            // SAFETY: declaring a promised type with `self` as the (unretained)
            // owner. `clearContents` first drops any prior contents so a stale
            // promise can never be served.
            unsafe {
                pboard.clearContents();
                pboard.declareTypes_owner(&types, Some(owner));
            }
            // Retain the owner (unretained by AppKit) until the next bind replaces
            // it; the replaced one is no longer the pasteboard owner, so dropping
            // it here is safe.
            CURRENT_OWNER.with(|slot| {
                *slot.borrow_mut() = Some(provider);
            });
        })
        .map_err(|e| anyhow::anyhow!("failed to bind clipboard on the main thread: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(index: u32, is_dir: bool) -> RemoteClipboardFile {
        RemoteClipboardFile {
            name: format!("f{index}"),
            relative_path: None,
            size: Some(1),
            is_dir,
            index,
        }
    }

    #[test]
    fn pasteable_indices_keep_files_in_order_and_drop_dirs() {
        let files = vec![file(0, false), file(1, true), file(2, false)];
        assert_eq!(pasteable_indices(&files), vec![0, 2]);
    }

    #[test]
    fn pasteable_indices_empty_when_only_dirs_or_none() {
        assert!(pasteable_indices(&[]).is_empty());
        assert!(pasteable_indices(&[file(0, true), file(1, true)]).is_empty());
    }
}
