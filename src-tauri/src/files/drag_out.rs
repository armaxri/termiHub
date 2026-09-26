//! Native drag-out of file-browser entries to the OS file manager (#3457).
//!
//! A row dragged out of the window is handed to the OS as a real file drag
//! (Finder / Explorer / GTK file managers) through the `drag` crate, which wraps
//! `NSDraggingSession`, `DoDragDrop` and GTK drag sources. The crate is used
//! directly — rather than through `tauri-plugin-drag` — so no generic
//! `drag:allow-start-drag` capability is granted to the webview: the only entry
//! point is the typed [`crate::commands::files::drag_out_start`] command, which
//! accepts file paths only (never arbitrary pasteboard data) and validates them.
//!
//! Remote (session) entries have no local path, so the frontend first downloads
//! them into a **staging directory** created here. Staging directories are:
//!
//! - private: created `0700` on Unix (under the per-user app cache dir, which is
//!   already per-user ACL'd on Windows), so staged remote files are never
//!   world-readable;
//! - owned: tracked per process, so a discard request can only delete a
//!   directory this process created, never an arbitrary path;
//! - short-lived: discarded by the frontend once its reuse window lapses, all
//!   removed at app teardown, and any left behind by a crash are swept (older
//!   than [`STALE_STAGING_AGE`]) the next time staging is used.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tracing::{debug, warn};

use super::FileEntry;

/// The most entries one drag-out may carry. Generous for a real multi-selection,
/// small enough that a runaway request cannot build a huge pasteboard.
pub const MAX_DRAG_OUT_PATHS: usize = 1000;

/// Staging directories older than this are presumed abandoned (a crash skipped
/// teardown) and are swept on the next staging request.
pub const STALE_STAGING_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The most entries (files and folders) one staging request may create —
/// bounds a recursive remote-folder drag-out (#3491).
pub const MAX_STAGED_ENTRIES: usize = 10_000;

/// The deepest a staged remote folder tree may nest.
pub const MAX_STAGED_DEPTH: usize = 32;

/// The most bytes one backend-staged drag-out (Docker / agent sessions, #3491)
/// may copy. Those backends return whole files in memory, so the cap bounds
/// both disk use and peak memory.
pub const MAX_BYTE_STAGED_BYTES: u64 = 1024 * 1024 * 1024;

/// Name of the staging root beneath the app cache dir.
pub const STAGING_DIR_NAME: &str = "drag-out";

/// Characters that are invalid in a file name on at least one supported OS.
const INVALID_NAME_CHARS: &[char] = &['/', '\\', '<', '>', ':', '"', '|', '?', '*', '\0'];

/// Reduce a remote entry name to a single, safe local file-name component.
///
/// The name comes from a remote listing, so a hostile server could send
/// `../../.bashrc`: separators and characters invalid on any supported OS become
/// `_`, control characters are dropped, and a name that would still resolve to
/// the directory itself (`""`, `.`, `..`) falls back to `download`.
pub fn sanitize_staged_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() || *c == '\0')
        .map(|c| {
            if INVALID_NAME_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows silently strips trailing dots/spaces, which could collide names.
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Make `base` unique within `used` (compared case-insensitively, as on macOS
/// and Windows), suffixing ` (2)`, ` (3)`, ... before the extension.
fn unique_name(used: &mut HashSet<String>, base: String) -> String {
    if used.insert(base.to_lowercase()) {
        return base;
    }
    let (stem, ext) = match base.rfind('.') {
        Some(idx) if idx > 0 => (&base[..idx], &base[idx..]),
        _ => (base.as_str(), ""),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

/// Map each requested name to a unique sanitized file name, suffixing
/// ` (2)`, ` (3)`, ... when two names collapse to the same component.
pub fn unique_staged_names(names: &[String]) -> Vec<String> {
    let mut used: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|name| unique_name(&mut used, sanitize_staged_name(name)))
        .collect()
}

/// One entry of a staging tree request (#3491): its remote path split into
/// name segments relative to the drag selection (`["logs", "2026", "a.txt"]`),
/// and whether it is a directory. A one-segment entry is a dragged row itself.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagingEntry {
    pub segments: Vec<String>,
    #[serde(default)]
    pub is_directory: bool,
}

impl StagingEntry {
    /// A top-level file entry named `name`.
    pub fn file(name: &str) -> Self {
        Self {
            segments: vec![name.to_string()],
            is_directory: false,
        }
    }
}

/// Map a staging tree request to one safe relative local path per entry.
///
/// Every segment is reduced by [`sanitize_staged_name`], so no request can
/// escape the staging directory (`..`, absolute names and separators all become
/// plain components), and names that collapse together within one directory are
/// made unique. A segment prefix always maps to the same local component, so
/// children land under their (sanitized) parent. The request is bounded by
/// [`MAX_STAGED_ENTRIES`] and [`MAX_STAGED_DEPTH`], and a path that uses a file
/// entry as a parent directory is refused.
pub fn plan_staged_tree(entries: &[StagingEntry]) -> Result<Vec<PathBuf>, String> {
    if entries.is_empty() {
        return Err("nothing to stage".to_string());
    }
    if entries.len() > MAX_STAGED_ENTRIES {
        return Err(format!(
            "too many entries to stage ({} > {MAX_STAGED_ENTRIES})",
            entries.len()
        ));
    }
    // Remote segment prefix -> (local relative path, is a directory).
    let mut mapped: HashMap<Vec<String>, (PathBuf, bool)> = HashMap::new();
    // Local relative parent dir -> names already used inside it.
    let mut used: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let depth = entry.segments.len();
        if depth == 0 {
            return Err("staging entry has no name".to_string());
        }
        if depth > MAX_STAGED_DEPTH {
            return Err(format!(
                "staging entry is nested too deeply ({depth} > {MAX_STAGED_DEPTH})"
            ));
        }
        let mut local = PathBuf::new();
        for i in 0..depth {
            let is_last = i + 1 == depth;
            let prefix = entry.segments[..=i].to_vec();
            if let Some((path, is_dir)) = mapped.get(&prefix) {
                if !is_last && !*is_dir {
                    return Err(format!(
                        "staging entry uses a file as a folder: {}",
                        entry.segments.join("/")
                    ));
                }
                local = path.clone();
                continue;
            }
            let name = unique_name(
                used.entry(local.clone()).or_default(),
                sanitize_staged_name(&entry.segments[i]),
            );
            local = local.join(name);
            let is_dir = !is_last || entry.is_directory;
            mapped.insert(prefix, (local.clone(), is_dir));
        }
        out.push(local);
    }
    Ok(out)
}

/// Validate the paths a drag-out request carries: non-empty, bounded, absolute,
/// free of `..` components, and existing on disk.
pub fn validate_drag_paths(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("nothing to drag".to_string());
    }
    if paths.len() > MAX_DRAG_OUT_PATHS {
        return Err(format!(
            "too many entries to drag ({} > {MAX_DRAG_OUT_PATHS})",
            paths.len()
        ));
    }
    paths
        .iter()
        .map(|raw| {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(format!("not an absolute path: {raw}"));
            }
            if path.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(format!("path must not contain '..': {raw}"));
            }
            if std::fs::symlink_metadata(&path).is_err() {
                return Err(format!("no such file: {raw}"));
            }
            Ok(path)
        })
        .collect()
}

/// Create `dir` (and its parents) and restrict it to the current user.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        // `mode` only applies to newly created directories; tighten an existing
        // one (e.g. a root created by an older build) as well.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Remove staging directories under `root` last modified before `now - max_age`.
/// Returns how many were removed. Best-effort: unreadable entries are skipped.
pub fn sweep_stale_staging(root: &Path, max_age: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > max_age);
        if stale && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// A freshly created staging directory and the local target path for each
/// requested name, in request order.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagingDir {
    pub dir: String,
    pub paths: Vec<String>,
}

/// Per-process registry of the staging directories this process created.
#[derive(Default)]
pub struct DragOutStaging {
    owned: Mutex<HashSet<PathBuf>>,
    swept: Mutex<bool>,
}

impl DragOutStaging {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a new private staging directory under `root` and return the target
    /// path for each of `names` (top-level files) inside it.
    pub fn create(&self, root: &Path, names: &[String]) -> Result<StagingDir, String> {
        if names.len() > MAX_DRAG_OUT_PATHS {
            return Err(format!(
                "too many entries to stage ({} > {MAX_DRAG_OUT_PATHS})",
                names.len()
            ));
        }
        let entries: Vec<StagingEntry> = names.iter().map(|n| StagingEntry::file(n)).collect();
        self.create_tree(root, &entries)
    }

    /// Create a new private staging directory under `root` laid out for a
    /// (possibly nested) staging tree request, and return the local target path
    /// for each entry, in request order (see [`plan_staged_tree`]). Folder
    /// entries — and every file's parent — are created (private) up front, so
    /// the caller only has to download each file entry to its path.
    pub fn create_tree(&self, root: &Path, entries: &[StagingEntry]) -> Result<StagingDir, String> {
        let relative = plan_staged_tree(entries)?;
        let dir = self.create_dir(root)?;
        let mut paths = Vec::with_capacity(relative.len());
        for (entry, rel) in entries.iter().zip(&relative) {
            let local = dir.join(rel);
            let folder = if entry.is_directory {
                Some(local.as_path())
            } else {
                local.parent().filter(|p| *p != dir.as_path())
            };
            if let Some(folder) = folder {
                if let Err(e) = create_private_dir(folder) {
                    let _ = self.discard(&dir);
                    return Err(format!("could not create staging folder: {e}"));
                }
            }
            paths.push(local.to_string_lossy().into_owned());
        }
        Ok(StagingDir {
            dir: dir.to_string_lossy().into_owned(),
            paths,
        })
    }

    /// Create (and register as owned) a new, empty private staging directory
    /// under `root`, sweeping crash leftovers the first time.
    pub fn create_dir(&self, root: &Path) -> Result<PathBuf, String> {
        create_private_dir(root).map_err(|e| format!("could not create staging root: {e}"))?;
        self.sweep_once(root);
        let dir = root.join(format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        create_private_dir(&dir).map_err(|e| format!("could not create staging dir: {e}"))?;
        if let Ok(mut owned) = self.owned.lock() {
            owned.insert(dir.clone());
        }
        debug!(dir = %dir.display(), "Created drag-out staging dir");
        Ok(dir)
    }

    /// Sweep crash leftovers the first time staging is used in this process.
    fn sweep_once(&self, root: &Path) {
        let Ok(mut swept) = self.swept.lock() else {
            return;
        };
        if *swept {
            return;
        }
        *swept = true;
        let removed = sweep_stale_staging(root, STALE_STAGING_AGE, SystemTime::now());
        if removed > 0 {
            debug!(removed, "Swept stale drag-out staging dirs");
        }
    }

    /// Whether `dir` is a staging directory this process created.
    pub fn owns(&self, dir: &Path) -> bool {
        self.owned.lock().map(|o| o.contains(dir)).unwrap_or(false)
    }

    /// Delete one staging directory this process created. Unknown paths are
    /// refused so the command can never be used to delete arbitrary files.
    pub fn discard(&self, dir: &Path) -> Result<(), String> {
        let known = self
            .owned
            .lock()
            .map(|mut o| o.remove(dir))
            .unwrap_or(false);
        if !known {
            return Err(format!("not a drag-out staging dir: {}", dir.display()));
        }
        match std::fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not remove staging dir: {e}")),
        }
    }

    /// Remove every staging directory this process created (app teardown).
    pub fn cleanup_all(&self) {
        let dirs: Vec<PathBuf> = match self.owned.lock() {
            Ok(mut o) => o.drain().collect(),
            Err(_) => return,
        };
        for dir in dirs {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    warn!(dir = %dir.display(), "Could not remove drag-out staging dir: {e}");
                }
            }
        }
    }
}

/// One dragged row of a byte-based session (Docker / remote agent, #3491), as
/// the webview sends it. Only the remote side is supplied: the local
/// destination is always derived here, inside a staging directory this process
/// owns, from the sanitized `name`.
#[derive(Debug, Clone, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStageEntry {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub is_directory: bool,
}

/// Bounds for one backend-staged drag-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageLimits {
    /// Files and folders (including the dragged rows themselves).
    pub max_entries: usize,
    /// Nesting depth below a dragged row.
    pub max_depth: usize,
    /// Total file bytes.
    pub max_bytes: u64,
}

impl Default for StageLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_STAGED_ENTRIES,
            max_depth: MAX_STAGED_DEPTH,
            max_bytes: MAX_BYTE_STAGED_BYTES,
        }
    }
}

/// The remote side of a backend-staged drag-out: list a folder, read a file.
/// Implemented over a live session's file browser; faked in tests.
#[async_trait::async_trait]
pub trait StageSource: Send + Sync {
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String>;
    async fn read(&self, path: &str) -> Result<Vec<u8>, String>;
}

/// One pending unit of backend staging work.
struct StageWork {
    remote: String,
    local: PathBuf,
    is_dir: bool,
    depth: usize,
    size_hint: Option<u64>,
}

/// Copy the dragged rows of a byte-based session into `dir` (a staging
/// directory the caller created and owns), recursing into folders within
/// `limits`, and return the local path of each dragged row in request order.
///
/// Local names come from the remote listing and are reduced by
/// [`sanitize_staged_name`] and made unique per folder, so a hostile listing can
/// never write outside `dir`. Symlinked folders are not followed (no cycles),
/// and `.` / `..` listing entries are ignored. Any limit breach or remote error
/// aborts the whole staging; the caller discards `dir`.
pub async fn stage_from_source<S: StageSource + ?Sized>(
    source: &S,
    dir: &Path,
    entries: &[SessionStageEntry],
    limits: StageLimits,
) -> Result<Vec<PathBuf>, String> {
    if entries.is_empty() {
        return Err("nothing to stage".to_string());
    }
    if entries.len() > MAX_DRAG_OUT_PATHS {
        return Err(format!(
            "too many entries to stage ({} > {MAX_DRAG_OUT_PATHS})",
            entries.len()
        ));
    }
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let roots: Vec<PathBuf> = unique_staged_names(&names)
        .into_iter()
        .map(|name| dir.join(name))
        .collect();
    let mut stack: Vec<StageWork> = entries
        .iter()
        .zip(&roots)
        .rev()
        .map(|(entry, local)| StageWork {
            remote: entry.path.clone(),
            local: local.clone(),
            is_dir: entry.is_directory,
            depth: 0,
            size_hint: None,
        })
        .collect();
    let mut count = 0usize;
    let mut bytes = 0u64;
    let too_large = || {
        format!(
            "the selection is larger than {} MiB — use Download instead",
            limits.max_bytes / (1024 * 1024)
        )
    };
    while let Some(work) = stack.pop() {
        count += 1;
        if count > limits.max_entries {
            return Err(format!(
                "the selection has more than {} entries — use Download instead",
                limits.max_entries
            ));
        }
        if work.depth > limits.max_depth {
            return Err(format!(
                "the selection is nested deeper than {} levels — use Download instead",
                limits.max_depth
            ));
        }
        if work.is_dir {
            create_private_dir(&work.local)
                .map_err(|e| format!("could not create staging folder: {e}"))?;
            let children = source.list(&work.remote).await?;
            let mut used = HashSet::new();
            let mut pending = Vec::with_capacity(children.len());
            for child in children {
                if child.name == "." || child.name == ".." {
                    continue;
                }
                if child.is_directory && child.is_symlink {
                    debug!(path = %child.path, "Not following a symlinked folder");
                    continue;
                }
                let name = unique_name(&mut used, sanitize_staged_name(&child.name));
                pending.push(StageWork {
                    remote: child.path,
                    local: work.local.join(name),
                    is_dir: child.is_directory,
                    depth: work.depth + 1,
                    size_hint: Some(child.size),
                });
            }
            stack.extend(pending.into_iter().rev());
        } else {
            if work
                .size_hint
                .is_some_and(|size| bytes.saturating_add(size) > limits.max_bytes)
            {
                return Err(too_large());
            }
            let data = source.read(&work.remote).await?;
            bytes = bytes.saturating_add(data.len() as u64);
            if bytes > limits.max_bytes {
                return Err(too_large());
            }
            let local = work.local;
            tokio::task::spawn_blocking(move || std::fs::write(&local, data))
                .await
                .map_err(|e| format!("staging write was interrupted: {e}"))?
                .map_err(|e| format!("could not write staged file: {e}"))?;
        }
    }
    Ok(roots)
}

/// How a native drag-out ended.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DragOutResult {
    Dropped,
    Cancelled,
}

impl From<drag::DragResult> for DragOutResult {
    fn from(value: drag::DragResult) -> Self {
        match value {
            drag::DragResult::Dropped => Self::Dropped,
            drag::DragResult::Cancel => Self::Cancelled,
        }
    }
}

/// The drag preview image: the app's 32px icon, embedded so no file lookup can
/// fail at drag time.
const DRAG_PREVIEW_PNG: &[u8] = include_bytes!("../../icons/32x32.png");

/// Start a native OS file drag of `paths` from `window`. Must be called on the
/// main thread; `on_done` fires once with how the drag ended.
pub fn start_native_drag<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    paths: Vec<PathBuf>,
    on_done: impl Fn(DragOutResult) + Send + 'static,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let raw_window = window.gtk_window().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let raw_window = &raw_window;
    #[cfg(not(target_os = "linux"))]
    let raw_window = window;

    drag::start_drag(
        raw_window,
        drag::DragItem::Files(paths),
        drag::Image::Raw(DRAG_PREVIEW_PNG.to_vec()),
        move |result, _cursor| on_done(result.into()),
        drag::Options {
            skip_animatation_on_cancel_or_failure: false,
            mode: drag::DragMode::Copy,
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_neutralises_traversal_and_separators() {
        assert_eq!(sanitize_staged_name("../../.bashrc"), ".._.._.bashrc");
        assert_eq!(sanitize_staged_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_staged_name(".."), "download");
        assert_eq!(sanitize_staged_name("."), "download");
        assert_eq!(sanitize_staged_name(""), "download");
    }

    #[test]
    fn sanitize_replaces_windows_invalid_chars_and_trailing_dots() {
        assert_eq!(sanitize_staged_name("a<b>c:d\"e|f?g*h"), "a_b_c_d_e_f_g_h");
        assert_eq!(sanitize_staged_name("report. "), "report");
        assert_eq!(sanitize_staged_name("tab\there"), "tabhere");
        assert_eq!(sanitize_staged_name("nul\0byte"), "nul_byte");
    }

    #[test]
    fn sanitize_keeps_ordinary_names() {
        assert_eq!(sanitize_staged_name("notes.txt"), "notes.txt");
        assert_eq!(sanitize_staged_name(".hidden"), ".hidden");
        assert_eq!(sanitize_staged_name("résumé 2026.pdf"), "résumé 2026.pdf");
    }

    #[test]
    fn unique_names_suffix_collisions_case_insensitively() {
        let names = vec![
            "a.txt".to_string(),
            "A.txt".to_string(),
            "a/txt".to_string(),
            "a_txt".to_string(),
            "noext".to_string(),
            "noext".to_string(),
        ];
        assert_eq!(
            unique_staged_names(&names),
            vec![
                "a.txt",
                "A (2).txt",
                "a_txt",
                "a_txt (2)",
                "noext",
                "noext (2)"
            ]
        );
    }

    #[test]
    fn validate_rejects_empty_relative_parent_and_missing() {
        assert!(validate_drag_paths(&[]).is_err());
        assert!(validate_drag_paths(&["relative.txt".to_string()]).is_err());
        let tmp = tempfile::tempdir().expect("tempdir");
        let parent = tmp.path().join("x").join("..").join("y");
        assert!(validate_drag_paths(&[parent.to_string_lossy().into_owned()]).is_err());
        let missing = tmp.path().join("missing.txt");
        assert!(validate_drag_paths(&[missing.to_string_lossy().into_owned()]).is_err());
    }

    #[test]
    fn validate_accepts_existing_absolute_files_and_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, b"x").expect("write");
        let paths = vec![
            file.to_string_lossy().into_owned(),
            tmp.path().to_string_lossy().into_owned(),
        ];
        let out = validate_drag_paths(&paths).expect("valid");
        assert_eq!(out, vec![file, tmp.path().to_path_buf()]);
    }

    #[test]
    fn validate_caps_the_entry_count() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let p = tmp.path().to_string_lossy().into_owned();
        let many = vec![p; MAX_DRAG_OUT_PATHS + 1];
        assert!(validate_drag_paths(&many).is_err());
    }

    #[test]
    fn create_makes_private_owned_dir_with_sanitized_targets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join(STAGING_DIR_NAME);
        let staging = DragOutStaging::new();
        let out = staging
            .create(&root, &["../evil".to_string(), "ok.txt".to_string()])
            .expect("create");
        let dir = PathBuf::from(&out.dir);
        assert!(dir.is_dir());
        assert!(dir.starts_with(&root));
        assert!(staging.owns(&dir));
        assert_eq!(
            out.paths,
            vec![
                dir.join(".._evil").to_string_lossy().into_owned(),
                dir.join("ok.txt").to_string_lossy().into_owned(),
            ]
        );
        for p in &out.paths {
            assert_eq!(PathBuf::from(p).parent(), Some(dir.as_path()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&root), 0o700);
        }
    }

    #[test]
    fn create_rejects_empty_request() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(DragOutStaging::new().create(tmp.path(), &[]).is_err());
    }

    #[test]
    fn discard_removes_owned_dir_and_refuses_foreign_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let staging = DragOutStaging::new();
        let out = staging
            .create(tmp.path(), &["a.txt".to_string()])
            .expect("create");
        std::fs::write(&out.paths[0], b"data").expect("write");
        let dir = PathBuf::from(&out.dir);

        let foreign = tmp.path().join("foreign");
        std::fs::create_dir(&foreign).expect("mkdir");
        assert!(staging.discard(&foreign).is_err());
        assert!(foreign.is_dir(), "a foreign dir must never be deleted");

        staging.discard(&dir).expect("discard");
        assert!(!dir.exists());
        assert!(!staging.owns(&dir));
        // A second discard is refused: the dir is no longer owned.
        assert!(staging.discard(&dir).is_err());
    }

    #[test]
    fn cleanup_all_removes_every_owned_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let staging = DragOutStaging::new();
        let a = staging.create(tmp.path(), &["a".to_string()]).expect("a");
        let b = staging.create(tmp.path(), &["b".to_string()]).expect("b");
        staging.cleanup_all();
        assert!(!Path::new(&a.dir).exists());
        assert!(!Path::new(&b.dir).exists());
        assert!(tmp.path().is_dir(), "the root itself is kept");
    }

    #[test]
    fn sweep_removes_only_stale_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let old = tmp.path().join("old");
        let fresh = tmp.path().join("fresh");
        let file = tmp.path().join("stray.txt");
        std::fs::create_dir(&old).expect("old");
        std::fs::create_dir(&fresh).expect("fresh");
        std::fs::write(&file, b"x").expect("file");
        // Pretend "now" is two days ahead: both dirs look stale relative to it,
        // so age the fresh one forward by comparing against a 3-day window.
        let now = SystemTime::now() + Duration::from_secs(2 * 24 * 60 * 60);
        assert_eq!(
            sweep_stale_staging(tmp.path(), Duration::from_secs(3 * 24 * 60 * 60), now),
            0
        );
        assert_eq!(sweep_stale_staging(tmp.path(), STALE_STAGING_AGE, now), 2);
        assert!(!old.exists() && !fresh.exists());
        assert!(file.exists(), "non-directories are left alone");
    }

    #[test]
    fn sweep_of_missing_root_is_a_noop() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            sweep_stale_staging(
                &tmp.path().join("absent"),
                STALE_STAGING_AGE,
                SystemTime::now()
            ),
            0
        );
    }

    fn tree_entry(segments: &[&str], is_directory: bool) -> StagingEntry {
        StagingEntry {
            segments: segments.iter().map(|s| s.to_string()).collect(),
            is_directory,
        }
    }

    #[test]
    fn plan_tree_nests_children_under_their_sanitized_parent() {
        let entries = vec![
            tree_entry(&["logs"], true),
            tree_entry(&["logs", "2026"], true),
            tree_entry(&["logs", "2026", "a.txt"], false),
            tree_entry(&["logs", "b.txt"], false),
            tree_entry(&["top.txt"], false),
        ];
        let plan = plan_staged_tree(&entries).expect("plan");
        assert_eq!(
            plan,
            vec![
                PathBuf::from("logs"),
                PathBuf::from("logs").join("2026"),
                PathBuf::from("logs").join("2026").join("a.txt"),
                PathBuf::from("logs").join("b.txt"),
                PathBuf::from("top.txt"),
            ]
        );
    }

    #[test]
    fn plan_tree_neutralises_traversal_absolute_and_separator_segments() {
        let entries = vec![
            tree_entry(&[".."], true),
            tree_entry(&["..", "../../etc"], false),
            tree_entry(&["/abs"], false),
            tree_entry(&["C:\\win"], false),
        ];
        let plan = plan_staged_tree(&entries).expect("plan");
        for rel in &plan {
            assert!(rel.is_relative(), "{rel:?} must stay relative");
            assert!(
                rel.components().all(|c| matches!(c, Component::Normal(_))),
                "{rel:?} must only hold plain components"
            );
        }
        assert_eq!(plan[0], PathBuf::from("download"));
        assert_eq!(plan[1], PathBuf::from("download").join(".._.._etc"));
        assert_eq!(plan[2], PathBuf::from("_abs"));
        assert_eq!(plan[3], PathBuf::from("C__win"));
    }

    #[test]
    fn plan_tree_makes_colliding_names_unique_per_folder_only() {
        let entries = vec![
            tree_entry(&["a"], true),
            tree_entry(&["a", "x/y"], false),
            tree_entry(&["a", "x_y"], false),
            tree_entry(&["b"], true),
            tree_entry(&["b", "x_y"], false),
        ];
        let plan = plan_staged_tree(&entries).expect("plan");
        assert_eq!(plan[1], PathBuf::from("a").join("x_y"));
        assert_eq!(plan[2], PathBuf::from("a").join("x_y (2)"));
        assert_eq!(plan[4], PathBuf::from("b").join("x_y"));
    }

    #[test]
    fn plan_tree_enforces_bounds_and_structure() {
        assert!(plan_staged_tree(&[]).is_err());
        assert!(plan_staged_tree(&[tree_entry(&[], false)]).is_err());
        let deep: Vec<String> = (0..=MAX_STAGED_DEPTH).map(|i| i.to_string()).collect();
        let deep: Vec<&str> = deep.iter().map(String::as_str).collect();
        assert!(plan_staged_tree(&[tree_entry(&deep, false)]).is_err());
        let many = vec![tree_entry(&["f"], false); MAX_STAGED_ENTRIES + 1];
        assert!(plan_staged_tree(&many).is_err());
        let file_as_dir = vec![tree_entry(&["f"], false), tree_entry(&["f", "g"], false)];
        assert!(plan_staged_tree(&file_as_dir).is_err());
    }

    #[test]
    fn create_tree_lays_out_private_folders_inside_the_staging_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let staging = DragOutStaging::new();
        let entries = vec![
            tree_entry(&["logs"], true),
            tree_entry(&["logs", "empty"], true),
            tree_entry(&["logs", "deep", "a.txt"], false),
        ];
        let out = staging.create_tree(tmp.path(), &entries).expect("create");
        let dir = PathBuf::from(&out.dir);
        assert!(staging.owns(&dir));
        assert_eq!(out.paths.len(), 3);
        assert!(Path::new(&out.paths[0]).is_dir());
        assert!(Path::new(&out.paths[1]).is_dir());
        assert!(dir.join("logs").join("deep").is_dir(), "a file's parent exists");
        assert!(!Path::new(&out.paths[2]).exists(), "files are left to the download");
        for p in &out.paths {
            assert!(Path::new(p).starts_with(&dir));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("logs").join("deep"))
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn create_tree_refuses_a_bad_request_without_creating_a_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let staging = DragOutStaging::new();
        let bad = vec![tree_entry(&["f"], false), tree_entry(&["f", "g"], false)];
        assert!(staging.create_tree(tmp.path(), &bad).is_err());
        assert_eq!(std::fs::read_dir(tmp.path()).expect("read").count(), 0);
    }

    /// In-memory remote tree for [`stage_from_source`].
    struct FakeSource {
        dirs: HashMap<String, Vec<FileEntry>>,
        files: HashMap<String, Vec<u8>>,
    }

    impl FakeSource {
        fn new() -> Self {
            Self {
                dirs: HashMap::new(),
                files: HashMap::new(),
            }
        }

        fn dir(mut self, path: &str, children: Vec<FileEntry>) -> Self {
            self.dirs.insert(path.to_string(), children);
            self
        }

        fn file(mut self, path: &str, data: &[u8]) -> Self {
            self.files.insert(path.to_string(), data.to_vec());
            self
        }
    }

    #[async_trait::async_trait]
    impl StageSource for FakeSource {
        async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String> {
            self.dirs
                .get(path)
                .cloned()
                .ok_or_else(|| format!("no dir {path}"))
        }
        async fn read(&self, path: &str) -> Result<Vec<u8>, String> {
            self.files
                .get(path)
                .cloned()
                .ok_or_else(|| format!("no file {path}"))
        }
    }

    fn remote(path: &str, name: &str, is_directory: bool, size: u64) -> FileEntry {
        FileEntry {
            name: name.to_string(),
            path: path.to_string(),
            is_directory,
            size,
            ..Default::default()
        }
    }

    fn row(path: &str, name: &str, is_directory: bool) -> SessionStageEntry {
        SessionStageEntry {
            path: path.to_string(),
            name: name.to_string(),
            is_directory,
        }
    }

    #[tokio::test]
    async fn stage_copies_files_and_folders_recursively() {
        let source = FakeSource::new()
            .file("/app/a.txt", b"alpha")
            .dir(
                "/app/logs",
                vec![
                    remote("/app/logs/.", ".", true, 0),
                    remote("/app/logs/b.log", "b.log", false, 4),
                    remote("/app/logs/sub", "sub", true, 0),
                ],
            )
            .file("/app/logs/b.log", b"beta")
            .dir(
                "/app/logs/sub",
                vec![remote("/app/logs/sub/c", "c", false, 1)],
            )
            .file("/app/logs/sub/c", b"c");
        let tmp = tempfile::tempdir().expect("tempdir");
        let roots = stage_from_source(
            &source,
            tmp.path(),
            &[row("/app/a.txt", "a.txt", false), row("/app/logs", "logs", true)],
            StageLimits::default(),
        )
        .await
        .expect("stage");
        assert_eq!(roots, vec![tmp.path().join("a.txt"), tmp.path().join("logs")]);
        let read = |p: PathBuf| std::fs::read(p).expect("read");
        assert_eq!(read(tmp.path().join("a.txt")), b"alpha");
        assert_eq!(read(tmp.path().join("logs").join("b.log")), b"beta");
        assert_eq!(read(tmp.path().join("logs").join("sub").join("c")), b"c");
        assert!(!tmp.path().join("logs").join(".").join("x").exists());
    }

    #[tokio::test]
    async fn stage_keeps_hostile_listing_names_inside_the_dir() {
        let source = FakeSource::new()
            .dir(
                "/d",
                vec![
                    remote("/d/x1", "../../escape", false, 1),
                    remote("/d/x2", "/etc/passwd", false, 1),
                    remote("/d/x3", "..", false, 1),
                ],
            )
            .file("/d/x1", b"1")
            .file("/d/x2", b"2")
            .file("/d/x3", b"3");
        let tmp = tempfile::tempdir().expect("tempdir");
        let stage = tmp.path().join("stage");
        std::fs::create_dir(&stage).expect("mkdir");
        stage_from_source(
            &source,
            &stage,
            &[row("/d", "../d", true)],
            StageLimits::default(),
        )
        .await
        .expect("stage");
        let staged_root = stage.join(".._d");
        assert!(staged_root.join(".._.._escape").is_file());
        assert!(staged_root.join("_etc_passwd").is_file());
        // `..` listing entries are skipped, never written.
        assert_eq!(std::fs::read_dir(&staged_root).expect("read").count(), 2);
        assert_eq!(std::fs::read_dir(tmp.path()).expect("read").count(), 1);
    }

    #[tokio::test]
    async fn stage_does_not_follow_symlinked_folders() {
        let mut link = remote("/d/loop", "loop", true, 0);
        link.is_symlink = true;
        let source = FakeSource::new().dir("/d", vec![link]);
        let tmp = tempfile::tempdir().expect("tempdir");
        stage_from_source(&source, tmp.path(), &[row("/d", "d", true)], StageLimits::default())
            .await
            .expect("stage");
        assert!(!tmp.path().join("d").join("loop").exists());
    }

    #[tokio::test]
    async fn stage_enforces_entry_depth_and_byte_limits() {
        let source = FakeSource::new()
            .dir(
                "/d",
                vec![
                    remote("/d/a", "a", false, 3),
                    remote("/d/b", "b", false, 3),
                    remote("/d/s", "s", true, 0),
                ],
            )
            .dir("/d/s", vec![])
            .file("/d/a", b"aaa")
            .file("/d/b", b"bbb")
            .file("/big", b"0123456789");
        let tmp = tempfile::tempdir().expect("tempdir");
        let limits = StageLimits::default();
        let run = |limits: StageLimits, rows: Vec<SessionStageEntry>| {
            let dir = tempfile::tempdir_in(tmp.path()).expect("dir");
            let source = &source;
            async move { stage_from_source(source, dir.path(), &rows, limits).await }
        };
        let few = StageLimits {
            max_entries: 3,
            ..limits
        };
        assert!(run(few, vec![row("/d", "d", true)]).await.is_err());
        let shallow = StageLimits {
            max_depth: 0,
            ..limits
        };
        assert!(run(shallow, vec![row("/d", "d", true)]).await.is_err());
        let small = StageLimits {
            max_bytes: 5,
            ..limits
        };
        // Refused from the listing size hint before the second read...
        assert!(run(small, vec![row("/d", "d", true)]).await.is_err());
        // ...and from the real byte count when no hint exists (a dragged row).
        let err = run(small, vec![row("/big", "big", false)]).await.unwrap_err();
        assert!(err.contains("Download"), "{err}");
        assert!(run(limits, vec![row("/d", "d", true)]).await.is_ok());
    }

    #[tokio::test]
    async fn stage_rejects_empty_requests_and_surfaces_remote_errors() {
        let source = FakeSource::new();
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(
            stage_from_source(&source, tmp.path(), &[], StageLimits::default())
                .await
                .is_err()
        );
        let err = stage_from_source(
            &source,
            tmp.path(),
            &[row("/missing", "missing", false)],
            StageLimits::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("/missing"), "{err}");
    }

    #[test]
    fn drag_result_maps_to_outcome() {
        assert_eq!(
            DragOutResult::from(drag::DragResult::Dropped),
            DragOutResult::Dropped
        );
        assert_eq!(
            DragOutResult::from(drag::DragResult::Cancel),
            DragOutResult::Cancelled
        );
    }
}
