//! Forwards a direct connect's stage updates to the frontend as
//! `connect-progress` events (#5068).
//!
//! [`SessionManager::create_connection`](super::manager::SessionManager::create_connection)
//! runs the backend connect inside [`with_connect_progress`], which scopes a
//! core [`ConnectProgressReporter`] that turns every report into a
//! [`ConnectProgressEvent`] keyed by the caller's `connect_id`. The frontend
//! maps it to the tab's connect overlay stepper.

use serde::Serialize;
use termihub_core::connection::connect_progress::{
    with_reporter, ConnectProgressReporter, ConnectStage,
};

/// Payload of the `connect-progress` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ConnectProgressEvent {
    /// The connect attempt the update belongs to (`${tabId}:${retryCount}`).
    pub connect_id: String,
    /// The stage reached.
    #[cfg_attr(test, ts(type = "import(\"./ConnectStage\").ConnectStage"))]
    pub stage: ConnectStage,
    /// One-line status, when the backend has one.
    pub status: Option<String>,
}

/// Run `fut` with its connect-stage reports delivered to `emit` as
/// [`ConnectProgressEvent`]s for `connect_id`. Without a `connect_id` nothing
/// can be correlated, so `fut` runs unscoped.
pub async fn with_connect_progress<F, E>(connect_id: Option<&str>, emit: E, fut: F) -> F::Output
where
    F: std::future::Future,
    E: Fn(&ConnectProgressEvent) + Send + Sync + 'static,
{
    let Some(connect_id) = connect_id else {
        return fut.await;
    };
    let connect_id = connect_id.to_string();
    let reporter = ConnectProgressReporter::new(move |update| {
        emit(&ConnectProgressEvent {
            connect_id: connect_id.clone(),
            stage: update.stage,
            status: update.status,
        });
    });
    with_reporter(reporter, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use termihub_core::connection::connect_progress::report;

    #[tokio::test]
    async fn reports_become_events_keyed_by_connect_id() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        with_connect_progress(
            Some("tab-1:0"),
            move |e: &ConnectProgressEvent| sink.lock().unwrap().push(e.clone()),
            async { report(ConnectStage::Resolve, Some("Resolving h".into())) },
        )
        .await;
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].connect_id, "tab-1:0");
        assert_eq!(seen[0].stage, ConnectStage::Resolve);
        let json = serde_json::to_value(&seen[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "connectId": "tab-1:0", "stage": "resolve", "status": "Resolving h" })
        );
    }

    #[tokio::test]
    async fn without_a_connect_id_nothing_is_emitted() {
        let seen = Arc::new(Mutex::new(0));
        let sink = seen.clone();
        with_connect_progress(
            None,
            move |_: &ConnectProgressEvent| *sink.lock().unwrap() += 1,
            async { report(ConnectStage::Connect, None) },
        )
        .await;
        assert_eq!(*seen.lock().unwrap(), 0);
    }
}
