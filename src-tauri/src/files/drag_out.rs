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

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tracing::{debug, warn};

/// The most entries one drag-out may carry. Generous for a real multi-selection,
/// small enough that a runaway request cannot build a huge pasteboard.
pub const MAX_DRAG_OUT_PATHS: usize = 1000;

/// Staging directories older than this are presumed abandoned (a crash skipped
/// teardown) and are swept on the next staging request.
pub const STALE_STAGING_AGE: Duration = Duration::from_secs(24 * 60 * 60);

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

/// Map each requested name to a unique sanitized file name, suffixing
/// ` (2)`, ` (3)`, ... when two names collapse to the same component.
pub fn unique_staged_names(names: &[String]) -> Vec<String> {
    let mut used: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|name| {
            let base = sanitize_staged_name(name);
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
        })
        .collect()
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
    /// path for each of `names` inside it.
    pub fn create(&self, root: &Path, names: &[String]) -> Result<StagingDir, String> {
        if names.is_empty() {
            return Err("nothing to stage".to_string());
        }
        if names.len() > MAX_DRAG_OUT_PATHS {
            return Err(format!(
                "too many entries to stage ({} > {MAX_DRAG_OUT_PATHS})",
                names.len()
            ));
        }
        create_private_dir(root).map_err(|e| format!("could not create staging root: {e}"))?;
        self.sweep_once(root);
        let dir = root.join(format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        create_private_dir(&dir).map_err(|e| format!("could not create staging dir: {e}"))?;
        if let Ok(mut owned) = self.owned.lock() {
            owned.insert(dir.clone());
        }
        let paths = unique_staged_names(names)
            .into_iter()
            .map(|name| dir.join(name).to_string_lossy().into_owned())
            .collect();
        debug!(dir = %dir.display(), "Created drag-out staging dir");
        Ok(StagingDir {
            dir: dir.to_string_lossy().into_owned(),
            paths,
        })
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
