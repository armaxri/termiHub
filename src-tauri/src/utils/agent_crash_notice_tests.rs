use std::cell::RefCell;

use serde_json::json;

use super::*;

const R1: &str = "crash-20260101T000000Z-1.txt";
const R2: &str = "crash-20260102T000000Z-2.txt";
const R3: &str = "crash-20260103T000000Z-3.txt";

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn listing(list: &[&str]) -> Result<Value, AgentCallError> {
    Ok(json!({
        "reports": list.iter().map(|n| json!({ "name": n, "size": 10 })).collect::<Vec<_>>()
    }))
}

fn seen(name: Option<&str>) -> SeenAgent {
    SeenAgent {
        newest_seen: name.map(str::to_string),
    }
}

// ── decide ──────────────────────────────────────────────────────────

#[test]
fn first_check_takes_existing_reports_as_the_baseline() {
    assert_eq!(
        decide(None, &names(&[R1, R2])),
        Decision::Baseline {
            newest: Some(R2.into())
        }
    );
    assert_eq!(decide(None, &[]), Decision::Baseline { newest: None });
}

#[test]
fn reports_newer_than_the_last_seen_one_are_new() {
    assert_eq!(
        decide(Some(&seen(Some(R1))), &names(&[R3, R2, R1])),
        Decision::Notify {
            newest: R3.into(),
            new_count: 2
        }
    );
}

#[test]
fn nothing_new_when_every_report_was_seen() {
    assert_eq!(
        decide(Some(&seen(Some(R2))), &names(&[R2, R1])),
        Decision::NothingNew
    );
    assert_eq!(decide(Some(&seen(Some(R2))), &[]), Decision::NothingNew);
}

#[test]
fn an_agent_checked_with_no_reports_notifies_on_its_first_crash() {
    assert_eq!(
        decide(Some(&seen(None)), &names(&[R1])),
        Decision::Notify {
            newest: R1.into(),
            new_count: 1
        }
    );
}

// ── service ─────────────────────────────────────────────────────────

#[test]
fn first_connect_does_not_notify_then_a_later_crash_does_once() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());

    // First-ever connect with old reports: no spam.
    assert!(!service.observe("a", listing(&[R1])));
    assert!(service.pending().is_empty());

    // Reconnect after a crash: one notice.
    assert!(service.observe("a", listing(&[R2, R1])));
    assert_eq!(
        service.pending(),
        [AgentCrashNotice {
            agent_id: "a".into(),
            name: R2.into(),
            new_count: 1
        }]
    );
    // A further reconnect before the user acted changes nothing.
    assert!(!service.observe("a", listing(&[R2, R1])));

    // Acknowledged → never repeated for the same report.
    assert!(service.acknowledge("a", R2));
    assert!(service.pending().is_empty());
    assert!(!service.observe("a", listing(&[R2, R1])));
    assert!(service.pending().is_empty());
}

#[test]
fn seen_state_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let service = AgentCrashNoticeService::new(dir.path());
        service.observe("a", listing(&[R1]));
        service.observe("a", listing(&[R2, R1]));
        service.acknowledge("a", R2);
    }
    let raw = fs::read_to_string(dir.path().join(SEEN_STORE_FILE)).unwrap();
    let file: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(file["version"], "1");
    assert_eq!(file["agents"]["a"]["newestSeen"], R2);

    let service = AgentCrashNoticeService::new(dir.path());
    assert!(!service.observe("a", listing(&[R2, R1])));
    assert!(service.observe("a", listing(&[R3, R2, R1])));
    assert_eq!(service.pending()[0].name, R3);
}

#[test]
fn an_unacknowledged_notice_is_not_lost_by_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let service = AgentCrashNoticeService::new(dir.path());
        service.observe("a", listing(&[]));
        assert!(service.observe("a", listing(&[R1])));
    }
    let service = AgentCrashNoticeService::new(dir.path());
    assert!(service.observe("a", listing(&[R1])));
    assert_eq!(service.pending()[0].name, R1);
}

#[test]
fn old_or_failing_agents_are_skipped_without_touching_state() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    assert!(!service.observe("old", Err(AgentCallError::Unsupported)));
    assert!(!service.observe("x", Err(AgentCallError::Failed("timed out".into()))));
    assert!(!dir.path().join(SEEN_STORE_FILE).exists());

    // A failed check is not a baseline: the next successful one is.
    assert!(!service.observe("x", listing(&[R1])));
    assert!(service.pending().is_empty());
}

#[test]
fn untrusted_names_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    service.observe("a", listing(&[]));
    assert!(!service.observe("a", listing(&["../../etc/passwd", "notes.txt"])));
    assert!(!service.observe("a", Ok(json!({ "reports": "garbage" }))));
    assert!(service.pending().is_empty());
    assert!(!service.acknowledge("a", "../x"));
}

#[test]
fn acknowledging_an_older_report_keeps_a_newer_notice() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    service.observe("a", listing(&[]));
    service.observe("a", listing(&[R3, R1]));
    assert!(!service.acknowledge("a", R1));
    assert_eq!(service.pending()[0].name, R3);
}

#[test]
fn a_newer_store_file_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SEEN_STORE_FILE);
    let newer = r#"{"version":"99","agents":{}}"#;
    fs::write(&path, newer).unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    service.observe("a", listing(&[R1]));
    service.acknowledge("a", R1);
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
}

#[test]
fn a_corrupt_store_file_re_baselines() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(SEEN_STORE_FILE), "{not json").unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    assert!(!service.observe("a", listing(&[R1])));
    assert!(service.observe("a", listing(&[R2, R1])));
}

// ── check_agent: exactly one call over the existing connection ──────

struct CountingSource {
    reply: Result<Value, AgentCallError>,
    calls: RefCell<Vec<(String, String)>>,
}

impl AgentReportSource for CountingSource {
    fn connected_agents(&self) -> Vec<String> {
        vec!["a".into()]
    }

    fn call(&self, agent_id: &str, method: &str, _params: Value) -> Result<Value, AgentCallError> {
        self.calls
            .borrow_mut()
            .push((agent_id.to_string(), method.to_string()));
        self.reply.clone()
    }
}

#[test]
fn a_check_is_exactly_one_list_call() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    let source = CountingSource {
        reply: listing(&[R1]),
        calls: RefCell::new(Vec::new()),
    };
    check_agent(&source, &service, "a");
    assert_eq!(
        *source.calls.borrow(),
        [("a".to_string(), AGENT_CRASH_REPORTS_LIST.to_string())]
    );
}

#[test]
fn an_old_agent_check_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let service = AgentCrashNoticeService::new(dir.path());
    let source = CountingSource {
        reply: Err(AgentCallError::Unsupported),
        calls: RefCell::new(Vec::new()),
    };
    assert!(!check_agent(&source, &service, "a"));
    assert!(service.pending().is_empty());
}
