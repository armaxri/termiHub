use std::fs;
use std::io::Write;

use tracing_subscriber::fmt::MakeWriter;

use super::*;

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn each_role_writes_its_own_per_process_file() {
    let dir = tempfile::tempdir().unwrap();
    let pid = std::process::id();

    let daemon = open_in(dir.path(), AgentRole::Daemon).unwrap();
    let registry = open_in(dir.path(), AgentRole::Registry).unwrap();
    daemon.make_writer().write_all(b"daemon line\n").unwrap();
    registry
        .make_writer()
        .write_all(b"registry line\n")
        .unwrap();

    let daemon_file = dir.path().join(format!("termihub-agent-daemon-{pid}.log"));
    let registry_file = dir
        .path()
        .join(format!("termihub-agent-registry-{pid}.log"));
    assert_eq!(fs::read_to_string(daemon_file).unwrap(), "daemon line\n");
    assert_eq!(
        fs::read_to_string(registry_file).unwrap(),
        "registry line\n"
    );
}

#[test]
fn concurrent_agent_processes_never_share_or_lose_lines() {
    // OBS2-002 regression: the roles of several processes write and rotate at
    // the same time. Per-process files mean no process's rotation can move
    // another's live file, so each one's newest lines are all in its own file.
    let dir = tempfile::tempdir().unwrap();
    let writers: Vec<RotatingLogFile> = (0..4)
        .map(|pid| {
            RotatingLogFile::new(
                dir.path(),
                &shared::per_process_stem(LOG_FAMILY, "daemon", pid),
                256,
                3,
            )
            .unwrap()
            .with_family_budget(family_budget())
        })
        .collect();

    for i in 0..200 {
        for (pid, w) in writers.iter().enumerate() {
            w.make_writer()
                .write_all(format!("pid{pid} line {i:04}\n").as_bytes())
                .unwrap();
        }
    }

    for (pid, w) in writers.iter().enumerate() {
        let live = fs::read_to_string(w.path()).unwrap();
        assert!(
            live.ends_with(&format!("pid{pid} line 0199\n")),
            "pid{pid}'s newest line is missing from its live file"
        );
        assert!(
            live.lines().all(|l| l.starts_with(&format!("pid{pid} "))),
            "pid{pid}'s file holds another process's lines"
        );
    }
}

#[test]
fn the_family_budget_prunes_old_processes_files() {
    let dir = tempfile::tempdir().unwrap();
    // A stale file from a long-gone process, far over the family budget.
    let stale = dir.path().join("termihub-agent-stdio-1.log");
    fs::write(&stale, vec![b'x'; (FAMILY_MAX_BYTES + 1) as usize]).unwrap();

    let _log = open_in(dir.path(), AgentRole::Stdio).unwrap();

    assert!(!stale.exists(), "an over-budget stale file must be pruned");
}

#[test]
fn stderr_capture_files_are_named_by_role() {
    assert_eq!(
        daemon_stderr_name("abc"),
        "termihub-agent-stderr-daemon-abc.log"
    );
    assert_eq!(registry_stderr_name(), "termihub-agent-stderr-registry.log");
}

#[test]
fn the_daemon_stderr_capture_appends_and_is_capped() {
    // OBS2-007: the capture file keeps the previous run's output (it is no
    // longer truncated on every spawn) but never stays above the cap.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(daemon_stderr_name("s1"));

    {
        let mut f = open_stderr_capture_in(dir.path(), &daemon_stderr_name("s1")).unwrap();
        f.write_all(b"first run\n").unwrap();
    }
    {
        let mut f = open_stderr_capture_in(dir.path(), &daemon_stderr_name("s1")).unwrap();
        f.write_all(b"second run\n").unwrap();
    }
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "first run\nsecond run\n"
    );

    // Grown past the cap (e.g. a crash loop): the next open starts it over.
    fs::write(&path, vec![b'x'; (STDERR_CAP_BYTES + 1) as usize]).unwrap();
    let mut f = open_stderr_capture_in(dir.path(), &daemon_stderr_name("s1")).unwrap();
    f.write_all(b"fresh\n").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\n");

    // And a live writer that outgrows it is truncated by the watchdog's check.
    f.write_all(&vec![b'y'; (STDERR_CAP_BYTES + 1) as usize])
        .unwrap();
    let watcher = fs::OpenOptions::new().write(true).open(&path).unwrap();
    assert!(shared::enforce_cap(&watcher, STDERR_CAP_BYTES).unwrap());
    assert!(fs::metadata(&path).unwrap().len() <= STDERR_CAP_BYTES);
}

#[test]
fn stderr_capture_files_belong_to_the_budgeted_family() {
    let dir = tempfile::tempdir().unwrap();
    open_stderr_capture_in(dir.path(), &daemon_stderr_name("s1")).unwrap();
    open_stderr_capture_in(dir.path(), &registry_stderr_name()).unwrap();
    fs::write(dir.path().join("unrelated.log"), "x").unwrap();

    let family: Vec<String> = shared::family_files(dir.path(), LOG_FAMILY)
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

    assert_eq!(
        family,
        vec![
            "termihub-agent-stderr-daemon-s1.log",
            "termihub-agent-stderr-registry.log"
        ]
    );
    assert_eq!(file_names(dir.path()).len(), 3);
}

#[test]
fn only_daemon_roles_are_detached() {
    assert!(AgentRole::Daemon.is_detached());
    assert!(AgentRole::Registry.is_detached());
    assert!(!AgentRole::Stdio.is_detached());
    assert!(!AgentRole::Listen.is_detached());
}

#[test]
fn log_dir_is_a_logs_subdir_of_the_agent_config_dir() {
    let cfg = PathBuf::from("/some/agent/config");
    assert_eq!(log_dir_in(cfg.clone()), cfg.join("logs"));
}

#[test]
fn log_dir_sits_under_the_agent_config_dir() {
    use crate::state::persistence::AgentState;
    let dir = log_dir();
    assert!(
        dir.ends_with("logs"),
        "log dir {dir:?} must be a logs/ subdir"
    );
    assert_eq!(
        dir.parent().map(Path::to_path_buf),
        Some(AgentState::config_dir())
    );
}

#[test]
fn log_file_path_is_this_processs_own_file_in_the_log_dir() {
    let path = log_file_path(AgentRole::Daemon);
    assert_eq!(
        path.file_name().unwrap().to_string_lossy(),
        format!("termihub-agent-daemon-{}.log", std::process::id())
    );
    assert_eq!(path.parent().unwrap(), log_dir());
}
