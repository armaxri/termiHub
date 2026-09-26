use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;

use termihub_core::diagnostics::redact::{RedactionContext, Redactor};

use super::*;
use crate::utils::diagnostics_bundle::write_bundle;

/// How a mock agent answers.
#[derive(Clone)]
enum MockAgent {
    /// Current agent: serves these reports (name → text).
    Current(Vec<(String, String)>),
    /// Predates `agent.crash_reports.*` ("method not found").
    Old,
    /// Every call fails.
    Broken,
    /// Lists this raw JSON and serves `text` for every read.
    Raw { list: Value, text: String },
}

struct MockSource {
    agents: HashMap<String, MockAgent>,
    /// Ids reported as connected (a subset of / different from `agents`).
    connected: Vec<String>,
    calls: RefCell<Vec<(String, String)>>,
}

impl MockSource {
    fn new(agents: &[(&str, MockAgent)]) -> Self {
        Self {
            agents: agents
                .iter()
                .map(|(id, a)| (id.to_string(), a.clone()))
                .collect(),
            connected: agents.iter().map(|(id, _)| id.to_string()).collect(),
            calls: RefCell::new(Vec::new()),
        }
    }
}

impl AgentReportSource for MockSource {
    fn connected_agents(&self) -> Vec<String> {
        self.connected.clone()
    }

    fn call(&self, agent_id: &str, method: &str, params: Value) -> Result<Value, AgentCallError> {
        self.calls
            .borrow_mut()
            .push((agent_id.to_string(), method.to_string()));
        let agent = self
            .agents
            .get(agent_id)
            .ok_or_else(|| AgentCallError::Failed("not connected".into()))?;
        match agent {
            MockAgent::Old => Err(AgentCallError::Unsupported),
            MockAgent::Broken => Err(AgentCallError::Failed("timed out".into())),
            MockAgent::Raw { list, text } => match method {
                AGENT_CRASH_REPORTS_LIST => Ok(list.clone()),
                _ => Ok(json!({ "name": params["name"], "text": text })),
            },
            MockAgent::Current(reports) => match method {
                AGENT_CRASH_REPORTS_LIST => Ok(json!({
                    "reports": reports
                        .iter()
                        .map(|(n, t)| json!({ "name": n, "size": t.len() }))
                        .collect::<Vec<_>>()
                })),
                AGENT_CRASH_REPORTS_READ => {
                    let name = params["name"].as_str().unwrap_or_default();
                    reports
                        .iter()
                        .find(|(n, _)| n == name)
                        .map(|(n, t)| json!({ "name": n, "text": t, "truncated": false }))
                        .ok_or_else(|| AgentCallError::Failed("no such report".into()))
                }
                _ => Err(AgentCallError::Unsupported),
            },
        }
    }
}

const R1: &str = "crash-20260101T000000Z-1.txt";
const R2: &str = "crash-20260102T000000Z-2.txt";

fn pick(agent: &str, name: &str) -> AgentCrashReportRef {
    AgentCrashReportRef {
        agent_id: agent.into(),
        name: name.into(),
    }
}

fn names(entries: &[BundleEntry]) -> Vec<String> {
    entries.iter().map(|e| e.info.name.clone()).collect()
}

fn text_of<'a>(entries: &'a [BundleEntry], name: &str) -> &'a str {
    match &entries.iter().find(|e| e.info.name == name).unwrap().source {
        BundleSource::Text(t) => t,
        BundleSource::File(_) => panic!("expected text"),
    }
}

#[test]
fn lists_reports_of_connected_agents_and_degrades_for_old_ones() {
    let source = MockSource::new(&[
        (
            "agent-a",
            MockAgent::Current(vec![(R2.into(), "two".into()), (R1.into(), "one".into())]),
        ),
        ("agent-old", MockAgent::Old),
        ("agent-broken", MockAgent::Broken),
    ]);
    let listing = list_connected_agent_reports(&source);
    assert_eq!(listing.len(), 3);

    let a = &listing[0];
    assert!(a.supported);
    assert_eq!(a.error, None);
    assert_eq!(
        a.reports
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        [R2, R1]
    );

    let old = &listing[1];
    assert!(!old.supported, "an old agent is skipped, not an error");
    assert!(old.reports.is_empty());
    assert_eq!(old.error, None);

    let broken = &listing[2];
    assert_eq!(broken.error.as_deref(), Some("timed out"));
}

#[test]
fn only_connected_agents_are_contacted() {
    let mut source = MockSource::new(&[
        ("agent-a", MockAgent::Current(vec![(R1.into(), "x".into())])),
        (
            "agent-gone",
            MockAgent::Current(vec![(R1.into(), "x".into())]),
        ),
    ]);
    source.connected = vec!["agent-a".into()];

    let listing = list_connected_agent_reports(&source);
    assert_eq!(listing.len(), 1);
    let entries =
        fetch_agent_report_entries(&source, &[pick("agent-a", R1), pick("agent-gone", R1)]);

    assert!(source
        .calls
        .borrow()
        .iter()
        .all(|(agent, _)| agent == "agent-a"));
    assert_eq!(
        names(&entries),
        [
            "agents/agent-a/crash-reports/crash-20260101T000000Z-1.txt",
            "agents/skipped.txt"
        ]
    );
    assert!(text_of(&entries, "agents/skipped.txt").contains("agent is not connected"));
}

#[test]
fn listing_drops_unsafe_names_and_caps_the_count() {
    let mut reports: Vec<Value> = (0..MAX_REMOTE_REPORTS + 5)
        .map(|n| json!({ "name": format!("crash-{n:04}.txt"), "size": 1 }))
        .collect();
    reports.insert(0, json!({ "name": "../../etc/passwd", "size": 1 }));
    reports.insert(0, json!({ "name": "crash-../x.txt", "size": 1 }));
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Raw {
            list: json!({ "reports": reports }),
            text: String::new(),
        },
    )]);
    let listing = list_connected_agent_reports(&source);
    assert_eq!(listing[0].reports.len(), MAX_REMOTE_REPORTS);
    assert!(listing[0]
        .reports
        .iter()
        .all(|r| crash_report::is_plain_report_name(&r.name)));
}

#[test]
fn fetch_refuses_unsafe_names_without_calling_the_agent() {
    let source = MockSource::new(&[("agent-a", MockAgent::Current(vec![]))]);
    let entries = fetch_agent_report_entries(
        &source,
        &[
            pick("agent-a", "../../etc/passwd"),
            pick("agent-a", "crash-a/b.txt"),
        ],
    );
    assert!(source.calls.borrow().is_empty());
    assert_eq!(names(&entries), ["agents/skipped.txt"]);
}

#[test]
fn an_old_agent_is_skipped_with_a_note() {
    let source = MockSource::new(&[("agent-old", MockAgent::Old)]);
    let entries = fetch_agent_report_entries(&source, &[pick("agent-old", R1)]);
    assert_eq!(names(&entries), ["agents/skipped.txt"]);
    assert!(text_of(&entries, "agents/skipped.txt").contains("cannot share crash reports"));
}

#[test]
fn an_oversized_reply_is_capped_on_the_desktop_too() {
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Raw {
            list: json!({ "reports": [] }),
            text: "a".repeat(MAX_REMOTE_REPORT_BYTES as usize * 3),
        },
    )]);
    let entries = fetch_agent_report_entries(&source, &[pick("agent-a", R1)]);
    let text = text_of(
        &entries,
        "agents/agent-a/crash-reports/crash-20260101T000000Z-1.txt",
    );
    assert!(text.len() as u64 <= MAX_REMOTE_REPORT_BYTES + 64);
    assert!(text.contains("truncated by the size cap"));
}

#[test]
fn the_total_size_is_capped() {
    let big = "a".repeat(MAX_REMOTE_REPORT_BYTES as usize);
    let agents: Vec<(String, MockAgent)> = (0..20)
        .map(|n| {
            (
                format!("agent-{n:02}"),
                MockAgent::Current(vec![(R1.into(), big.clone())]),
            )
        })
        .collect();
    let refs: Vec<(&str, MockAgent)> = agents
        .iter()
        .map(|(i, a)| (i.as_str(), a.clone()))
        .collect();
    let source = MockSource::new(&refs);
    let selection: Vec<AgentCrashReportRef> = agents.iter().map(|(id, _)| pick(id, R1)).collect();

    let entries = fetch_agent_report_entries(&source, &selection);
    let total: u64 = entries
        .iter()
        .filter(|e| e.info.name != "agents/skipped.txt")
        .map(|e| e.info.size)
        .sum();
    assert!(total <= MAX_TOTAL_AGENT_REPORT_BYTES);
    assert!(text_of(&entries, "agents/skipped.txt").contains("total size limit"));
}

#[test]
fn duplicate_selections_are_fetched_once() {
    let source = MockSource::new(&[("agent-a", MockAgent::Current(vec![(R1.into(), "x".into())]))]);
    let entries = fetch_agent_report_entries(&source, &[pick("agent-a", R1), pick("agent-a", R1)]);
    assert_eq!(entries.len(), 1);
    assert_eq!(source.calls.borrow().len(), 1);
}

#[test]
fn agent_ids_become_one_safe_path_segment() {
    assert_eq!(agent_folder("agent-1"), "agents/agent-1");
    assert_eq!(agent_folder("../../evil"), "agents/______evil");
    assert_eq!(agent_folder("a/b\\c"), "agents/a_b_c");
    assert_eq!(agent_folder(""), "agents/agent");
    assert_eq!(agent_folder(&"x".repeat(500)).len(), "agents/".len() + 64);
}

#[test]
fn remote_reports_are_re_redacted_in_the_written_bundle() {
    // The agent "forgot" to redact: the desktop pass must still mask it.
    let leaky = "panic at /Users/alice/src/x.rs token=s3cr3tvalue1234 on alice-mbp";
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Current(vec![(R1.into(), leaky.into())]),
    )]);
    let entries = fetch_agent_report_entries(&source, &[pick("agent-a", R1)]);

    let redactor = Redactor::new(RedactionContext {
        home_dirs: vec!["/Users/alice".into()],
        usernames: vec!["alice".into()],
        hostnames: vec!["alice-mbp".into()],
    });
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("diag.zip");
    assert_eq!(write_bundle(&dest, &entries, &redactor).unwrap(), 1);

    let mut archive = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
    let mut file = archive
        .by_name("agents/agent-a/crash-reports/crash-20260101T000000Z-1.txt")
        .unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert!(text.contains("panic at"));
    for secret in ["s3cr3tvalue1234", "alice-mbp", "/Users/alice"] {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
}
