//! Folder copies on the local transfer queue — plan, lay out, and group the
//! per-file transfers of one local folder copy (#3605, follow-up to PARITY-004).
//!
//! A local folder copy (paste / Save-as of a directory in the local file
//! browser, including local ↔ WSL) used to be one blocking recursive copy with
//! no progress, pause or cancel. It now runs in three steps:
//!
//! 1. **Plan** ([`plan_folder_copy`]) — walk the source tree once, *before*
//!    anything is written, into directories, symlinks, small files (copied
//!    directly) and large files (queued, above
//!    [`DIRECT_COPY_MAX_BYTES`](super::local::DIRECT_COPY_MAX_BYTES)). The walk
//!    is bounded by [`FolderCopyLimits`] (entry count, depth, total bytes): a
//!    tree beyond them is refused up front with nothing written, rather than
//!    half-copied. Symlinks are recorded, never followed (so a link loop cannot
//!    recurse), and special files (sockets, FIFOs, devices) are skipped and
//!    reported instead of blocking the copy on a FIFO read.
//! 2. **Lay out** ([`lay_out_folder_copy`]) — recreate the directory tree and
//!    the symlinks at the destination and copy the small files directly.
//!    An existing destination folder is **merged into** (an existing file of the
//!    same name is replaced), matching the previous direct copy and the dual-pane
//!    "Replace existing items?" prompt, whose confirmation means exactly that.
//!    A folder cannot be copied into itself ([`check_not_into_itself`]).
//! 3. **Queue** — the caller enqueues each large file on the local transfer
//!    queue; each runs through [`run_local_transfer_in_group`], so cancelling
//!    any file of the folder cancels the folder's remaining files. Every file
//!    keeps the executor's temp-file + atomic-rename guarantee, so a cancel
//!    never leaves a half-written file under its final name.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::local::{run_local_transfer, should_queue_local_copy};
use super::registry::{TransferHandle, TransferRegistry};
use super::state::TransferStateTag;
use super::{is_queue_teardown, ProgressSink};

/// Most entries (files, folders, symlinks, skipped items) one folder copy may
/// hold. Planning keeps one small record per entry, so this bounds its memory.
pub const MAX_FOLDER_ENTRIES: usize = 50_000;

/// Deepest nesting (in levels below the copied folder) one folder copy may hold.
pub const MAX_FOLDER_DEPTH: usize = 64;

/// Largest total size (in bytes) one folder copy may hold: 512 GiB. A sanity
/// bound against pasting a whole disk by mistake, checked before any write.
pub const MAX_FOLDER_BYTES: u64 = 512 * 1024 * 1024 * 1024;

/// Bounds on one folder copy's source tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FolderCopyLimits {
    /// Most entries the tree may hold.
    pub max_entries: usize,
    /// Deepest nesting below the copied folder.
    pub max_depth: usize,
    /// Largest total size of the tree's regular files.
    pub max_bytes: u64,
}

impl Default for FolderCopyLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_FOLDER_ENTRIES,
            max_depth: MAX_FOLDER_DEPTH,
            max_bytes: MAX_FOLDER_BYTES,
        }
    }
}

/// A regular file of a planned folder copy, relative to the copied folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderFile {
    /// Path relative to the copied folder.
    pub rel: PathBuf,
    /// Size in bytes when planned.
    pub size: u64,
}

/// The source tree of one folder copy, split by how each entry is copied.
/// Every path is relative to the copied folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderCopyPlan {
    /// Directories, parents before their children.
    pub dirs: Vec<PathBuf>,
    /// Symlinks, recreated verbatim (never followed).
    pub symlinks: Vec<PathBuf>,
    /// Files at or below the direct-copy threshold, copied directly.
    pub direct: Vec<FolderFile>,
    /// Files above the direct-copy threshold, run through the transfer queue.
    pub queued: Vec<FolderFile>,
    /// Special files (sockets, FIFOs, devices) that are not copied.
    pub skipped: Vec<PathBuf>,
    /// Total size of all regular files.
    pub total_bytes: u64,
}

/// Why a folder copy could not be planned or laid out.
#[derive(Debug, thiserror::Error)]
pub enum FolderCopyError {
    /// The tree holds more entries than [`FolderCopyLimits::max_entries`].
    #[error("the folder holds more than {0} items")]
    TooManyEntries(usize),
    /// The tree nests deeper than [`FolderCopyLimits::max_depth`].
    #[error("the folder is nested deeper than {0} levels")]
    TooDeep(usize),
    /// The tree's files exceed [`FolderCopyLimits::max_bytes`] in total.
    #[error("the folder is larger than {}", size_label(*.0))]
    TooLarge(u64),
    /// The destination is the source folder or lies inside it.
    #[error("a folder cannot be copied into itself")]
    IntoItself,
    /// A filesystem operation failed.
    #[error("{what} {}: {source}", .path.display())]
    Io {
        /// What was being done.
        what: &'static str,
        /// The path it was done to.
        path: PathBuf,
        /// The underlying error.
        source: std::io::Error,
    },
}

/// `bytes` as whole GiB when at least one, else as bytes (for error text).
fn size_label(bytes: u64) -> String {
    const GIB: u64 = 1024 * 1024 * 1024;
    if bytes >= GIB {
        format!("{} GiB", bytes / GIB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Attach `what` + `path` context to an I/O error.
fn io_err(what: &'static str, path: &Path) -> impl FnOnce(std::io::Error) -> FolderCopyError {
    let path = path.to_path_buf();
    move |source| FolderCopyError::Io { what, path, source }
}

/// Walk the folder `src` into a [`FolderCopyPlan`] within `limits`.
///
/// Children are visited in name order so the plan is deterministic. Symlinks
/// are checked first (the entry's own, non-following file type) and recorded
/// rather than followed. Nothing is written.
pub fn plan_folder_copy(
    src: &Path,
    limits: &FolderCopyLimits,
) -> Result<FolderCopyPlan, FolderCopyError> {
    let mut walk = Walk {
        limits,
        entries: 0,
        plan: FolderCopyPlan::default(),
    };
    walk.visit(src, Path::new(""), 0)?;
    Ok(walk.plan)
}

/// Accumulator for [`plan_folder_copy`]'s depth-first walk.
struct Walk<'a> {
    limits: &'a FolderCopyLimits,
    entries: usize,
    plan: FolderCopyPlan,
}

impl Walk<'_> {
    /// Plan the children of `dir` (at `rel`, `depth` levels below the root).
    fn visit(&mut self, dir: &Path, rel: &Path, depth: usize) -> Result<(), FolderCopyError> {
        let mut children = std::fs::read_dir(dir)
            .map_err(io_err("read folder", dir))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_err("read folder", dir))?;
        children.sort_by_key(|entry| entry.file_name());
        if !children.is_empty() && depth + 1 > self.limits.max_depth {
            return Err(FolderCopyError::TooDeep(self.limits.max_depth));
        }
        for child in children {
            self.entries += 1;
            if self.entries > self.limits.max_entries {
                return Err(FolderCopyError::TooManyEntries(self.limits.max_entries));
            }
            let path = child.path();
            let child_rel = rel.join(child.file_name());
            let file_type = child.file_type().map_err(io_err("inspect", &path))?;
            if file_type.is_symlink() {
                self.plan.symlinks.push(child_rel);
            } else if file_type.is_dir() {
                self.plan.dirs.push(child_rel.clone());
                self.visit(&path, &child_rel, depth + 1)?;
            } else if file_type.is_file() {
                let size = child.metadata().map_err(io_err("inspect", &path))?.len();
                self.add_file(child_rel, size)?;
            } else {
                self.plan.skipped.push(child_rel);
            }
        }
        Ok(())
    }

    /// Record a regular file on the direct or queued side of the threshold.
    fn add_file(&mut self, rel: PathBuf, size: u64) -> Result<(), FolderCopyError> {
        self.plan.total_bytes = self.plan.total_bytes.saturating_add(size);
        if self.plan.total_bytes > self.limits.max_bytes {
            return Err(FolderCopyError::TooLarge(self.limits.max_bytes));
        }
        let file = FolderFile { rel, size };
        if should_queue_local_copy(size) {
            self.plan.queued.push(file);
        } else {
            self.plan.direct.push(file);
        }
        Ok(())
    }
}

/// Refuse a copy of the folder `src` to `dest` when `dest` is `src` itself or
/// lies inside it (the copy would recurse into its own output).
///
/// `dest` need not exist yet: its nearest existing ancestor is resolved and the
/// missing tail appended, so symlinked or `..`-laden spellings still compare
/// correctly.
pub fn check_not_into_itself(src: &Path, dest: &Path) -> Result<(), FolderCopyError> {
    if resolve_maybe_missing(dest).starts_with(resolve_maybe_missing(src)) {
        return Err(FolderCopyError::IntoItself);
    }
    Ok(())
}

/// Resolve `path` via its nearest existing ancestor, appending the missing
/// tail with `.` / `..` applied lexically. Falls back to `path` unchanged.
fn resolve_maybe_missing(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(resolved) = std::fs::canonicalize(existing) {
            let mut out = resolved;
            for part in tail.iter().rev() {
                match part {
                    std::path::Component::ParentDir => {
                        out.pop();
                    }
                    std::path::Component::Normal(name) => out.push(name),
                    _ => {}
                }
            }
            return out;
        }
        match (existing.parent(), existing.components().next_back()) {
            (Some(parent), Some(last)) => {
                tail.push(last);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Recreate `plan`'s directories and symlinks under `dest` and copy its small
/// files directly from `src`, merging into an existing `dest`.
///
/// An existing file is replaced; an existing symlink is replaced by the new
/// link. A non-directory where a directory must go (or a non-symlink where a
/// symlink must go) is an error. The queued files are left to the caller.
pub fn lay_out_folder_copy(
    src: &Path,
    dest: &Path,
    plan: &FolderCopyPlan,
) -> Result<(), FolderCopyError> {
    std::fs::create_dir_all(dest).map_err(io_err("create folder", dest))?;
    for rel in &plan.dirs {
        let dir = dest.join(rel);
        std::fs::create_dir_all(&dir).map_err(io_err("create folder", &dir))?;
    }
    for file in &plan.direct {
        let to = dest.join(&file.rel);
        std::fs::copy(src.join(&file.rel), &to).map_err(io_err("copy", &to))?;
    }
    for rel in &plan.symlinks {
        let to = dest.join(rel);
        remove_existing_symlink(&to)?;
        crate::files::local::copy_symlink(&src.join(rel), &to)
            .map_err(io_err("create symlink", &to))?;
    }
    Ok(())
}

/// Remove a symlink already at `path` so a copied link can take its place.
/// Anything else there is left for the link creation to refuse.
fn remove_existing_symlink(path: &Path) -> Result<(), FolderCopyError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(path)
            // A Windows directory symlink is removed as a directory.
            .or_else(|_| std::fs::remove_dir(path))
            .map_err(io_err("replace symlink", path)),
        _ => Ok(()),
    }
}

/// [`run_local_transfer`] for one queued file of a folder copy, from
/// `start_offset` (non-zero when an app relaunch resumes it, #3613): once it
/// ends, a **cancelled** file cancels the rest of its folder — every id in
/// `group` still registered (queued, active, paused or awaiting a retry).
///
/// Completed siblings are already gone from the registry, so cancelling them is
/// a harmless no-op; the executor's temp + rename keeps every cancelled file's
/// final name untouched. The app-quit teardown sweep already cancels every
/// transfer (and keeps them for the next launch), so it is left alone.
pub async fn run_local_transfer_in_group(
    src: String,
    dest: String,
    handle: Arc<TransferHandle>,
    registry: TransferRegistry,
    sink: ProgressSink,
    group: Arc<[String]>,
    start_offset: u64,
) {
    run_local_transfer(
        src,
        dest,
        handle.clone(),
        registry.clone(),
        sink,
        start_offset,
    )
    .await;
    if handle.state().tag() != TransferStateTag::Cancelled || is_queue_teardown() {
        return;
    }
    for id in group.iter().filter(|id| **id != handle.transfer_id) {
        registry.cancel(id);
    }
}

#[cfg(test)]
#[path = "local_folder_tests.rs"]
mod tests;
