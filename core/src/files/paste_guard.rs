//! Refuse a same-session paste of a file onto itself, or of a folder into
//! itself, on the paths that do not go through [`FileBrowser::copy`] (#5330).
//!
//! A same-session paste is not always a same-backend copy. A file pasted
//! between two streaming ends of one session runs through the remote→remote
//! executor (`core::files::transfer::remote_copy`), which
//! creates (truncates) the destination before it reads the source. When both
//! are the same file, the source is emptied while it is read. A byte-based
//! folder paste (FTP, agents) lists the source and then creates the
//! destination folder, so a destination inside the source is a snapshot of
//! the source copied into itself, and a cut of that shape deletes the source
//! together with its new copy.
//!
//! The frontend's path check is textual, so it misses a symlink alias, a
//! `..` and a respelled path. This module resolves both paths **on the
//! backend** and refuses the paste before anything is written:
//!
//! - SFTP: the server's `realpath`.
//! - Docker: `readlink -f` / `pwd -P` inside the container.
//! - A backend with a [`PathCanonicalizer`] (#5333): the local filesystem's
//!   `canonicalize`, FTP's `CWD` + `PWD`, and an agent-hosted session's
//!   `connection.files.realpath`, which resolves on the agent host.
//! - Every other backend, and a canonicalizer that cannot resolve a path (an
//!   agent from before `connection.files.realpath`, an FTP server without
//!   `PWD`): a lexical normalisation of `.`, `..` and repeated slashes.
//!
//! A destination that does not exist yet resolves through its parent folder.
//! A path SFTP or Docker cannot resolve is not a refusal: the paste then
//! fails with its own, more specific error. For a canonicalizer, the lexical
//! check stays the floor: when either path does not resolve, both compare
//! lexically, exactly as before #5333.
//!
//! The wording is [`copy_guard`](crate::files::copy_guard)'s, shared with the
//! same-backend copy guards of #5320 and #5325.

use std::future::Future;
use std::path::Path;
#[cfg(feature = "local-transfer")]
use std::sync::Arc;

use crate::errors::FileError;
use crate::files::FileBrowser;

#[cfg(feature = "local-transfer")]
use crate::files::transfer::ranged::RangedTransferTarget;

#[cfg(feature = "docker")]
use crate::backends::docker::DockerTransferTarget;
#[cfg(feature = "ssh")]
use crate::backends::ssh::SftpFileBrowser;

pub use crate::files::copy_guard::{copy_conflict, copy_refused, INSIDE_SOURCE, SAME_FILE};

/// A backend that resolves a path to its real spelling (#5333): symlinks
/// followed, `.` and `..` applied, as the backend's host sees them.
///
/// A path whose final name does not exist yet (a copy destination) resolves
/// through its parent folder, with the name appended. A backend that cannot
/// resolve answers [`FileError::NotSupported`]; a path that does not resolve
/// answers its own error. Either way the paste guard then compares lexically.
#[async_trait::async_trait]
pub trait PathCanonicalizer: Send + Sync {
    /// The real spelling of `path` on this backend.
    async fn realpath(&self, path: &str) -> Result<String, FileError>;
}

/// Resolve `.`, `..` and repeated or trailing slashes of a POSIX path
/// without asking the backend. An absolute path stays absolute (`..` stops
/// at the root). A relative path stays relative and keeps a leading `..`
/// that cannot be resolved.
pub fn normalize_lexically(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => match parts.last() {
                Some(&last) if last != ".." => {
                    parts.pop();
                }
                _ if absolute => {}
                _ => parts.push(".."),
            },
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_string(),
        (false, false) => joined,
    }
}

/// Split a path into its parent folder and final name.
fn split_parent(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (".", trimmed),
    }
}

/// Resolve `path` with `canon`. When `canon` cannot resolve it (a copy
/// destination that does not exist yet), resolve its parent folder and
/// append the final name. `None` when neither resolves.
pub async fn resolve_through_parent<F, Fut>(path: &str, canon: F) -> Option<String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    if let Some(resolved) = canon(path.to_string()).await {
        return Some(resolved);
    }
    let (parent, name) = split_parent(path);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let parent = canon(parent.to_string()).await?;
    Some(if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    })
}

/// Refuse a copy of `src` to `dest` when the two resolve, through `resolve`,
/// to the same entry, or when the folder `src` would be copied into its own
/// subtree. A path that does not resolve is not a refusal.
pub async fn check_resolved<F, Fut>(
    src: &str,
    dest: &str,
    src_is_dir: bool,
    resolve: F,
) -> Result<(), FileError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let Some(src_resolved) = resolve(src.to_string()).await else {
        return Ok(());
    };
    let Some(dest_resolved) = resolve(dest.to_string()).await else {
        return Ok(());
    };
    match copy_conflict(&src_resolved, &dest_resolved, src_is_dir) {
        Some(reason) => Err(copy_refused(src, dest, reason)),
        None => Ok(()),
    }
}

/// Refuse a copy of `src` to `dest` when the two conflict ([`copy_conflict`])
/// as `realpath` resolves them, before anything is written (#5333).
///
/// The lexical check is the floor: when `realpath` cannot resolve either
/// path (an older agent, a server without the primitive, a transient
/// failure), both compare by [`normalize_lexically`] instead. A backend that
/// resolves can only see more than the lexical check, never less.
pub async fn check_real_or_lexical<F, Fut>(
    src: &str,
    dest: &str,
    src_is_dir: bool,
    realpath: F,
) -> Result<(), FileError>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<String, FileError>>,
{
    let resolved = match realpath(src.to_string()).await {
        Ok(real_src) => match realpath(dest.to_string()).await {
            Ok(real_dest) => Some((real_src, real_dest)),
            Err(_) => None,
        },
        Err(_) => None,
    };
    let (src_resolved, dest_resolved) =
        resolved.unwrap_or_else(|| (normalize_lexically(src), normalize_lexically(dest)));
    match copy_conflict(&src_resolved, &dest_resolved, src_is_dir) {
        Some(reason) => Err(copy_refused(src, dest, reason)),
        None => Ok(()),
    }
}

/// The real spelling of the local `path` (#5333): `~` expanded, symlinks,
/// `.` and `..` resolved, a missing final name through its parent folder.
///
/// On Windows the separators come back as `/`, so a folder's subtree compares
/// the same way as on every other backend ([`copy_conflict`]).
pub async fn local_realpath(path: &str) -> Result<String, FileError> {
    let expanded = crate::config::expand_tilde_only(path);
    let resolved = resolve_through_parent(&expanded, |p| async move {
        tokio::task::spawn_blocking(move || std::fs::canonicalize(Path::new(&p)).ok())
            .await
            .ok()
            .flatten()
            .map(|real| portable_spelling(&real.to_string_lossy()))
    })
    .await;
    resolved.ok_or_else(|| FileError::NotFound(format!("cannot resolve {path}")))
}

/// A canonical local path with `/` separators. On Windows the verbatim
/// `\\?\` prefix `canonicalize` adds is dropped too.
#[cfg(windows)]
fn portable_spelling(path: &str) -> String {
    path.strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/")
}

/// A canonical local path, unchanged: it already uses `/`.
#[cfg(not(windows))]
fn portable_spelling(path: &str) -> String {
    path.to_string()
}

/// How a session's backend resolves a path to its real spelling. Owned, so a
/// caller can let go of the session before the (remote) lookups run.
#[derive(Clone)]
pub enum PathResolver {
    /// The SFTP server's `realpath`.
    #[cfg(feature = "ssh")]
    Sftp(Box<SftpFileBrowser>),
    /// `readlink -f` / `pwd -P` inside the container.
    #[cfg(feature = "docker")]
    Docker(DockerTransferTarget),
    /// A ranged (agent-hosted) end: its
    /// [`realpath`](RangedTransferTarget::realpath), with the lexical check as
    /// the floor ([`check_real_or_lexical`], #5333).
    #[cfg(feature = "local-transfer")]
    Ranged(Arc<dyn RangedTransferTarget>),
    /// No backend lookup: `.`, `..` and slashes only ([`normalize_lexically`]).
    Lexical,
}

impl std::fmt::Debug for PathResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            #[cfg(feature = "ssh")]
            PathResolver::Sftp(_) => "Sftp",
            #[cfg(feature = "docker")]
            PathResolver::Docker(_) => "Docker",
            #[cfg(feature = "local-transfer")]
            PathResolver::Ranged(_) => "Ranged",
            PathResolver::Lexical => "Lexical",
        })
    }
}

impl PathResolver {
    /// The owned resolver of the backend behind `browser`: SFTP and Docker
    /// resolve on the backend, every other backend lexically. A borrowed
    /// [`PathCanonicalizer`] is not captured here: [`ensure_paste_allowed`]
    /// and [`real_path`] use it.
    pub fn of_browser(browser: &dyn FileBrowser) -> Self {
        #[cfg(feature = "ssh")]
        if let Some(sftp) = browser
            .as_any()
            .and_then(|any| any.downcast_ref::<SftpFileBrowser>())
        {
            return PathResolver::Sftp(Box::new(sftp.clone()));
        }
        #[cfg(feature = "docker")]
        if let Some(target) = crate::backends::docker::docker_transfer_target_of(browser) {
            return PathResolver::Docker(target);
        }
        let _ = browser;
        PathResolver::Lexical
    }

    /// The real spelling of `path` on this backend (a missing final name
    /// resolves through its parent), or `None` when it cannot be resolved. A
    /// ranged end that cannot resolve, and the lexical resolver, answer the
    /// lexical spelling.
    pub async fn resolve(&self, path: &str) -> Option<String> {
        match self {
            #[cfg(feature = "ssh")]
            PathResolver::Sftp(sftp) => {
                use crate::backends::ssh::SftpAdvancedOps;
                resolve_through_parent(path, |p| async move { sftp.realpath(&p).await.ok() }).await
            }
            #[cfg(feature = "docker")]
            PathResolver::Docker(target) => target.resolve_path(path).await,
            #[cfg(feature = "local-transfer")]
            PathResolver::Ranged(target) => Some(
                target
                    .realpath(path)
                    .await
                    .unwrap_or_else(|_| normalize_lexically(path)),
            ),
            PathResolver::Lexical => Some(normalize_lexically(path)),
        }
    }

    /// Refuse a copy of `src` onto itself, or of the folder `src` into its
    /// own subtree, on this backend. See [`check_resolved`] and, for a ranged
    /// end, [`check_real_or_lexical`].
    pub async fn ensure_copy_allowed(
        &self,
        src: &str,
        dest: &str,
        src_is_dir: bool,
    ) -> Result<(), FileError> {
        #[cfg(feature = "local-transfer")]
        if let PathResolver::Ranged(target) = self {
            return check_real_or_lexical(src, dest, src_is_dir, |p| async move {
                target.realpath(&p).await
            })
            .await;
        }
        check_resolved(
            src,
            dest,
            src_is_dir,
            |p| async move { self.resolve(&p).await },
        )
        .await
    }
}

/// Everything [`ensure_paste_allowed`] and [`real_path`] need from a
/// browser, taken up front: the owned [`PathResolver`] and the borrowed
/// [`PathCanonicalizer`]. It never holds `browser` itself, so its futures are
/// `Send` even for a browser that is not `Sync`, and a caller can still use
/// the browser (to `stat` the source) before it awaits the check.
pub struct BrowserResolver<'a> {
    resolver: PathResolver,
    canon: Option<&'a dyn PathCanonicalizer>,
}

impl<'a> BrowserResolver<'a> {
    /// The resolver of the backend behind `browser`: SFTP and Docker through
    /// [`PathResolver::of_browser`], a browser with a [`PathCanonicalizer`]
    /// through it, every other browser lexically.
    pub fn of(browser: &'a dyn FileBrowser) -> Self {
        let resolver = PathResolver::of_browser(browser);
        let canon = if matches!(resolver, PathResolver::Lexical) {
            browser.path_canonicalizer()
        } else {
            None
        };
        Self { resolver, canon }
    }

    /// Refuse a same-session paste of `src` onto itself, or of the folder
    /// `src` into its own subtree. A canonicalizer resolves both paths with
    /// the lexical check as the floor ([`check_real_or_lexical`], #5333).
    pub async fn ensure_copy_allowed(
        &self,
        src: &str,
        dest: &str,
        src_is_dir: bool,
    ) -> Result<(), FileError> {
        match self.canon {
            Some(canon) => {
                check_real_or_lexical(src, dest, src_is_dir, |p| async move {
                    canon.realpath(&p).await
                })
                .await
            }
            None => {
                self.resolver
                    .ensure_copy_allowed(src, dest, src_is_dir)
                    .await
            }
        }
    }

    /// The real spelling of `path`, a missing final name resolved through its
    /// parent folder (#5333). [`FileError::NotSupported`] when the backend
    /// has no way to resolve a path; [`FileError::NotFound`] when neither the
    /// path nor its parent resolves.
    pub async fn real_path(&self, path: &str) -> Result<String, FileError> {
        if let Some(canon) = self.canon {
            return canon.realpath(path).await;
        }
        if matches!(self.resolver, PathResolver::Lexical) {
            return Err(FileError::NotSupported);
        }
        self.resolver
            .resolve(path)
            .await
            .ok_or_else(|| FileError::NotFound(format!("cannot resolve {path}")))
    }
}

/// Refuse a same-session paste of `src` onto itself, or of the folder `src`
/// into its own subtree, with both paths resolved on `browser`'s backend. See
/// [`BrowserResolver::ensure_copy_allowed`]. Like [`real_path`], the
/// returned future does not borrow `browser`.
pub fn ensure_paste_allowed<'a>(
    browser: &'a dyn FileBrowser,
    src: &'a str,
    dest: &'a str,
    src_is_dir: bool,
) -> impl Future<Output = Result<(), FileError>> + Send + 'a {
    let resolver = BrowserResolver::of(browser);
    async move { resolver.ensure_copy_allowed(src, dest, src_is_dir).await }
}

/// The real spelling of `path` on `browser`'s backend: what an agent answers
/// `connection.files.realpath` with. See [`BrowserResolver::real_path`].
///
/// The returned future does not borrow `browser`, so it is `Send` even for a
/// browser that is not `Sync`.
pub fn real_path<'a>(
    browser: &'a dyn FileBrowser,
    path: &'a str,
) -> impl Future<Output = Result<String, FileError>> + Send + 'a {
    let resolver = BrowserResolver::of(browser);
    async move { resolver.real_path(path).await }
}

#[cfg(test)]
#[path = "paste_guard_tests.rs"]
mod tests;
