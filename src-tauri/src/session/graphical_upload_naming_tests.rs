//! Keep-both naming never overwrites (#4299, audit ERR2-001).
//!
//! Only a definite "not found" makes a name free. Any other stat failure (a
//! permission error, a timeout, a dropped transport) skips the item with the
//! real reason and never claims or writes the file. Where the file host can,
//! the chosen name is claimed with an exclusive create, so a file that appears
//! between the check and the create is never truncated either.

use std::collections::HashMap;
use std::sync::Mutex;

use super::*;

// ── Scripted destination ────────────────────────────────────────────

/// A file host whose probe and claim answers are scripted per path. A path
/// with no scripted probe is missing; a path with no scripted claim is
/// claimed. Every call is logged as `probe:<path>`, `claim:<path>` or
/// `mkdir:<path>`.
#[derive(Default)]
struct ScriptedDest {
    probes: HashMap<String, Result<Option<bool>, String>>,
    claims: HashMap<String, Result<Claim, String>>,
    log: Mutex<Vec<String>>,
}

impl ScriptedDest {
    fn probe(mut self, path: &str, answer: Result<Option<bool>, String>) -> Self {
        self.probes.insert(path.to_string(), answer);
        self
    }

    fn claim(mut self, path: &str, answer: Result<Claim, String>) -> Self {
        self.claims.insert(path.to_string(), answer);
        self
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn claimed(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|c| c.strip_prefix("claim:").map(str::to_string))
            .collect()
    }
}

#[async_trait::async_trait]
impl UploadDestination for ScriptedDest {
    async fn home(&self) -> Result<String, String> {
        Ok("/home/pi".to_string())
    }

    async fn probe(&self, path: &str) -> Result<Option<bool>, String> {
        self.log.lock().unwrap().push(format!("probe:{path}"));
        self.probes.get(path).cloned().unwrap_or(Ok(None))
    }

    async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("mkdir:{path}"));
        Ok(())
    }

    async fn claim_new_file(&self, path: &str) -> Result<Claim, String> {
        self.log.lock().unwrap().push(format!("claim:{path}"));
        self.claims.get(path).cloned().unwrap_or(Ok(Claim::Claimed))
    }
}

fn one_file(name: &str) -> LocalPlan {
    LocalPlan {
        items: vec![LocalItem::File {
            local: PathBuf::from(format!("/local/{name}")),
            name: name.to_string(),
        }],
        skipped: Vec::new(),
    }
}

fn remotes(placement: &Placement) -> Vec<&str> {
    placement.files.iter().map(|f| f.remote.as_str()).collect()
}

// ── Probe outcomes ──────────────────────────────────────────────────

#[tokio::test]
async fn a_permission_error_on_the_name_skips_the_item_and_never_claims_it() {
    let dest = ScriptedDest::default().probe("/d/a.txt", Err("permission denied".to_string()));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert!(placement.files.is_empty(), "{:?}", placement.files);
    assert_eq!(placement.skipped.len(), 1);
    assert!(
        placement.skipped[0].reason.contains("permission denied"),
        "{:?}",
        placement.skipped
    );
    assert!(dest.claimed().is_empty(), "{:?}", dest.calls());
}

#[tokio::test]
async fn a_timeout_on_a_numbered_candidate_stops_the_search() {
    let dest = ScriptedDest::default()
        .probe("/d/a.txt", Ok(Some(false)))
        .probe("/d/a (1).txt", Err("agent request timed out".to_string()));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert!(placement.files.is_empty());
    assert!(placement.skipped[0].reason.contains("timed out"));
    assert!(dest.claimed().is_empty(), "{:?}", dest.calls());
    assert!(
        !dest.calls().iter().any(|c| c.contains("a (2).txt")),
        "the search must stop at the failed probe: {:?}",
        dest.calls()
    );
}

#[tokio::test]
async fn a_failed_probe_of_a_dropped_folder_name_creates_nothing() {
    let dest = ScriptedDest::default().probe("/d/pics", Err("connection lost".to_string()));
    let plan = LocalPlan {
        items: vec![LocalItem::Folder {
            name: "pics".to_string(),
            dirs: Vec::new(),
            files: vec![(vec!["x.png".to_string()], PathBuf::from("/local/x.png"))],
        }],
        skipped: Vec::new(),
    };

    let placement = place(&dest, "/d", plan).await;

    assert!(placement.files.is_empty());
    assert_eq!(placement.folders, 0);
    assert!(placement.skipped[0].reason.contains("connection lost"));
    assert!(!dest.calls().iter().any(|c| c.starts_with("mkdir:")));
}

#[tokio::test]
async fn not_found_picks_the_name_and_claims_it_exclusively() {
    let dest = ScriptedDest::default();

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert_eq!(remotes(&placement), vec!["/d/a.txt"]);
    assert_eq!(dest.claimed(), vec!["/d/a.txt"]);
}

#[tokio::test]
async fn an_existing_file_gets_a_suffixed_name_and_is_never_claimed() {
    let dest = ScriptedDest::default().probe("/d/a.txt", Ok(Some(false)));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert_eq!(remotes(&placement), vec!["/d/a (1).txt"]);
    assert_eq!(dest.claimed(), vec!["/d/a (1).txt"]);
}

// ── Exclusive claim ─────────────────────────────────────────────────

#[tokio::test]
async fn a_file_created_after_the_probe_moves_on_to_the_next_name() {
    // The probe saw no file, but one appeared before the exclusive create.
    let dest = ScriptedDest::default().claim("/d/a.txt", Ok(Claim::Exists));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert_eq!(remotes(&placement), vec!["/d/a (1).txt"]);
    assert_eq!(dest.claimed(), vec!["/d/a.txt", "/d/a (1).txt"]);
}

#[tokio::test]
async fn a_claim_failure_that_is_not_a_clash_skips_the_item() {
    let dest = ScriptedDest::default().claim("/d/a.txt", Err("disk quota exceeded".to_string()));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert!(placement.files.is_empty());
    assert!(placement.skipped[0].reason.contains("disk quota exceeded"));
}

#[tokio::test]
async fn a_host_without_exclusive_create_keeps_the_probed_name() {
    let dest = ScriptedDest::default().claim("/d/a.txt", Ok(Claim::Unsupported));

    let placement = place(&dest, "/d", one_file("a.txt")).await;

    assert_eq!(remotes(&placement), vec!["/d/a.txt"]);
}

#[tokio::test]
async fn a_refused_exclusive_create_is_a_clash_only_when_the_file_now_exists() {
    // SFTP v3 answers a refused O_EXCL create with a generic failure, so the
    // name is re-probed: a file there now is a clash, none is a real error.
    let exists = ScriptedDest::default().probe("/d/a.txt", Ok(Some(false)));
    assert_eq!(
        settle_exclusive_create(&exists, "/d/a.txt", Err("failure".to_string())).await,
        Ok(Claim::Exists)
    );

    let missing = ScriptedDest::default();
    let err = settle_exclusive_create(&missing, "/d/a.txt", Err("no space".to_string()))
        .await
        .unwrap_err();
    assert!(err.contains("no space"), "{err}");

    let unknown = ScriptedDest::default().probe("/d/a.txt", Err("timed out".to_string()));
    let err = settle_exclusive_create(&unknown, "/d/a.txt", Err("failure".to_string()))
        .await
        .unwrap_err();
    assert!(err.contains("timed out"), "{err}");

    assert_eq!(
        settle_exclusive_create(&missing, "/d/a.txt", Ok(())).await,
        Ok(Claim::Claimed)
    );
}

// ── Destination folder ──────────────────────────────────────────────

#[tokio::test]
async fn resolve_dest_dir_reports_the_real_probe_error() {
    let dest = ScriptedDest::default().probe("/d", Err("agent request timed out".to_string()));

    let err = resolve_dest_dir(&dest, Some("/d"), "/x").await.unwrap_err();

    assert!(err.contains("timed out"), "{err}");
    assert!(!err.contains("does not exist"), "{err}");
}

// ── Agent route ─────────────────────────────────────────────────────

/// An agent whose `connection.files.stat` answers are scripted per path; a
/// path with no answer is the agent's `FILE_NOT_FOUND`. Every method called
/// is logged.
#[derive(Default)]
struct StatAgent {
    stat_errors: HashMap<String, String>,
    existing: Vec<String>,
    methods: Mutex<Vec<String>>,
}

impl AgentRequests for StatAgent {
    fn request(&self, _agent_id: &str, method: &str, params: Value) -> Result<Value, FileError> {
        self.methods.lock().unwrap().push(method.to_string());
        let path = params["path"].as_str().unwrap_or_default().to_string();
        if method != CONNECTION_FILES_STAT {
            return Ok(serde_json::json!({}));
        }
        if let Some(e) = self.stat_errors.get(&path) {
            return Err(FileError::OperationFailed(e.clone()));
        }
        if self.existing.contains(&path) {
            return Ok(serde_json::to_value(FileEntry {
                name: crate::utils::fs::file_name_of(&path),
                path,
                ..FileEntry::default()
            })
            .unwrap());
        }
        Err(FileError::NotFound(path))
    }
}

fn agent_files(agent: StatAgent) -> (Arc<StatAgent>, AgentHostFiles) {
    let agent = Arc::new(agent);
    let requests: Arc<dyn AgentRequests> = agent.clone();
    (agent, AgentHostFiles::new("agent-1".to_string(), requests))
}

#[tokio::test]
async fn agent_probe_treats_only_file_not_found_as_free() {
    let (_, files) = agent_files(StatAgent {
        stat_errors: [("/d/locked.txt".to_string(), "permission denied".to_string())].into(),
        existing: vec!["/d/there.txt".to_string()],
        ..StatAgent::default()
    });

    assert_eq!(files.probe("/d/missing.txt").await, Ok(None));
    assert_eq!(files.probe("/d/there.txt").await, Ok(Some(false)));
    let err = files.probe("/d/locked.txt").await.unwrap_err();
    assert!(err.contains("permission denied"), "{err}");
}

#[tokio::test]
async fn agent_upload_never_writes_over_a_name_whose_stat_failed() {
    let (agent, files) = agent_files(StatAgent {
        stat_errors: [(
            "/d/notes.md".to_string(),
            "agent request timed out".to_string(),
        )]
        .into(),
        ..StatAgent::default()
    });

    let placement = place(&files, "/d", one_file("notes.md")).await;

    assert!(placement.files.is_empty(), "{:?}", placement.files);
    assert!(placement.skipped[0].reason.contains("timed out"));
    let methods = agent.methods.lock().unwrap().clone();
    assert!(
        methods.iter().all(|m| m == CONNECTION_FILES_STAT),
        "nothing but stat may reach the agent: {methods:?}"
    );
}

#[tokio::test]
async fn the_agent_host_has_no_exclusive_create() {
    let (agent, files) = agent_files(StatAgent::default());

    assert_eq!(
        files.claim_new_file("/d/a.txt").await,
        Ok(Claim::Unsupported)
    );
    assert!(agent.methods.lock().unwrap().is_empty());
}
