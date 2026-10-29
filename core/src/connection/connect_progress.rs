//! Connect-stage progress reporting (#5068).
//!
//! A backend's `connect()` reports which stage it has reached (resolve →
//! connect → host key → authenticate → shell/session) through
//! [`report`]. The caller decides where reports go by running the connect
//! inside [`with_reporter`], which scopes a [`ConnectProgressReporter`] to the
//! task, the same task-local pattern as the SSH prompt owner. Outside such a
//! scope (agent-side connects, tests, the connection probe) [`report`] is a
//! no-op, so the mechanism is purely additive: the [`ConnectionType`] trait is
//! unchanged.
//!
//! Work that leaves the task (a `spawn_blocking` connect) captures the
//! reporter first with [`current`] and calls [`ConnectProgressReporter::report`]
//! on it directly.
//!
//! [`ConnectionType`]: super::ConnectionType

use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// One stage of establishing a connection, in the order a backend passes
/// through them. Not every backend uses every stage: telnet goes
/// `Resolve → Connect → Session`, serial `OpenPort → Session`, SSH
/// `Resolve → Connect → HostKey → Authenticate → Shell`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum ConnectStage {
    /// Resolving the host name.
    Resolve,
    /// Opening the TCP connection (directly, through a proxy, or a jump host).
    Connect,
    /// SSH handshake and host-key verification.
    HostKey,
    /// Authenticating (keys, password, keyboard-interactive).
    Authenticate,
    /// Opening the remote shell channel (SSH).
    Shell,
    /// Opening a serial port.
    OpenPort,
    /// Starting the terminal session on an established transport.
    Session,
}

/// A connect-progress update: the stage reached plus an optional one-line
/// status (e.g. `"Trying public key ~/.ssh/id_ed25519"`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ConnectProgressUpdate {
    /// The stage the connect has reached.
    pub stage: ConnectStage,
    /// Human-readable status line; `None` when the stage says it all.
    pub status: Option<String>,
}

/// The sink a connect's progress updates are delivered to.
#[derive(Clone)]
pub struct ConnectProgressReporter(Arc<dyn Fn(ConnectProgressUpdate) + Send + Sync>);

impl ConnectProgressReporter {
    /// Wrap a callback as a reporter.
    pub fn new(f: impl Fn(ConnectProgressUpdate) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    /// Deliver one update.
    pub fn report(&self, stage: ConnectStage, status: Option<String>) {
        (self.0)(ConnectProgressUpdate { stage, status });
    }
}

impl fmt::Debug for ConnectProgressReporter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ConnectProgressReporter")
    }
}

tokio::task_local! {
    static REPORTER: ConnectProgressReporter;
}

/// Run `fut` with `reporter` receiving every [`report`] made on its task.
pub async fn with_reporter<F: std::future::Future>(
    reporter: ConnectProgressReporter,
    fut: F,
) -> F::Output {
    REPORTER.scope(reporter, fut).await
}

/// The reporter scoped around the current task, if any — capture it before
/// moving work onto another thread.
pub fn current() -> Option<ConnectProgressReporter> {
    REPORTER.try_with(Clone::clone).ok()
}

/// Report that the connect on this task reached `stage`. A no-op when no
/// reporter is scoped.
pub fn report(stage: ConnectStage, status: Option<String>) {
    let _ = REPORTER.try_with(|r| r.report(stage, status));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collecting() -> (
        ConnectProgressReporter,
        Arc<Mutex<Vec<ConnectProgressUpdate>>>,
    ) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let reporter = ConnectProgressReporter::new(move |u| sink.lock().unwrap().push(u));
        (reporter, seen)
    }

    #[tokio::test]
    async fn reports_reach_the_scoped_reporter_in_order() {
        let (reporter, seen) = collecting();
        with_reporter(reporter, async {
            report(ConnectStage::Resolve, None);
            report(
                ConnectStage::Connect,
                Some("TCP connect to 10.0.0.1:23".into()),
            );
        })
        .await;
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter().map(|u| u.stage).collect::<Vec<_>>(),
            vec![ConnectStage::Resolve, ConnectStage::Connect]
        );
        assert_eq!(
            seen[1].status.as_deref(),
            Some("TCP connect to 10.0.0.1:23")
        );
    }

    #[tokio::test]
    async fn report_without_a_scope_is_a_no_op() {
        report(ConnectStage::Session, None);
        assert!(current().is_none());
    }

    #[tokio::test]
    async fn a_captured_reporter_works_off_task() {
        let (reporter, seen) = collecting();
        with_reporter(reporter, async {
            let captured = current().expect("scoped");
            tokio::task::spawn_blocking(move || captured.report(ConnectStage::OpenPort, None))
                .await
                .unwrap();
        })
        .await;
        assert_eq!(seen.lock().unwrap()[0].stage, ConnectStage::OpenPort);
    }

    #[test]
    fn stages_serialize_camel_case() {
        assert_eq!(
            serde_json::to_string(&ConnectStage::HostKey).unwrap(),
            "\"hostKey\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectStage::OpenPort).unwrap(),
            "\"openPort\""
        );
    }
}
