use tauri::State;
use tracing::Level;

use crate::utils::file_log::{self, FileLogReload};
use crate::utils::log_capture::{LogEntry, SharedLogBuffer};

/// Return the most recent log entries from the ring buffer.
#[tauri::command]
pub fn get_logs(count: usize, buffer: State<'_, SharedLogBuffer>) -> Vec<LogEntry> {
    let buf = buffer.lock().unwrap();
    buf.get_recent(count)
}

/// Clear all buffered log entries.
#[tauri::command]
pub fn clear_logs(buffer: State<'_, SharedLogBuffer>) {
    let mut buf = buffer.lock().unwrap();
    buf.clear();
}

/// Set the durable log file's verbosity live (OBS-009).
///
/// `level` is one of [`file_log::SELECTABLE_FILE_LOG_LEVELS`]. The change is
/// applied immediately via the file-filter reload handle (no restart), and
/// `russh` stays clamped at every level so packet-level SSH internals never
/// reach the user-shared file. **Persistence is the frontend's job** — it also
/// writes `fileLogLevel` into the settings document so the level is re-applied
/// on the next launch (and honored even if the log file could not be opened this
/// run, in which case `reload` is a no-op here).
///
/// The `TERMIHUB_FILE_LOG` env var overrides the level at *startup* only; a live
/// change made here takes effect for the current run regardless.
#[tauri::command]
pub fn set_file_log_level(level: String, reload: State<'_, FileLogReload>) -> Result<(), String> {
    let filter = file_log::env_filter_for_level(&level)
        .ok_or_else(|| format!("unknown log level: {level}"))?;
    if let Some(handle) = &reload.0 {
        handle
            .reload(filter)
            .map_err(|e| format!("failed to apply log level: {e}"))?;
    }
    Ok(())
}

/// Return the absolute path of the current application log file, if resolvable.
///
/// Surfaced in the Settings log-level control so a user or supporter can find
/// the file to read or attach to a bug report (OBS-011).
#[tauri::command]
pub fn get_log_file_path() -> Option<String> {
    file_log::log_file_path().map(|p| p.display().to_string())
}

/// Tracing target under which frontend-forwarded log lines are emitted.
///
/// A `tracing` event's target must be a compile-time constant, so the frontend
/// sub-target (`terminal`, `store`, …) cannot be the event target itself — it is
/// folded into the message instead (see [`compose_frontend_message`]). This
/// constant target matches the `frontend` directive in both the ring-buffer and
/// file filters, so the entries reach the durable `termihub.log`.
const FRONTEND_LOG_TARGET: &str = "frontend";

/// Map a frontend level string onto a tracing [`Level`].
///
/// Case-insensitive; unknown levels return `None` so the caller can decide how to
/// treat them (they are logged at WARN rather than dropped).
fn frontend_level(level: &str) -> Option<Level> {
    match level.trim().to_ascii_uppercase().as_str() {
        "ERROR" => Some(Level::ERROR),
        "WARN" => Some(Level::WARN),
        "INFO" => Some(Level::INFO),
        "DEBUG" => Some(Level::DEBUG),
        "TRACE" => Some(Level::TRACE),
        _ => None,
    }
}

/// Fold the frontend sub-target into the message so the origin survives even
/// though the tracing event target is the constant [`FRONTEND_LOG_TARGET`].
fn compose_frontend_message(target: &str, message: &str) -> String {
    let target = target.trim();
    if target.is_empty() {
        message.to_string()
    } else {
        format!("[{target}] {message}")
    }
}

/// Ingest a frontend log line into the Rust `tracing` pipeline (OBS-001).
///
/// `frontendLog`'s ERROR/WARN entries call this (best-effort) so they land in the
/// durable file log — the file a user is asked to paste into a bug report —
/// instead of dying in the in-memory LogViewer with the window. Emitted under the
/// `frontend` target and tagged frontend-origin via the composed message.
#[tauri::command]
pub fn record_frontend_log(level: String, target: String, message: String) {
    let composed = compose_frontend_message(&target, &message);
    match frontend_level(&level) {
        Some(Level::ERROR) => tracing::error!(target: FRONTEND_LOG_TARGET, "{composed}"),
        Some(Level::WARN) => tracing::warn!(target: FRONTEND_LOG_TARGET, "{composed}"),
        Some(Level::INFO) => tracing::info!(target: FRONTEND_LOG_TARGET, "{composed}"),
        Some(Level::DEBUG) => tracing::debug!(target: FRONTEND_LOG_TARGET, "{composed}"),
        Some(Level::TRACE) => tracing::trace!(target: FRONTEND_LOG_TARGET, "{composed}"),
        // Unknown level: keep the entry rather than dropping it, at WARN so it is
        // visible without being alarming.
        None => tracing::warn!(target: FRONTEND_LOG_TARGET, "{composed}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::log_capture::{create_log_buffer, LogCaptureLayer};
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn maps_known_levels_case_insensitively() {
        assert_eq!(frontend_level("ERROR"), Some(Level::ERROR));
        assert_eq!(frontend_level("error"), Some(Level::ERROR));
        assert_eq!(frontend_level(" Warn "), Some(Level::WARN));
        assert_eq!(frontend_level("info"), Some(Level::INFO));
        assert_eq!(frontend_level("DEBUG"), Some(Level::DEBUG));
        assert_eq!(frontend_level("trace"), Some(Level::TRACE));
    }

    #[test]
    fn maps_unknown_level_to_none() {
        assert_eq!(frontend_level("verbose"), None);
        assert_eq!(frontend_level(""), None);
    }

    #[test]
    fn composes_message_with_and_without_target() {
        assert_eq!(
            compose_frontend_message("terminal", "boom"),
            "[terminal] boom"
        );
        assert_eq!(compose_frontend_message("  ", "boom"), "boom");
    }

    #[test]
    fn every_selectable_level_resolves_for_set_file_log_level() {
        // The command accepts exactly SELECTABLE_FILE_LOG_LEVELS; each must
        // resolve to a filter, and anything else must be rejected.
        for level in file_log::SELECTABLE_FILE_LOG_LEVELS {
            assert!(
                file_log::env_filter_for_level(level).is_some(),
                "level {level} must resolve for the command"
            );
        }
        assert!(file_log::env_filter_for_level("bogus").is_none());
    }

    #[test]
    fn get_log_file_path_points_at_termihub_log() {
        // On test hosts a platform log dir resolves; the command surfaces it
        // verbatim so the UI/docs can show where the file lives (OBS-011).
        if let Some(path) = get_log_file_path() {
            assert!(
                path.ends_with("termihub.log"),
                "unexpected log path: {path}"
            );
        }
    }

    #[test]
    fn record_frontend_log_reaches_the_ring_buffer_under_the_frontend_target() {
        let buffer = create_log_buffer();
        let layer = LogCaptureLayer::new(buffer.clone());
        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            record_frontend_log("ERROR".into(), "store".into(), "save failed".into());
        });

        let entries = buffer.lock().unwrap().get_recent(10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].level, "ERROR");
        assert_eq!(entries[0].target, FRONTEND_LOG_TARGET);
        assert_eq!(entries[0].message, "[store] save failed");
    }
}
