//! Watch open local editor files for external on-disk changes (#1620).
//!
//! When a local file is open in the built-in editor and another process
//! rewrites it on disk, the editor should be able to reflect the new content.
//! This module owns the OS-level file watchers (FSEvents / inotify /
//! ReadDirectoryChangesW via the `notify` crate) and emits a `local-file-changed`
//! event to the frontend, which decides whether to reload (only remote/SFTP
//! files are excluded — those never reach this module).
//!
//! Design notes:
//! - **Watch the parent directory, not the file.** Many tools save via
//!   write-to-temp-then-rename, which swaps in a fresh inode; a watch on the
//!   original file would go deaf after the first such write. Watching the parent
//!   directory (non-recursively) and filtering events to the target name catches
//!   both in-place writes and atomic-rename replacements.
//! - **Debounced.** A single logical save can fire several filesystem events;
//!   the debouncer coalesces them so the editor is not reload-stormed.
//! - **One watcher per editor instance**, keyed by an opaque `watch_id` supplied
//!   by the frontend. Re-watching the same id replaces the previous watcher, and
//!   dropping it stops the underlying OS watch — so a closed tab leaks nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Emitter};
use tracing::{debug, warn};

use crate::utils::errors::TerminalError;

/// How long to wait for filesystem events to settle before notifying the
/// frontend. A single external save often emits several syscalls; coalescing
/// them here avoids reloading the editor multiple times for one logical change.
const DEBOUNCE_TIMEOUT: Duration = Duration::from_millis(300);

/// Emitted to the frontend when a watched local file changes on disk. The
/// `watch_id` routes the event back to the exact editor instance that
/// registered the watch.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangedPayload {
    watch_id: String,
    path: String,
}

type FileDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Tracks one active watcher per `watch_id` (an opaque per-editor-instance key).
#[derive(Default)]
pub struct FileWatchManager {
    watchers: Mutex<HashMap<String, FileDebouncer>>,
}

impl FileWatchManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or replace) a watch on `path` for `watch_id`. On any change to the
    /// file, a `local-file-changed` event carrying `watch_id` and `path` is
    /// emitted to the frontend.
    pub fn watch(
        &self,
        app: AppHandle,
        watch_id: String,
        path: String,
    ) -> Result<(), TerminalError> {
        let target = PathBuf::from(&path);
        // Watch the containing directory so atomic rename-replace writes (which
        // swap the inode) are still observed; events are filtered to the target
        // file name in the callback below.
        let watch_dir = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        let target_for_cb = target.clone();
        let watch_id_cb = watch_id.clone();
        let emit_path = path.clone();

        let mut debouncer = new_debouncer(
            DEBOUNCE_TIMEOUT,
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    let touched = events
                        .iter()
                        .flat_map(|ev| ev.paths.iter())
                        .any(|p| paths_match(p, &target_for_cb));
                    if touched {
                        // The path is echoed back so the frontend can confirm it
                        // matches the tab; contents are never read or logged here.
                        let _ = app.emit(
                            "local-file-changed",
                            FileChangedPayload {
                                watch_id: watch_id_cb.clone(),
                                path: emit_path.clone(),
                            },
                        );
                    }
                }
                Err(errors) => {
                    for e in errors {
                        warn!("local file watch error: {e}");
                    }
                }
            },
        )
        .map_err(|e| TerminalError::EditorError(format!("failed to create file watcher: {e}")))?;

        debouncer
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .map_err(|e| {
                TerminalError::EditorError(format!("failed to watch {}: {e}", watch_dir.display()))
            })?;

        // Inserting over an existing id drops the previous debouncer, which stops
        // its OS watch and background thread.
        let mut guard = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(watch_id.clone(), debouncer);
        debug!(watch_id, "watching local file for external changes");
        Ok(())
    }

    /// Stop watching for `watch_id`. Unknown ids are a harmless no-op.
    pub fn unwatch(&self, watch_id: &str) {
        let mut guard = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if guard.remove(watch_id).is_some() {
            debug!(watch_id, "stopped watching local file");
        }
    }
}

/// Whether a filesystem event path refers to the watched target file. Because
/// the watch is scoped to the target's own directory (non-recursive), a matching
/// final path component uniquely identifies the file and also matches the
/// rename-destination event of an atomic replace.
fn paths_match(event_path: &Path, target: &Path) -> bool {
    match (event_path.file_name(), target.file_name()) {
        (Some(a), Some(b)) => a == b,
        _ => event_path == target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_same_file_name_in_dir() {
        assert!(paths_match(
            Path::new("/home/u/notes.txt"),
            Path::new("/home/u/notes.txt")
        ));
    }

    #[test]
    fn ignores_staged_temp_file_of_atomic_replace() {
        // Atomic replace stages a differently-named temp file, then renames it
        // onto the target. The temp write must not be mistaken for the target;
        // only the rename-to-target event (matched above) counts.
        assert!(!paths_match(
            Path::new("/home/u/.notes.txt.tmp1234"),
            Path::new("/home/u/notes.txt")
        ));
    }

    #[test]
    fn ignores_other_files_in_dir() {
        assert!(!paths_match(
            Path::new("/home/u/other.txt"),
            Path::new("/home/u/notes.txt")
        ));
    }

    #[test]
    fn ignores_the_directory_itself() {
        assert!(!paths_match(
            Path::new("/home/u"),
            Path::new("/home/u/notes.txt")
        ));
    }
}
