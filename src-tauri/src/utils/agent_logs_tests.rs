use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;

use serde_json::Value;
use termihub_core::diagnostics::redact::{RedactionContext, Redactor};

use super::*;
use crate::utils::diagnostics_bundle::write_bundle;

/// How a mock agent answers.
#[derive(Clone)]
enum MockAgent {
    /// Current agent: serves these log files (name → text).
    Current(Vec<(String, String)>),
    /// Predates `agent.logs.*` ("method not found").
    Old,
    /// Every call fails.
    Broken,
    /// Lists this raw JSON and serves `text` for every read.
    Raw { list: Value, text: String },
}

struct MockSource {
    agents: HashMap<String, MockAgent>,
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
                AGENT_LOGS_LIST => Ok(list.clone()),
                _ => Ok(json!({ "name": params["name"], "text": text })),
            },
            MockAgent::Current(logs) => match method {
                AGENT_LOGS_LIST => Ok(json!({
                    "logs": logs
                        .iter()
                        .map(|(n, t)| json!({ "name": n, "size": t.len() }))
                        .collect::<Vec<_>>()
                })),
                AGENT_LOGS_READ => {
                    let name = params["name"].as_str().unwrap_or_default();
                    logs.iter()
                        .find(|(n, _)| n == name)
                        .map(|(n, t)| json!({ "name": n, "text": t, "truncated": false }))
                        .ok_or_else(|| AgentCallError::Failed("no such log".into()))
                }
                _ => Err(AgentCallError::Unsupported),
            },
        }
    }
}

const L1: &str = "termihub-agent-stdio-4242.log";
const L2: &str = "termihub-agent-registry-17.1.log";
const SKIPPED: &str = "agents/skipped-logs.txt";

fn pick(agent: &str, name: &str) -> AgentLogRef {
    AgentLogRef {
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
fn lists_logs_of_connected_agents_and_degrades_for_old_ones() {
    let source = MockSource::new(&[
        (
            "agent-a",
            MockAgent::Current(vec![(L1.into(), "one".into()), (L2.into(), "two".into())]),
        ),
        ("agent-old", MockAgent::Old),
        ("agent-broken", MockAgent::Broken),
    ]);
    let listing = list_connected_agent_logs(&source);
    assert_eq!(listing.len(), 3);

    let a = &listing[0];
    assert!(a.supported);
    assert_eq!(a.error, None);
    assert_eq!(
        a.logs.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
        [L1, L2]
    );

    let old = &listing[1];
    assert!(!old.supported, "an old agent is skipped, not an error");
    assert!(old.logs.is_empty());
    assert_eq!(old.error, None);

    assert_eq!(listing[2].error.as_deref(), Some("timed out"));
}

#[test]
fn only_connected_agents_are_contacted() {
    let mut source = MockSource::new(&[
        ("agent-a", MockAgent::Current(vec![(L1.into(), "x".into())])),
        (
            "agent-gone",
            MockAgent::Current(vec![(L1.into(), "x".into())]),
        ),
    ]);
    source.connected = vec!["agent-a".into()];

    assert_eq!(list_connected_agent_logs(&source).len(), 1);
    let entries = fetch_agent_log_entries(&source, &[pick("agent-a", L1), pick("agent-gone", L1)]);

    assert!(source
        .calls
        .borrow()
        .iter()
        .all(|(agent, _)| agent == "agent-a"));
    assert_eq!(
        names(&entries),
        ["agents/agent-a/logs/termihub-agent-stdio-4242.log", SKIPPED]
    );
    assert!(text_of(&entries, SKIPPED).contains("agent is not connected"));
}

#[test]
fn listing_drops_unsafe_names_and_caps_the_count() {
    let mut logs: Vec<Value> = (0..MAX_REMOTE_LOGS + 5)
        .map(|n| json!({ "name": format!("termihub-agent-stdio-{n}.log"), "size": 1 }))
        .collect();
    for bad in [
        "../../etc/passwd",
        "termihub-agent-../x.log",
        "termihub.log",
        "crash-20260101T000000Z-1.txt",
    ] {
        logs.insert(0, json!({ "name": bad, "size": 1 }));
    }
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Raw {
            list: json!({ "logs": logs }),
            text: String::new(),
        },
    )]);
    let listing = list_connected_agent_logs(&source);
    assert_eq!(listing[0].logs.len(), MAX_REMOTE_LOGS);
    assert!(listing[0].logs.iter().all(|l| is_agent_log_name(&l.name)));
}

#[test]
fn a_malformed_listing_is_empty_not_an_error() {
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Raw {
            list: json!({ "logs": "nope" }),
            text: String::new(),
        },
    )]);
    let listing = list_connected_agent_logs(&source);
    assert!(listing[0].supported);
    assert!(listing[0].logs.is_empty());
}

#[test]
fn fetch_refuses_unsafe_names_without_calling_the_agent() {
    let source = MockSource::new(&[("agent-a", MockAgent::Current(vec![]))]);
    let entries = fetch_agent_log_entries(
        &source,
        &[
            pick("agent-a", "../../etc/passwd"),
            pick("agent-a", "termihub-agent-a/b.log"),
            pick("agent-a", "termihub.log"),
        ],
    );
    assert!(source.calls.borrow().is_empty());
    assert_eq!(names(&entries), [SKIPPED]);
}

#[test]
fn an_old_agent_is_skipped_with_a_note() {
    let source = MockSource::new(&[("agent-old", MockAgent::Old)]);
    let entries = fetch_agent_log_entries(&source, &[pick("agent-old", L1)]);
    assert_eq!(names(&entries), [SKIPPED]);
    assert!(text_of(&entries, SKIPPED).contains("cannot share its log files"));
}

#[test]
fn an_oversized_reply_keeps_its_newest_lines_on_the_desktop_too() {
    let line = "INFO line\n";
    let mut text = line.repeat(MAX_REMOTE_LOG_BYTES as usize / line.len() * 3);
    text.push_str("INFO newest\n");
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Raw {
            list: json!({ "logs": [] }),
            text,
        },
    )]);
    let entries = fetch_agent_log_entries(&source, &[pick("agent-a", L1)]);
    let text = text_of(
        &entries,
        "agents/agent-a/logs/termihub-agent-stdio-4242.log",
    );
    let body = text.strip_prefix(TAIL_CUT_MARKER).expect("cut marker");
    assert!(body.len() as u64 <= MAX_REMOTE_LOG_BYTES);
    assert!(body.starts_with("INFO line\n"));
    assert!(body.ends_with("INFO newest\n"));
}

#[test]
fn the_total_size_is_capped() {
    let big = "a".repeat(MAX_REMOTE_LOG_BYTES as usize);
    let logs: Vec<(String, String)> = (0..30)
        .map(|n| (format!("termihub-agent-stdio-{n}.log"), big.clone()))
        .collect();
    let source = MockSource::new(&[("agent-a", MockAgent::Current(logs.clone()))]);
    let selection: Vec<AgentLogRef> = logs.iter().map(|(n, _)| pick("agent-a", n)).collect();

    let entries = fetch_agent_log_entries(&source, &selection);
    let total: u64 = entries
        .iter()
        .filter(|e| e.info.name != SKIPPED)
        .map(|e| e.info.size)
        .sum();
    assert!(total <= MAX_TOTAL_AGENT_LOG_BYTES);
    assert!(text_of(&entries, SKIPPED).contains("total size limit"));
}

#[test]
fn duplicate_selections_are_fetched_once() {
    let source = MockSource::new(&[("agent-a", MockAgent::Current(vec![(L1.into(), "x".into())]))]);
    let entries = fetch_agent_log_entries(&source, &[pick("agent-a", L1), pick("agent-a", L1)]);
    assert_eq!(entries.len(), 1);
    assert_eq!(source.calls.borrow().len(), 1);
}

#[test]
fn hostile_agent_ids_stay_one_path_segment() {
    let source = MockSource::new(&[(
        "../../evil",
        MockAgent::Current(vec![(L1.into(), "x".into())]),
    )]);
    let entries = fetch_agent_log_entries(&source, &[pick("../../evil", L1)]);
    assert_eq!(
        names(&entries),
        ["agents/______evil/logs/termihub-agent-stdio-4242.log"]
    );
}

#[test]
fn remote_logs_are_re_redacted_in_the_written_bundle() {
    // The agent "forgot" to redact: the desktop pass must still mask it.
    let leaky = "INFO open /Users/alice/x token=s3cr3tvalue1234 on alice-mbp\n";
    let source = MockSource::new(&[(
        "agent-a",
        MockAgent::Current(vec![(L1.into(), leaky.into())]),
    )]);
    let entries = fetch_agent_log_entries(&source, &[pick("agent-a", L1)]);

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
        .by_name("agents/agent-a/logs/termihub-agent-stdio-4242.log")
        .unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert!(text.contains("INFO open"));
    for secret in ["s3cr3tvalue1234", "alice-mbp", "/Users/alice"] {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
}
