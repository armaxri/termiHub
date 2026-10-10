//! Uploads to a graphical session's file side channel (#3770 phase 2, #4192).
//!
//! `remote_desktop_upload` turns dropped (or picked) local files and folders
//! into ordinary rows of the Transfers queue, keyed by the **graphical** session
//! id, over the carrier phase 1 resolved (#4191):
//!
//! - the **SSH route** — an SFTP subsystem channel opened on the VNC tunnel's
//!   own authenticated SSH session, driven by the shared SFTP executor
//!   ([`run_sftp_transfer`](termihub_core::files::transfer::sftp::run_sftp_transfer));
//! - the **agent route** — the hosting agent's host-level `connection.files.*`
//!   service (no `connectionId`), driven by the shared ranged executor
//!   ([`run_ranged_transfer`](termihub_core::files::transfer::ranged::run_ranged_transfer))
//!   one `write_range` slice at a time.
//!
//! Either way the bytes stream in the queue's chunk size with progress, pause,
//! cancel and retry. The rules the concept sets are enforced here, not only in
//! the UI: a name clash keeps both (`name (1).ext`, never an overwrite),
//! folders upload recursively, and symbolic links are never followed (a
//! dropped link, or one inside a dropped folder, is skipped and reported).
//!
//! "Never an overwrite" holds when the file host misbehaves too (#4299): only
//! a definite "not found" makes a name free — any other stat failure skips the
//! item with the real reason — and where the host can, the chosen name is
//! claimed with an exclusive create before the upload starts, so the upload
//! only ever writes a file it created itself.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::errors::FileError;
use termihub_core::files::transfer::ranged::RangedTransferTarget;
use termihub_core::files::transfer::registry::TransferRegistry;
use termihub_core::files::transfer::{ProgressSink, TransferDirection};
use termihub_core::files::{FileAttributeOps, FileBrowser, FileEntry, RangedFileAccess};
use termihub_core::protocol::methods::{
    FilesDeleteParams, FilesMkdirParams, FilesReadRangeParams, FilesReadRangeResult,
    FilesStatParams, FilesWriteRangeParams, CONNECTION_FILES_DELETE, CONNECTION_FILES_MKDIR,
    CONNECTION_FILES_READ_RANGE, CONNECTION_FILES_STAT, CONNECTION_FILES_WRITE_RANGE,
};

use crate::files::transfer::persist::PersistedGraphicalTarget;
use crate::files::transfer::TransferPersistenceManager;
use crate::terminal::agent_manager::AgentRpcClient;

/// How many numbered names (`name (1)` … `name (N)`) a clash may try before
/// the upload gives up on that item.
const MAX_KEEP_BOTH: u32 = 999;

// ── Keep-both naming ────────────────────────────────────────────────

/// The `n`-th "keep both" variant of `name`: `notes.md` → `notes (1).md`.
///
/// The number goes before the last extension; a dot-file (`.bashrc`) or a name
/// without an extension gets the suffix at the end. `n == 0` is `name` itself.
pub(crate) fn numbered_name(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    match name.rfind('.') {
        Some(idx) if idx > 0 => format!("{} ({n}){}", &name[..idx], &name[idx..]),
        _ => format!("{name} ({n})"),
    }
}

/// Join a remote directory and a child name with `/` (SFTP and the agent both
/// report `/`-separated paths, also for Windows hosts).
pub(crate) fn join_remote(dir: &str, child: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        format!("/{child}")
    } else {
        format!("{trimmed}/{child}")
    }
}

// ── Local plan ──────────────────────────────────────────────────────

/// One dropped item, walked on the local disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LocalItem {
    /// A regular file.
    File { local: PathBuf, name: String },
    /// A folder: its sub-folders (relative, parents first) and files
    /// (relative path, local path). Symbolic links inside are left out.
    Folder {
        name: String,
        dirs: Vec<Vec<String>>,
        files: Vec<(Vec<String>, PathBuf)>,
    },
}

/// A local path the upload left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopUploadSkip {
    /// The local path as dropped (or found inside a dropped folder).
    pub local_path: String,
    /// The user-facing reason, e.g. "symbolic links are not followed".
    pub reason: String,
}

/// What [`plan_local`] found on the local disk.
#[derive(Debug, Default)]
pub(crate) struct LocalPlan {
    pub items: Vec<LocalItem>,
    pub skipped: Vec<RemoteDesktopUploadSkip>,
}

const SKIP_SYMLINK: &str = "symbolic links are not followed";

fn skip(path: &Path, reason: impl Into<String>) -> RemoteDesktopUploadSkip {
    RemoteDesktopUploadSkip {
        local_path: path.to_string_lossy().into_owned(),
        reason: reason.into(),
    }
}

/// Walk `root` (a folder) without following links, collecting its sub-folders
/// and files relative to it.
fn walk_folder(
    root: &Path,
    rel: &[String],
    dirs: &mut Vec<Vec<String>>,
    files: &mut Vec<(Vec<String>, PathBuf)>,
    skipped: &mut Vec<RemoteDesktopUploadSkip>,
) {
    let dir = rel.iter().fold(root.to_path_buf(), |p, c| p.join(c));
    let mut entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(read) => read.filter_map(Result::ok).collect(),
        Err(e) => {
            skipped.push(skip(&dir, format!("cannot read the folder: {e}")));
            return;
        }
    };
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let mut child = rel.to_vec();
        child.push(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => skipped.push(skip(&path, SKIP_SYMLINK)),
            Ok(meta) if meta.is_dir() => {
                dirs.push(child.clone());
                walk_folder(root, &child, dirs, files, skipped);
            }
            Ok(meta) if meta.is_file() => files.push((child, path)),
            Ok(_) => skipped.push(skip(&path, "not a regular file")),
            Err(e) => skipped.push(skip(&path, e.to_string())),
        }
    }
}

/// Classify the dropped local paths: files, folders (walked recursively) and
/// what is skipped (symbolic links, special files, unreadable paths). Blocking
/// filesystem I/O — call it off the async runtime.
pub(crate) fn plan_local(paths: &[String]) -> LocalPlan {
    let mut plan = LocalPlan::default();
    for raw in paths {
        let path = PathBuf::from(raw);
        let Some(name) = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
        else {
            plan.skipped.push(skip(&path, "not a file or folder"));
            continue;
        };
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                plan.skipped.push(skip(&path, SKIP_SYMLINK));
            }
            Ok(meta) if meta.is_dir() => {
                let (mut dirs, mut files) = (Vec::new(), Vec::new());
                walk_folder(&path, &[], &mut dirs, &mut files, &mut plan.skipped);
                plan.items.push(LocalItem::Folder { name, dirs, files });
            }
            Ok(meta) if meta.is_file() => plan.items.push(LocalItem::File { local: path, name }),
            Ok(_) => plan.skipped.push(skip(&path, "not a regular file")),
            Err(e) => plan.skipped.push(skip(&path, e.to_string())),
        }
    }
    plan
}

// ── Remote destination ──────────────────────────────────────────────

/// The metadata calls placing an upload needs on the file host.
#[async_trait::async_trait]
pub(crate) trait UploadDestination: Send + Sync {
    /// The account's home directory (absolute).
    async fn home(&self) -> Result<String, String>;
    /// `Some(is_directory)` when `path` exists, `None` only when the host
    /// definitely reports it missing. Any other failure is an error — never
    /// "missing" — so a name is never taken for free by mistake (#4299).
    async fn probe(&self, path: &str) -> Result<Option<bool>, String>;
    /// Create the folder `path` (its parent exists).
    async fn mkdir(&self, path: &str) -> Result<(), String>;
    /// Claim `path` for an upload by creating it as a new, empty file that
    /// must not exist yet (an exclusive create, #4299).
    async fn claim_new_file(&self, path: &str) -> Result<Claim, String>;
}

/// The outcome of [`UploadDestination::claim_new_file`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Claim {
    /// The empty file was created: the upload owns it.
    Claimed,
    /// Something already holds the name (it appeared after the probe).
    Exists,
    /// The host has no exclusive create; the probe's answer stands.
    Unsupported,
}

/// `Ok(None)` for a definite "not found", `Ok(Some(is_directory))` for an
/// entry, and the error text for every other failure (#4299).
fn probe_result(stat: Result<FileEntry, FileError>) -> Result<Option<bool>, String> {
    match stat {
        Ok(entry) => Ok(Some(entry.is_directory)),
        Err(FileError::NotFound(_)) => Ok(None),
        Err(FileError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Settle an exclusive create of `path`: success claims it; a refusal is a
/// clash only when `path` exists now (SFTP v3 reports a taken name as a
/// generic failure), otherwise it is a real error — as is a failed re-check.
pub(crate) async fn settle_exclusive_create(
    dest: &dyn UploadDestination,
    path: &str,
    created: Result<(), String>,
) -> Result<Claim, String> {
    let Err(create_error) = created else {
        return Ok(Claim::Claimed);
    };
    match dest.probe(path).await {
        Ok(Some(_)) => Ok(Claim::Exists),
        Ok(None) => Err(format!("cannot create {path}: {create_error}")),
        Err(e) => Err(format!("cannot create {path}: {create_error} ({e})")),
    }
}

/// One file of the upload, placed at its final remote path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlacedFile {
    pub local: PathBuf,
    pub remote: String,
}

/// The placed upload: files to enqueue, folders created, items skipped.
#[derive(Debug, Default)]
pub(crate) struct Placement {
    pub files: Vec<PlacedFile>,
    pub folders: u32,
    pub skipped: Vec<RemoteDesktopUploadSkip>,
}

/// What a free name is for: a file (claimed with an exclusive create where
/// the host can) or a folder (created by the caller's `mkdir`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NameFor {
    File,
    Folder,
}

/// The first free "keep both" name for `name` in `dest_dir`, skipping names
/// this upload already claimed (two dropped files with the same name).
///
/// A probe that fails for any reason other than "not found" ends the search
/// with that error: the item is skipped, never written (#4299). A file name
/// is then claimed with an exclusive create; one that appeared since the
/// probe moves on to the next number.
async fn free_name(
    dest: &dyn UploadDestination,
    dest_dir: &str,
    name: &str,
    kind: NameFor,
    claimed: &mut HashSet<String>,
) -> Result<String, String> {
    for n in 0..=MAX_KEEP_BOTH {
        let candidate = numbered_name(name, n);
        if claimed.contains(&candidate) {
            continue;
        }
        let path = join_remote(dest_dir, &candidate);
        if dest.probe(&path).await?.is_some() {
            continue;
        }
        if kind == NameFor::File && dest.claim_new_file(&path).await? == Claim::Exists {
            continue;
        }
        claimed.insert(candidate.clone());
        return Ok(candidate);
    }
    Err(format!(
        "no free name for {name} after {MAX_KEEP_BOTH} tries"
    ))
}

/// Resolve the destination folder: the requested one (a leading `~` is the
/// account's home) or the session's default; it must be an existing folder.
pub(crate) async fn resolve_dest_dir(
    dest: &dyn UploadDestination,
    requested: Option<&str>,
    default_dir: &str,
) -> Result<String, String> {
    let requested = requested.map(str::trim).filter(|d| !d.is_empty());
    let dir = match requested {
        Some(dir) if dir == "~" || dir.starts_with("~/") || dir.starts_with("~\\") => {
            let home = dest.home().await?;
            termihub_core::connection::graphical_files::expand_remote_dir(dir, &home)
                .unwrap_or(home)
        }
        Some(dir) => dir.to_string(),
        None => default_dir.to_string(),
    };
    let found = dest
        .probe(&dir)
        .await
        .map_err(|e| format!("cannot check the folder {dir}: {e}"))?;
    match found {
        Some(true) => Ok(dir),
        Some(false) => Err(format!("{dir} is not a folder")),
        None => Err(format!("the folder {dir} does not exist")),
    }
}

/// Place every planned item in `dest_dir`: pick keep-both names for the
/// dropped items, create the dropped folders' trees, and list the files to
/// upload. A failure on one item skips that item; the rest still go.
pub(crate) async fn place(
    dest: &dyn UploadDestination,
    dest_dir: &str,
    plan: LocalPlan,
) -> Placement {
    let mut out = Placement {
        skipped: plan.skipped,
        ..Placement::default()
    };
    let mut claimed = HashSet::new();
    for item in plan.items {
        match item {
            LocalItem::File { local, name } => {
                match free_name(dest, dest_dir, &name, NameFor::File, &mut claimed).await {
                    Ok(free) => out.files.push(PlacedFile {
                        local,
                        remote: join_remote(dest_dir, &free),
                    }),
                    Err(e) => out.skipped.push(skip(&local, e)),
                }
            }
            LocalItem::Folder { name, dirs, files } => {
                let root =
                    match free_name(dest, dest_dir, &name, NameFor::Folder, &mut claimed).await {
                        Ok(free) => join_remote(dest_dir, &free),
                        Err(e) => {
                            out.skipped.push(skip(Path::new(&name), e));
                            continue;
                        }
                    };
                if let Err(e) = dest.mkdir(&root).await {
                    out.skipped
                        .push(skip(Path::new(&name), format!("cannot create {root}: {e}")));
                    continue;
                }
                out.folders += 1;
                let remote_of = |rel: &[String]| {
                    rel.iter()
                        .fold(root.clone(), |acc, part| join_remote(&acc, part))
                };
                // A sub-folder that cannot be created drops its whole subtree.
                let mut failed: Vec<Vec<String>> = Vec::new();
                for rel in &dirs {
                    if failed.iter().any(|f| rel.starts_with(f)) {
                        continue;
                    }
                    let remote = remote_of(rel);
                    match dest.mkdir(&remote).await {
                        Ok(()) => out.folders += 1,
                        Err(e) => {
                            out.skipped.push(skip(
                                Path::new(&rel.join("/")),
                                format!("cannot create {remote}: {e}"),
                            ));
                            failed.push(rel.clone());
                        }
                    }
                }
                for (rel, local) in files {
                    if failed.iter().any(|f| rel.starts_with(f)) {
                        continue;
                    }
                    out.files.push(PlacedFile {
                        local,
                        remote: remote_of(&rel),
                    });
                }
            }
        }
    }
    out
}

// ── Carriers ────────────────────────────────────────────────────────

/// The agent requests the agent route needs — a seam so the carrier is
/// testable without a live agent. Blocking (agent RPCs are synchronous).
///
/// A failure is a [`FileError`]: only the agent's own "file not found" answer
/// is [`FileError::NotFound`], so a missing name is told apart from a
/// permission error or a timeout (#4299).
pub(crate) trait AgentRequests: Send + Sync {
    fn request(&self, agent_id: &str, method: &str, params: Value) -> Result<Value, FileError>;

    /// Which of chmod / chown / symlink the agent host's own file system
    /// performs, as the agent reported in `initialize`
    /// (`capabilities.hostFileAttributeOps`, protocol 0.29.0, #4601). `None`
    /// when the agent is older or not connected.
    fn host_file_attribute_ops(&self, _agent_id: &str) -> Option<FileAttributeOps> {
        None
    }

    /// Whether the agent performs an exclusive create on its host's own file
    /// system (`capabilities.fileCreateNew`, protocol 0.30.0, #4433). `false`
    /// when the agent is older or not connected: such an agent would ignore
    /// `create_new` and truncate, so it is never sent one.
    fn supports_file_create_new(&self, _agent_id: &str) -> bool {
        false
    }
}

impl AgentRequests for Arc<dyn AgentRpcClient> {
    fn request(&self, agent_id: &str, method: &str, params: Value) -> Result<Value, FileError> {
        self.send_file_request(agent_id, method, params)
    }

    fn host_file_attribute_ops(&self, agent_id: &str) -> Option<FileAttributeOps> {
        self.get_capabilities(agent_id)
            .and_then(|caps| caps.host_file_attribute_ops)
    }

    fn supports_file_create_new(&self, agent_id: &str) -> bool {
        self.get_capabilities(agent_id)
            .is_some_and(|caps| caps.file_create_new)
    }
}

/// The agent host's own file system, addressed through the agent's host-level
/// `connection.files.*` service — every request carries **no**
/// `connectionId`, so the agent serves it from its local file system.
#[derive(Clone)]
pub(crate) struct AgentHostFiles {
    agent_id: String,
    agents: Arc<dyn AgentRequests>,
}

impl AgentHostFiles {
    pub(crate) fn new(agent_id: String, agents: Arc<dyn AgentRequests>) -> Self {
        Self { agent_id, agents }
    }

    /// The agent whose host file system this addresses.
    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    /// The chmod / chown / symlink support the agent reports for its host's
    /// own file system (#4601); `None` for an older agent.
    pub(super) fn host_file_attribute_ops(&self) -> Option<FileAttributeOps> {
        self.agents.host_file_attribute_ops(&self.agent_id)
    }

    /// Run one request on the blocking pool (agent RPCs park their thread).
    /// `params` is one of the shared `Files*Params` DTOs with
    /// `connection_id: None` — the agent host's own file system.
    pub(super) async fn call(
        &self,
        method: &'static str,
        params: impl Serialize,
    ) -> Result<Value, FileError> {
        let params =
            serde_json::to_value(params).map_err(|e| FileError::OperationFailed(e.to_string()))?;
        let agents = self.agents.clone();
        let agent_id = self.agent_id.clone();
        tokio::task::spawn_blocking(move || agents.request(&agent_id, method, params))
            .await
            .map_err(|e| FileError::OperationFailed(format!("agent request failed: {e}")))?
    }

    pub(super) async fn stat_entry(&self, path: &str) -> Result<FileEntry, FileError> {
        let value = self
            .call(
                CONNECTION_FILES_STAT,
                FilesStatParams {
                    connection_id: None,
                    path: path.to_string(),
                },
            )
            .await?;
        serde_json::from_value(value)
            .map_err(|e| FileError::OperationFailed(format!("unexpected stat reply: {e}")))
    }
}

#[async_trait::async_trait]
impl RangedFileAccess for AgentHostFiles {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        use base64::Engine;
        let value = self
            .call(
                CONNECTION_FILES_READ_RANGE,
                FilesReadRangeParams {
                    connection_id: None,
                    path: path.to_string(),
                    offset,
                    length: len,
                },
            )
            .await?;
        let parsed = serde_json::from_value::<FilesReadRangeResult>(value)
            .map_err(|e| FileError::OperationFailed(e.to_string()))?;
        base64::engine::general_purpose::STANDARD
            .decode(parsed.data)
            .map_err(|e| FileError::OperationFailed(format!("Base64 decode failed: {e}")))
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        use base64::Engine;
        self.call(
            CONNECTION_FILES_WRITE_RANGE,
            FilesWriteRangeParams {
                connection_id: None,
                path: path.to_string(),
                offset,
                data: base64::engine::general_purpose::STANDARD.encode(data),
                create_new: false,
            },
        )
        .await
        .map(|_| ())
    }
}

#[async_trait::async_trait]
impl RangedTransferTarget for AgentHostFiles {
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        self.stat_entry(path).await
    }

    async fn remove_file(&self, path: &str) -> Result<(), FileError> {
        self.call(
            CONNECTION_FILES_DELETE,
            FilesDeleteParams {
                connection_id: None,
                path: path.to_string(),
                is_directory: false,
            },
        )
        .await
        .map(|_| ())
    }
}

#[async_trait::async_trait]
impl UploadDestination for AgentHostFiles {
    async fn home(&self) -> Result<String, String> {
        self.stat_entry("~")
            .await
            .map(|e| e.path)
            .map_err(|e| e.to_string())
    }

    async fn probe(&self, path: &str) -> Result<Option<bool>, String> {
        probe_result(self.stat_entry(path).await)
    }

    async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.call(
            CONNECTION_FILES_MKDIR,
            FilesMkdirParams {
                connection_id: None,
                path: path.to_string(),
            },
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// An empty `write_range` with `create_new` (protocol 0.30.0, #4433): the
    /// agent creates the file only if nothing holds the name, so the upload
    /// then only ever writes the file it created. An agent that does not
    /// advertise `fileCreateNew` is never sent the flag — it would ignore it
    /// and truncate — and keeps [`Claim::Unsupported`], as does one that
    /// answers "method not found" or "not supported"; the strict probe is
    /// then what keeps an existing file safe.
    async fn claim_new_file(&self, path: &str) -> Result<Claim, String> {
        if !self.agents.supports_file_create_new(&self.agent_id) {
            return Ok(Claim::Unsupported);
        }
        let created = self
            .call(
                CONNECTION_FILES_WRITE_RANGE,
                FilesWriteRangeParams {
                    connection_id: None,
                    path: path.to_string(),
                    offset: 0,
                    data: String::new(),
                    create_new: true,
                },
            )
            .await;
        match created {
            Ok(_) => Ok(Claim::Claimed),
            Err(FileError::AlreadyExists(_)) => Ok(Claim::Exists),
            Err(FileError::NotSupported) => Ok(Claim::Unsupported),
            Err(e) => settle_exclusive_create(self, path, Err(e.to_string())).await,
        }
    }
}

/// The SSH route's destination: the SFTP channel on the tunnel session.
pub(crate) struct SftpDestination(pub Arc<SftpFileBrowser>);

#[async_trait::async_trait]
impl UploadDestination for SftpDestination {
    async fn home(&self) -> Result<String, String> {
        use termihub_core::backends::ssh::SftpAdvancedOps;
        self.0.realpath(".").await.map_err(|e| e.to_string())
    }

    async fn probe(&self, path: &str) -> Result<Option<bool>, String> {
        probe_result(FileBrowser::stat(self.0.as_ref(), path).await)
    }

    async fn mkdir(&self, path: &str) -> Result<(), String> {
        FileBrowser::mkdir(self.0.as_ref(), path)
            .await
            .map_err(|e| e.to_string())
    }

    /// `CREATE | EXCLUDE` on a dedicated SFTP channel: the upload then only
    /// ever writes the empty file it created.
    async fn claim_new_file(&self, path: &str) -> Result<Claim, String> {
        let channel = self
            .0
            .open_dedicated_channel()
            .await
            .map_err(|e| format!("cannot create {path}: {e}"))?;
        let created = channel.create_new(path).await.map_err(|e| e.to_string());
        settle_exclusive_create(self, path, created).await
    }
}

/// The carrier a graphical session's uploads run over.
#[derive(Clone)]
pub(crate) enum UploadCarrier {
    /// SFTP on the VNC SSH tunnel's session.
    Sftp(Arc<SftpFileBrowser>),
    /// The hosting agent's host-level file service.
    Agent(Arc<AgentHostFiles>),
}

impl UploadCarrier {
    /// An error worded by this carrier: `SFTP error: …` or `Remote agent
    /// error: …`.
    pub(crate) fn error(&self, message: String) -> crate::utils::errors::TerminalError {
        use crate::utils::errors::TerminalError;
        match self {
            Self::Sftp(_) => TerminalError::SftpError(message),
            Self::Agent(_) => TerminalError::RemoteError(message),
        }
    }

    /// The metadata side of this carrier.
    pub(crate) fn destination(&self) -> Box<dyn UploadDestination> {
        match self {
            Self::Sftp(browser) => Box::new(SftpDestination(browser.clone())),
            Self::Agent(files) => Box::new(files.as_ref().clone()),
        }
    }
}

// ── Enqueue ─────────────────────────────────────────────────────────

/// One upload started on the Transfers queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopUploadItem {
    /// The Transfers queue id (`transfer-progress` events carry it).
    pub transfer_id: String,
    pub local_path: String,
    /// Where the file lands on the file host (after keep-both naming).
    pub remote_path: String,
}

/// The answer of `remote_desktop_upload`: what was queued, where, and what
/// was left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopUploadStarted {
    /// The absolute destination folder on the file host.
    pub dest_dir: String,
    /// The file host the bytes go to (the SSH or agent host).
    pub host: String,
    /// One queued transfer per file, in drop order.
    pub transfers: Vec<RemoteDesktopUploadItem>,
    /// Folders created on the file host (dropped folders and their sub-folders).
    pub folders: u32,
    /// Local paths left out, with the reason.
    pub skipped: Vec<RemoteDesktopUploadSkip>,
}

/// Enqueue every placed file on the Transfers queue under `session_id` and
/// spawn its executor over `carrier`. Returns the queued items.
///
/// With `persist`, each upload is first recorded in the durable queue with
/// the side channel's identity (#4205) — before its executor starts, so even
/// a file that finishes at once is pruned rather than left behind — and an
/// upload cut off by quitting the app resumes from its checkpoint once a
/// session of the same VNC connection is back.
pub(crate) fn start_uploads(
    carrier: &UploadCarrier,
    session_id: &str,
    files: Vec<PlacedFile>,
    registry: &TransferRegistry,
    sink: &ProgressSink,
    persist: Option<(&TransferPersistenceManager, &PersistedGraphicalTarget)>,
) -> Vec<RemoteDesktopUploadItem> {
    files
        .into_iter()
        .map(|file| {
            let transfer_id = uuid::Uuid::new_v4().to_string();
            let local_path = file.local.to_string_lossy().into_owned();
            let name = crate::utils::fs::file_name_of(&file.remote);
            let handle = registry.enqueue(
                &transfer_id,
                session_id,
                TransferDirection::Upload,
                &name,
                &file.remote,
                0,
            );
            if let Some((pm, target)) = persist {
                pm.record_registration(
                    &transfer_id,
                    session_id,
                    TransferDirection::Upload,
                    &name,
                    &file.remote,
                    Some(local_path.clone()),
                    0,
                );
                pm.record_graphical_target(&transfer_id, target.clone());
            }
            let (registry, sink) = (registry.clone(), sink.clone());
            let (remote, local) = (file.remote.clone(), local_path.clone());
            tokio::spawn(crate::files::transfer::relaunch::run_side_channel_transfer(
                carrier.clone(),
                TransferDirection::Upload,
                remote,
                local,
                handle,
                registry,
                sink,
                0,
            ));
            RemoteDesktopUploadItem {
                transfer_id,
                local_path,
                remote_path: file.remote,
            }
        })
        .collect()
}

/// Cancel every unfinished transfer of a graphical session — closing the
/// session cancels its queued uploads (the concept's "session closed" rule).
/// Returns how many were signalled.
pub(crate) fn cancel_session_transfers(registry: &TransferRegistry, session_id: &str) -> usize {
    // `cancel` signals only live handles; retained terminal snapshots answer
    // `false` and are not counted.
    registry
        .list(Some(session_id))
        .into_iter()
        .filter(|snap| registry.cancel(&snap.transfer_id))
        .count()
}

#[cfg(test)]
#[path = "graphical_upload_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "graphical_upload_naming_tests.rs"]
mod naming_tests;
