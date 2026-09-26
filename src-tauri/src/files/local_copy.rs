//! Desktop side of a user-visible local copy (PARITY-004 #3567, folders #3605):
//! route a file or a folder onto the direct path or the local transfer queue.
//!
//! - A **file** at or below the direct-copy threshold is copied directly; a
//!   larger one is enqueued under the reserved local session and copied in the
//!   background with progress, pause/resume, cancel and retry.
//! - A **folder** is planned once (bounded walk), its directories, symlinks and
//!   small files laid out directly (merging into an existing destination), and
//!   each large file enqueued as its own Transfer Queue row. The folder's rows
//!   form a group: cancelling one cancels the rest
//!   ([`run_local_transfer_in_group`](termihub_core::files::transfer::local_folder::run_local_transfer_in_group)).
//!
//! The core planning/layout/grouping lives in
//! `termihub_core::files::transfer::local_folder`; this module only wires it to
//! the registry, persistence and the `transfer-progress` event sink.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use termihub_core::files::transfer::local_folder::{
    self, FolderCopyError, FolderCopyLimits, FolderCopyPlan,
};
use tracing::debug;

use crate::files::transfer::registry::{TransferHandle, TransferRegistry};
use crate::files::transfer::{self, local, TransferDirection};
use crate::utils::errors::TerminalError;

/// What `local_copy_start` started.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCopyStarted {
    /// Transfer Queue ids of the files copied in the background, empty when the
    /// whole copy finished directly.
    pub transfer_ids: Vec<String>,
    /// Items of a folder that were not copied (special files such as sockets,
    /// FIFOs and devices), as paths relative to the copied folder.
    pub skipped: Vec<String>,
}

/// Turn a folder-copy error into the command's error, keeping its message.
fn folder_error(e: FolderCopyError) -> TerminalError {
    let kind = match &e {
        FolderCopyError::Io { source, .. } => source.kind(),
        _ => std::io::ErrorKind::Other,
    };
    TerminalError::Io(std::io::Error::new(kind, e.to_string()))
}

/// Run blocking filesystem work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, TerminalError> + Send + 'static,
) -> Result<T, TerminalError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| TerminalError::Io(std::io::Error::other(e.to_string())))?
}

/// Register a queued local copy of `src` → `dest` (`size` bytes) with the
/// registry and, when present, the persisted queue; returns its id + handle.
fn enqueue(
    registry: &TransferRegistry,
    app_handle: &tauri::AppHandle,
    src: &str,
    dest: &str,
    size: u64,
) -> (String, Arc<TransferHandle>) {
    let transfer_id = uuid::Uuid::new_v4().to_string();
    debug!(transfer_id, src, dest, "Local copy (queued)");
    let file_name = crate::utils::fs::file_name_of(src);
    let handle = registry.enqueue(
        &transfer_id,
        local::LOCAL_TRANSFER_SESSION,
        TransferDirection::Download,
        &file_name,
        src,
        size,
    );
    if let Some(pm) = app_handle.try_state::<transfer::TransferPersistenceManager>() {
        pm.record_registration(
            &transfer_id,
            local::LOCAL_TRANSFER_SESSION,
            TransferDirection::Download,
            &file_name,
            src,
            Some(dest.to_string()),
            size,
        );
    }
    (transfer_id, handle)
}

/// Start a local copy of `src_path` to `dest_path` (see the module docs).
pub async fn start(
    src_path: String,
    dest_path: String,
    registry: &TransferRegistry,
    app_handle: &tauri::AppHandle,
) -> Result<LocalCopyStarted, TerminalError> {
    let meta = tokio::fs::metadata(&src_path)
        .await
        .map_err(TerminalError::Io)?;
    if meta.is_dir() {
        return start_folder(src_path, dest_path, registry, app_handle).await;
    }
    if !local::should_queue_local_copy(meta.len()) {
        debug!(src_path, dest_path, "Local copy (direct)");
        blocking(move || crate::files::local::copy_file(&src_path, &dest_path, false)).await?;
        return Ok(LocalCopyStarted::default());
    }
    let (transfer_id, handle) = enqueue(registry, app_handle, &src_path, &dest_path, meta.len());
    let registry = registry.clone();
    let sink = transfer::app_progress_sink(app_handle.clone());
    tauri::async_runtime::spawn(async move {
        local::run_local_transfer(src_path, dest_path, handle, registry, sink, 0).await;
    });
    Ok(LocalCopyStarted {
        transfer_ids: vec![transfer_id],
        skipped: Vec::new(),
    })
}

/// Plan the folder `src` and lay out everything but its large files at `dest`
/// (blocking). Nothing is written when the plan is refused.
fn plan_and_lay_out(src: &Path, dest: &Path) -> Result<FolderCopyPlan, TerminalError> {
    local_folder::check_not_into_itself(src, dest).map_err(folder_error)?;
    let plan =
        local_folder::plan_folder_copy(src, &FolderCopyLimits::default()).map_err(folder_error)?;
    local_folder::lay_out_folder_copy(src, dest, &plan).map_err(folder_error)?;
    Ok(plan)
}

/// A path relative to the copied folder, `/`-separated for display.
fn display_rel(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// Copy the folder `src_path` to `dest_path`: lay it out directly, then queue
/// each large file as one member of the folder's cancel group.
async fn start_folder(
    src_path: String,
    dest_path: String,
    registry: &TransferRegistry,
    app_handle: &tauri::AppHandle,
) -> Result<LocalCopyStarted, TerminalError> {
    let (src, dest) = (PathBuf::from(&src_path), PathBuf::from(&dest_path));
    let plan = {
        let (src, dest) = (src.clone(), dest.clone());
        blocking(move || plan_and_lay_out(&src, &dest)).await?
    };
    debug!(
        src_path,
        dest_path,
        direct = plan.direct.len(),
        queued = plan.queued.len(),
        skipped = plan.skipped.len(),
        "Local folder copy"
    );
    let jobs: Vec<(String, String, Arc<TransferHandle>)> = plan
        .queued
        .iter()
        .map(|file| {
            let from = src.join(&file.rel).to_string_lossy().into_owned();
            let to = dest.join(&file.rel).to_string_lossy().into_owned();
            let (_, handle) = enqueue(registry, app_handle, &from, &to, file.size);
            (from, to, handle)
        })
        .collect();
    let transfer_ids: Vec<String> = jobs.iter().map(|(_, _, h)| h.transfer_id.clone()).collect();
    let group: Arc<[String]> = Arc::from(transfer_ids.clone());
    for (from, to, handle) in jobs {
        let (registry, group) = (registry.clone(), group.clone());
        let sink = transfer::app_progress_sink(app_handle.clone());
        tauri::async_runtime::spawn(async move {
            local_folder::run_local_transfer_in_group(from, to, handle, registry, sink, group)
                .await;
        });
    }
    Ok(LocalCopyStarted {
        transfer_ids,
        skipped: plan.skipped.iter().map(|rel| display_rel(rel)).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_and_lay_out_copies_small_files_and_leaves_large_ones_queued() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("sub")).expect("mkdir");
        std::fs::write(src.join("sub/small.txt"), b"hi").expect("write");
        let big = std::fs::File::create(src.join("big.bin")).expect("create");
        big.set_len(local::DIRECT_COPY_MAX_BYTES + 1)
            .expect("set_len");
        let dest = dir.path().join("dest");

        let plan = plan_and_lay_out(&src, &dest).expect("plan");

        assert_eq!(
            std::fs::read(dest.join("sub/small.txt")).expect("read"),
            b"hi"
        );
        assert_eq!(plan.queued.len(), 1);
        assert!(!dest.join("big.bin").exists());
    }

    #[test]
    fn plan_and_lay_out_refuses_a_copy_into_itself_without_writing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("src");
        std::fs::create_dir_all(&src).expect("mkdir");
        let dest = src.join("copy");

        let err = plan_and_lay_out(&src, &dest).expect_err("into itself");

        assert!(err.to_string().contains("into itself"), "{err}");
        assert!(!dest.exists());
    }

    #[test]
    fn folder_rel_paths_display_with_forward_slashes() {
        assert_eq!(display_rel(Path::new("a").join("b").as_path()), "a/b");
    }
}
