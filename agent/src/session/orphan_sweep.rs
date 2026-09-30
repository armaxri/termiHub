//! One-time sweep of pre-existing orphan session files (#2807, AGT-019
//! follow-up).
//!
//! Session recovery reclaims a dead session's `session-<id>.sock` /
//! `-agent.sock` / `-ki.sock` / `.log` at the point it drops the session's
//! `state.json` entry (AGT-019), so no *new* orphans are created. Files whose
//! state entry was lost too (the AGT-017 compounding case) have nothing for
//! recovery to iterate, so they would linger forever. This module finds them.
//!
//! It is only the **filesystem** half: [`scan`] groups the session files in a
//! directory by session id and drops ids that are excluded (known to state, held
//! in memory, being created) or too young to judge. Deciding which remaining
//! candidates are dead — with a recovery-intent probe, never a bare connect —
//! and reclaiming them is [`SessionManager::sweep_orphan_session_files`].
//!
//! The directory is injected ([`OrphanSweepConfig`]) rather than hard-wired to
//! the shared per-user socket dir, so a test sweeps a private directory and can
//! never probe a sibling test's live socket.
//!
//! [`SessionManager::sweep_orphan_session_files`]:
//! crate::session::manager::SessionManager::sweep_orphan_session_files

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How old every file of a session must be before the sweep may judge it.
///
/// A create is not atomic on disk: the launcher opens the daemon log, the
/// worker may bind the ssh-agent / prompt relay sockets, the daemon binds its
/// socket, and only then does the worker persist the `state.json` entry. A
/// session caught in that window looks exactly like an orphan, and probing it
/// could even race the creating worker's own attach. Every such window is
/// bounded by the create's connect timeout (seconds), so anything younger than
/// this is left alone — a real orphan is simply reclaimed by a later sweep.
///
/// Unix-only: its sole user is [`default_config`], and windows has no sweep.
#[cfg(unix)]
pub const DEFAULT_MIN_AGE: Duration = Duration::from_secs(10 * 60);

/// Where the sweep looks and how old a session's files must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanSweepConfig {
    /// The directory holding the per-session socket and log files.
    pub dir: PathBuf,
    /// Minimum age of **every** file of a session before it is considered.
    pub min_age: Duration,
}

/// The production sweep: the per-user socket dir, with `DEFAULT_MIN_AGE` (unix only).
///
/// `None` on windows, where a session's named pipes vanish with its daemon and
/// no files are left to reclaim (AGT-019 is unix-only).
pub fn default_config() -> Option<OrphanSweepConfig> {
    #[cfg(unix)]
    {
        Some(OrphanSweepConfig {
            dir: crate::daemon::transport::socket_dir(),
            min_age: DEFAULT_MIN_AGE,
        })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// What one sweep did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OrphanSweepReport {
    /// Ids whose daemon was dead; their files were removed.
    pub removed: Vec<String>,
    /// Ids whose daemon answered the probe (free or held by a peer); kept.
    pub kept_live: Vec<String>,
}

/// One session's files found by [`scan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanCandidate {
    /// The session id embedded in the file names.
    pub id: String,
    /// The daemon socket (`session-<id>.sock`), when present.
    pub socket: Option<PathBuf>,
    /// Every file of this session found in the directory, socket included.
    pub files: Vec<PathBuf>,
}

/// Session-file suffixes, most specific first so `-agent.sock` is never read as
/// `.sock` with an id ending in `-agent`.
const SUFFIXES: [&str; 4] = ["-agent.sock", "-ki.sock", ".sock", ".log"];
const PREFIX: &str = "session-";
const SOCKET_SUFFIX: &str = ".sock";

/// Parse a session file name into its session id and suffix, or `None` for
/// anything that is not a per-session file (the registry's files, strays).
fn parse(file_name: &str) -> Option<(&str, &'static str)> {
    let rest = file_name.strip_prefix(PREFIX)?;
    SUFFIXES.iter().find_map(|suffix| {
        rest.strip_suffix(suffix)
            .filter(|id| !id.is_empty())
            .map(|id| (id, *suffix))
    })
}

/// Group the session files in `dir` by id, keeping only ids that are not in
/// `exclude` and whose files are all at least `min_age` old (as of `now`).
///
/// Symlinks and directories are skipped. An unreadable directory (e.g. it does
/// not exist yet) yields no candidates. Candidates are sorted by id.
pub fn scan(
    dir: &Path,
    exclude: &HashSet<String>,
    min_age: Duration,
    now: SystemTime,
) -> Vec<OrphanCandidate> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    // id → (files, socket, all files old enough)
    let mut groups: BTreeMap<String, (Vec<PathBuf>, Option<PathBuf>, bool)> = BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some((id, suffix)) = name.to_str().and_then(parse) else {
            continue;
        };
        if exclude.contains(id) {
            continue;
        }
        // `DirEntry::metadata` does not follow symlinks.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() || meta.is_dir() {
            continue;
        }
        // An unknown mtime cannot prove the file is old: treat it as young.
        let old_enough = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= min_age)
            || min_age.is_zero();
        let path = entry.path();
        let group = groups
            .entry(id.to_string())
            .or_insert_with(|| (Vec::new(), None, true));
        if suffix == SOCKET_SUFFIX {
            group.1 = Some(path.clone());
        }
        group.0.push(path);
        group.2 &= old_enough;
    }
    groups
        .into_iter()
        .filter(|(_, (_, _, old_enough))| *old_enough)
        .map(|(id, (mut files, socket, _))| {
            files.sort();
            OrphanCandidate { id, socket, files }
        })
        .collect()
}

/// Remove a dead candidate's files. Best-effort: a file already gone is fine.
pub fn remove(candidate: &OrphanCandidate) {
    for file in &candidate.files {
        let _ = std::fs::remove_file(file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_recognises_every_session_file_kind() {
        assert_eq!(parse("session-abc.sock"), Some(("abc", ".sock")));
        assert_eq!(parse("session-abc.log"), Some(("abc", ".log")));
        assert_eq!(
            parse("session-abc-agent.sock"),
            Some(("abc", "-agent.sock"))
        );
        assert_eq!(parse("session-abc-ki.sock"), Some(("abc", "-ki.sock")));
        assert_eq!(
            parse("session-1b4e28ba-2fa1-11d2-883f-0016d3cca427.sock"),
            Some(("1b4e28ba-2fa1-11d2-883f-0016d3cca427", ".sock"))
        );
    }

    #[test]
    fn parse_rejects_non_session_files() {
        for name in [
            "registry.sock",
            "registry.log",
            "session-.sock",
            "session-.log",
            "session-abc.txt",
            "xsession-abc.sock",
            "session-abc.sock.bak",
        ] {
            assert_eq!(parse(name), None, "{name}");
        }
    }

    fn touch(path: &Path, age: Duration) {
        let f = std::fs::File::create(path).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn scan_groups_files_and_applies_exclusions_and_age() {
        let dir = tempfile::tempdir().unwrap();
        let old = Duration::from_secs(3600);
        let d = dir.path();
        touch(&d.join("session-a.sock"), old);
        touch(&d.join("session-a-agent.sock"), old);
        touch(&d.join("session-a.log"), old);
        touch(&d.join("session-b.log"), old);
        touch(&d.join("session-known.sock"), old);
        touch(&d.join("session-young.log"), old);
        touch(&d.join("session-young.sock"), Duration::ZERO);
        touch(&d.join("registry.sock"), old);
        std::fs::create_dir(d.join("session-dir.sock")).unwrap();

        let exclude: HashSet<String> = ["known".to_string()].into();
        let got = scan(d, &exclude, Duration::from_secs(60), SystemTime::now());

        assert_eq!(
            got,
            vec![
                OrphanCandidate {
                    id: "a".into(),
                    socket: Some(d.join("session-a.sock")),
                    files: vec![
                        d.join("session-a-agent.sock"),
                        d.join("session-a.log"),
                        d.join("session-a.sock"),
                    ],
                },
                OrphanCandidate {
                    id: "b".into(),
                    socket: None,
                    files: vec![d.join("session-b.log")],
                },
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_skips_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        touch(&target, Duration::from_secs(3600));
        std::os::unix::fs::symlink(&target, dir.path().join("session-s.log")).unwrap();
        let got = scan(
            dir.path(),
            &HashSet::new(),
            Duration::ZERO,
            SystemTime::now(),
        );
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn scan_of_a_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let got = scan(
            &dir.path().join("absent"),
            &HashSet::new(),
            Duration::ZERO,
            SystemTime::now(),
        );
        assert!(got.is_empty());
    }

    #[test]
    fn remove_deletes_only_the_candidate_files() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        touch(&d.join("session-a.sock"), Duration::ZERO);
        touch(&d.join("session-a.log"), Duration::ZERO);
        touch(&d.join("session-b.log"), Duration::ZERO);
        remove(&OrphanCandidate {
            id: "a".into(),
            socket: Some(d.join("session-a.sock")),
            files: vec![d.join("session-a.sock"), d.join("session-a.log")],
        });
        assert!(!d.join("session-a.sock").exists());
        assert!(!d.join("session-a.log").exists());
        assert!(d.join("session-b.log").exists());
    }
}
