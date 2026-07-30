//! Tauri command surface for the startup session-restore decision logic (#2200).
//!
//! Wires the previously-dormant `termihub_core::restore_mode` port (#2145) into
//! the frontend restore path. Each command is a thin, **stateless** wrapper over
//! one of the core's pure decision functions; the frontend's
//! `src/utils/restoreMode.ts` now delegates its logic here so there is a single
//! source of truth (the Rust port), proven equivalent to the retired TypeScript
//! logic by the #2145 golden vectors (`core/tests/restore_mode_golden.rs`).
//!
//! ## The async-probe seam
//!
//! [`restore_summarize_last_session`] does the **pure** work: it flattens a
//! stored session into per-tab descriptors, each carrying the connection
//! `target` its reachability check would probe. It never performs the probe.
//! The asynchronous reachability probe stays entirely client-side
//! (`src/utils/restoreReachability.ts` + `probeRestorePromptReachability`),
//! consuming the `target`s this command produced and patching `reachability`
//! onto the prompt afterwards. That decoupling — pure decision here, async I/O
//! probe on the client — is why the lift is partial rather than whole.

use std::collections::HashSet;

use termihub_core::restore_mode::{
    filter_session_by_selection, resolve_restore_mode, summarize_last_session, AppSettings,
    LastSession, RestoreLastSessionMode, RestorePrompt, SavedConnection,
};

/// Resolve the effective restore mode from settings, migrating the legacy
/// `restoreLastSessionOnStartup` boolean when the explicit mode is unset.
#[tauri::command]
pub fn restore_resolve_mode(settings: AppSettings) -> RestoreLastSessionMode {
    resolve_restore_mode(&settings)
}

/// Flatten a stored last session into the per-tab restore-dialog summary. Each
/// tab carries the `target` the client-side reachability probe then consumes.
#[tauri::command]
pub fn restore_summarize_last_session(
    session: LastSession,
    connections: Vec<SavedConnection>,
) -> RestorePrompt {
    summarize_last_session(&session, &connections)
}

/// Prune a stored last session down to the flat tab indices the user selected
/// (same order [`restore_summarize_last_session`] produced).
#[tauri::command]
pub fn restore_filter_session_by_selection(
    session: LastSession,
    selected: Vec<i64>,
) -> LastSession {
    let selected: HashSet<i64> = selected.into_iter().collect();
    filter_session_by_selection(&session, &selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These assert the command wrappers pass their arguments straight through to
    // the core functions unchanged; the behaviour of the functions themselves is
    // proven equivalent to the retired TS logic by `restore_mode_golden.rs`.

    #[test]
    fn resolve_mode_delegates_to_core() {
        let settings: AppSettings =
            serde_json::from_value(json!({ "restoreLastSessionMode": "always" })).unwrap();
        assert_eq!(
            restore_resolve_mode(settings.clone()),
            resolve_restore_mode(&settings)
        );
    }

    #[test]
    fn summarize_delegates_to_core() {
        let session: LastSession = serde_json::from_value(json!({
            "version": "1",
            "activeGroupIndex": 0,
            "tabGroups": [{
                "name": "g",
                "layout": { "type": "leaf", "tabs": [
                    { "title": "shell", "inlineConfig": { "type": "local", "config": {} } }
                ] }
            }]
        }))
        .unwrap();
        assert_eq!(
            restore_summarize_last_session(session.clone(), Vec::new()),
            summarize_last_session(&session, &[])
        );
    }

    #[test]
    fn filter_collects_selection_into_set() {
        let session: LastSession = serde_json::from_value(json!({
            "version": "1",
            "activeGroupIndex": 0,
            "tabGroups": [{
                "name": "g",
                "layout": { "type": "leaf", "tabs": [
                    { "title": "a", "inlineConfig": { "type": "local", "config": {} } },
                    { "title": "b", "inlineConfig": { "type": "local", "config": {} } }
                ] }
            }]
        }))
        .unwrap();
        let expected = filter_session_by_selection(&session, &HashSet::from([0]));
        assert_eq!(
            restore_filter_session_by_selection(session, vec![0]),
            expected
        );
    }
}
