//! `agent.crash_reports.list` / `agent.crash_reports.read` (#3574): the desktop
//! pulls this agent's own crash reports into its diagnostics bundle. Covers the
//! init gate, listing (newest first, capped), reading, the size cap, and names
//! that must be refused.

use super::*;
use std::fs;
use termihub_core::diagnostics::crash_report::{MAX_REMOTE_REPORTS, MAX_REMOTE_REPORT_BYTES};

fn report_name(n: u32) -> String {
    format!("crash-2026010{}T000000Z-{n}.txt", n % 10)
}

fn handler_with_dir(dir: &Path) -> AgentHandler {
    make_handler().with_crash_dir(dir.to_path_buf())
}

async fn list(handler: &AgentHandler) -> Value {
    dispatch(handler, pm::AGENT_CRASH_REPORTS_LIST, json!({}), 2).await
}

async fn read(handler: &AgentHandler, name: &str) -> Value {
    dispatch(
        handler,
        pm::AGENT_CRASH_REPORTS_READ,
        json!({ "name": name }),
        3,
    )
    .await
}

#[tokio::test]
async fn crash_report_methods_require_initialize() {
    let tmp = tempfile::tempdir().unwrap();
    let handler = handler_with_dir(tmp.path());
    let r = list(&handler).await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
    let r = read(&handler, "crash-20260101T000000Z-1.txt").await;
    assert_eq!(r["error"]["code"], errors::NOT_INITIALIZED, "{r}");
}

#[tokio::test]
async fn lists_reports_newest_first_and_skips_other_files() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("crash-20260101T000000Z-1.txt"), "old").unwrap();
    fs::write(tmp.path().join("crash-20260102T000000Z-2.txt"), "newer!").unwrap();
    fs::write(tmp.path().join("notes.txt"), "not a report").unwrap();
    fs::write(tmp.path().join(".notified"), "x").unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = list(&handler).await;
    let parsed: CrashReportsListResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!(
        parsed.reports,
        vec![
            CrashReportSummary {
                name: "crash-20260102T000000Z-2.txt".into(),
                size: 6
            },
            CrashReportSummary {
                name: "crash-20260101T000000Z-1.txt".into(),
                size: 3
            },
        ]
    );
}

#[tokio::test]
async fn a_missing_crash_dir_lists_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let handler = handler_with_dir(&tmp.path().join("never-created"));
    init_handler(&handler).await;
    let r = list(&handler).await;
    assert_eq!(r["result"]["reports"], json!([]), "{r}");
}

#[tokio::test]
async fn listing_is_capped() {
    let tmp = tempfile::tempdir().unwrap();
    for n in 0..(MAX_REMOTE_REPORTS as u32 + 5) {
        fs::write(tmp.path().join(format!("crash-{n:04}.txt")), "x").unwrap();
    }
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;
    let r = list(&handler).await;
    let reports = r["result"]["reports"].as_array().unwrap();
    assert_eq!(reports.len(), MAX_REMOTE_REPORTS);
    // The oldest ones beyond the cap are not readable either.
    let r = read(&handler, "crash-0000.txt").await;
    assert_eq!(r["error"]["code"], errors::FILE_NOT_FOUND, "{r}");
}

#[tokio::test]
async fn reads_a_listed_report() {
    let tmp = tempfile::tempdir().unwrap();
    let name = report_name(1);
    fs::write(tmp.path().join(&name), "termiHub crash report\nboom").unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = read(&handler, &name).await;
    let parsed: CrashReportsReadResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!(parsed.name, name);
    assert_eq!(parsed.text, "termiHub crash report\nboom");
    assert!(!parsed.truncated);
}

#[tokio::test]
async fn an_oversized_report_is_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let name = report_name(1);
    let big = "a".repeat(MAX_REMOTE_REPORT_BYTES as usize + 4096);
    fs::write(tmp.path().join(&name), big).unwrap();
    let handler = handler_with_dir(tmp.path());
    init_handler(&handler).await;

    let r = read(&handler, &name).await;
    assert_eq!(r["result"]["truncated"], true, "truncated flag");
    assert_eq!(
        r["result"]["text"].as_str().unwrap().len() as u64,
        MAX_REMOTE_REPORT_BYTES
    );
}

#[tokio::test]
async fn refuses_names_that_are_not_plain_listed_reports() {
    let tmp = tempfile::tempdir().unwrap();
    let inner = tmp.path().join("crash-reports");
    fs::create_dir_all(&inner).unwrap();
    fs::write(inner.join(report_name(1)), "ok").unwrap();
    fs::write(tmp.path().join("crash-secret.txt"), "outside").unwrap();
    fs::write(inner.join("notes.txt"), "private").unwrap();
    let handler = handler_with_dir(&inner);
    init_handler(&handler).await;

    for bad in [
        "../crash-secret.txt",
        "crash-../crash-secret.txt",
        "crash-a/b.txt",
        "crash-a\\b.txt",
        "notes.txt",
        "/etc/passwd",
        "",
    ] {
        let r = read(&handler, bad).await;
        assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{bad:?}: {r}");
    }
    // Well-formed but absent.
    let r = read(&handler, "crash-20990101T000000Z-9.txt").await;
    assert_eq!(r["error"]["code"], errors::FILE_NOT_FOUND, "{r}");
    // Missing params entirely.
    let r = dispatch(&handler, pm::AGENT_CRASH_REPORTS_READ, json!({}), 4).await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");
}
