//! Files-only sessions (#4078): an SSH host that refuses the shell but serves
//! SFTP keeps its session up for the Files sidebar and editor.
//!
//! The backend detects the refusal itself and reports it through
//! [`ConnectionType::files_only_watch`](termihub_core::connection::ConnectionType::files_only_watch).
//! This watcher forwards that verdict to the tab's `session-lifecycle` entry, so
//! the frontend renders the "no shell" info panel from backend state instead of
//! guessing from terminal output.

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::info;

use super::{EventEmitter, SessionManager};

impl SessionManager {
    /// Wait for the session's backend to report files-only, then fold it onto
    /// the tab's lifecycle entry. Ends without folding when the session closes
    /// first (`cancel`, the session's reader-cancel token) or its backend is
    /// dropped (the watch sender goes with it).
    pub(super) async fn run_files_only_watch<E: EventEmitter>(
        mut files_only: watch::Receiver<bool>,
        session_id: String,
        tab_id: String,
        emitter: E,
        cancel: CancellationToken,
    ) {
        tokio::select! {
            // A close wins over a verdict that raced it.
            biased;
            _ = cancel.cancelled() => {}
            settled = files_only.wait_for(|files_only| *files_only) => {
                if settled.is_ok() {
                    info!(
                        session_id,
                        tab_id,
                        "host refused the shell; session kept files-only"
                    );
                    emitter.fold_files_only(&tab_id);
                }
            }
        }
    }
}
