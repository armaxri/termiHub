//! `agent.logs.list` / `agent.logs.read` (#4519): the desktop pulls this
//! agent's own log files into its diagnostics bundle. Covers the init gate,
//! listing (family only, capped), reading (redacted, tail-capped), and names
//! that must be refused.

use super::*;
use std::fs;
use termihub_core::diagnostics::remote_log::{
    MAX_REMOTE_LOGS, MAX_REMOTE_LOG_BYTES, TAIL_CUT_MARKER,
};
use termihub_core::protocol::methods::{LogFileSummary, LogsListResult, LogsReadResult};

fn handler_with_dir(dir: &Path) -> AgentHandler {
    make_handler().with_log_dir(dir.to_path_buf())
}

async fn list(handler: &AgentHandler) -> Value {
    dispatch(handler, pm::AGENT_LOGS_LIST, json!({}), 2).await
}

async fn read(handler: &AgentHandler, name: &str) -> Value {
    dispatch(handler, pm::AGENT_LOGS_READ, json!({ "name": name }), 3).await
}

#[tokio::test]
async fn log_methods_require_initialize() {
    let tmp = tempfile::tempdir().unwrap();
    let handler = handler_with_dir(tmp.path());
    let r = list(&handler).await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
    let r = read(&handler, "termihub-agent-stdio-1.log").await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
}

#[tokio::test]
async fn lists_only_the_agent_log_family() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("termihub-agent-stdio-1.log"), "abc").unwrap();
    fs::write(tmp.path().join("termihub.log"), "desktop log").unwrap();
    fs::write(tmp.path().join("notes.txt"), "x").unwrap();
    fs::create_dir(tmp.path().join("crash-reports")).unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = list(&handler).await;
    let parsed: LogsListResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!(
        parsed.logs,
        vec![LogFileSummary {
            name: "termihub-agent-stdio-1.log".into(),
            size: 3
        }]
    );
}

#[tokio::test]
async fn a_missing_log_dir_lists_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let handler = handler_with_dir(&tmp.path().join("never-created"));
    init_handler(&handler).await;
    let r = list(&handler).await;
    assert_eq!(r["result"]["logs"], json!([]), "{r}");
}

#[tokio::test]
async fn listing_is_capped() {
    let tmp = tempfile::tempdir().unwrap();
    for n in 0..(MAX_REMOTE_LOGS + 5) {
        fs::write(
            tmp.path().join(format!("termihub-agent-stdio-{n}.log")),
            "x",
        )
        .unwrap();
    }
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;
    let r = list(&handler).await;
    assert_eq!(
        r["result"]["logs"].as_array().unwrap().len(),
        MAX_REMOTE_LOGS
    );
}

#[tokio::test]
async fn reads_a_listed_log_redacted() {
    let tmp = tempfile::tempdir().unwrap();
    let name = "termihub-agent-stdio-1.log";
    fs::write(
        tmp.path().join(name),
        "INFO connecting password=hunter2 token=abc\nINFO done\n",
    )
    .unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = read(&handler, name).await;
    let parsed: LogsReadResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!(parsed.name, name);
    assert!(!parsed.truncated);
    assert!(parsed.text.contains("INFO done"), "{}", parsed.text);
    assert!(!parsed.text.contains("hunter2"), "{}", parsed.text);
}

#[tokio::test]
async fn an_oversized_log_returns_its_newest_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let name = "termihub-agent-daemon-7.1.log";
    let line = "INFO steady state line\n";
    let mut big = line.repeat(MAX_REMOTE_LOG_BYTES as usize / line.len() + 100);
    big.push_str("INFO the very last line\n");
    fs::write(tmp.path().join(name), big).unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = read(&handler, name).await;
    assert_eq!(r["result"]["truncated"], true, "{r}");
    let text = r["result"]["text"].as_str().unwrap();
    let body = text.strip_prefix(TAIL_CUT_MARKER).expect("cut marker");
    assert!(body.len() as u64 <= MAX_REMOTE_LOG_BYTES);
    assert!(body.starts_with("INFO "), "whole lines only");
    assert!(body.ends_with("INFO the very last line\n"));
}

#[tokio::test]
async fn refuses_names_that_are_not_plain_listed_logs() {
    let tmp = tempfile::tempdir().unwrap();
    let inner = tmp.path().join("logs");
    fs::create_dir_all(&inner).unwrap();
    fs::write(inner.join("termihub-agent-stdio-1.log"), "ok").unwrap();
    fs::write(tmp.path().join("termihub-agent-secret.log"), "outside").unwrap();
    fs::write(inner.join("termihub.log"), "desktop").unwrap();
    let handler = handler_with_dir(&inner);
    init_handler(&handler).await;

    for bad in [
        "../termihub-agent-secret.log",
        "termihub-agent-../termihub-agent-secret.log",
        "termihub-agent-a/b.log",
        "termihub-agent-a\\b.log",
        "termihub.log",
        "/etc/passwd",
        "crash-20260101T000000Z-1.txt",
        "",
    ] {
        let r = read(&handler, bad).await;
        assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{bad:?}: {r}");
    }
    // Well-formed but absent.
    let r = read(&handler, "termihub-agent-stdio-999.log").await;
    assert_eq!(r["error"]["code"], errors::FILE_NOT_FOUND, "{r}");
    // Missing params entirely.
    let r = dispatch(&handler, pm::AGENT_LOGS_READ, json!({}), 4).await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");
}
