//! Tests for the WSL shell-directory probe (#5013).

use super::*;

/// Probe output for `up` seconds of uptime at 100 ticks/s and `shells` as
/// `(pid, start ticks, cwd)`.
fn probe(up: &str, shells: &[(u32, u64, &str)]) -> Vec<u8> {
    let mut out = String::new();
    for (pid, start, cwd) in shells {
        out.push_str(&format!("TH_SH:{pid} {start} {cwd}\n"));
    }
    out.push_str(&format!("TH_UP:{up}\nTH_HZ:100\n"));
    out.into_bytes()
}

const SECS: fn(u64) -> Duration = Duration::from_secs;

#[test]
fn parses_shells_uptime_and_tick_rate() {
    let out = b"noise\nTH_SH:42 1000 /home/me/My Dir\r\nTH_SH:43 1200 \nTH_UP:15.25\nTH_HZ:250\n";
    let p = parse_probe(out).expect("parsed");
    assert_eq!(p.uptime, 15.25);
    assert_eq!(p.hz, 250);
    assert_eq!(
        p.shells,
        vec![
            ProbedShell {
                pid: 42,
                start_ticks: 1000,
                cwd: Some("/home/me/My Dir".to_string())
            },
            ProbedShell {
                pid: 43,
                start_ticks: 1200,
                cwd: None
            },
        ]
    );
}

#[test]
fn output_without_uptime_is_no_probe() {
    assert_eq!(parse_probe(b""), None);
    assert_eq!(parse_probe(b"TH_SH:1 2 /\n"), None);
    assert_eq!(parse_probe(b"TH_UP:x\nTH_HZ:100\n"), None);
}

#[test]
fn a_zero_tick_rate_falls_back_to_100() {
    let p = parse_probe(b"TH_UP:1.00\nTH_HZ:0\n").expect("parsed");
    assert_eq!(p.hz, 100);
}

#[test]
fn relative_or_garbage_directories_are_dropped() {
    let p = parse_probe(b"TH_SH:7 1 relative\nTH_SH:x 1 /a\nTH_UP:1\nTH_HZ:100\n").expect("ok");
    assert_eq!(
        p.shells,
        vec![ProbedShell {
            pid: 7,
            start_ticks: 1,
            cwd: None
        }]
    );
}

#[test]
fn the_shell_started_after_the_spawn_is_ours() {
    let mut t = WslShellTracker::new();
    // Uptime 100 s. Another terminal's shell started at 50 s, ours at 98.5 s;
    // termiHub spawned wsl.exe 2 s ago.
    let out = probe("100.00", &[(10, 5000, "/other"), (20, 9850, "/home/me")]);
    assert_eq!(t.read(Some(&out), SECS(2)), Some("/home/me".to_string()));
}

#[test]
fn shells_started_before_the_spawn_are_never_ours() {
    let mut t = WslShellTracker::new();
    // Ours has not started yet; the only shell is 3 s old, spawn was 2 s ago.
    let out = probe("100.00", &[(10, 9700, "/other")]);
    assert_eq!(t.read(Some(&out), SECS(2)), None);
}

#[test]
fn once_identified_the_same_shell_is_followed() {
    let mut t = WslShellTracker::new();
    let first = probe("100.00", &[(20, 9850, "/home/me")]);
    assert_eq!(t.read(Some(&first), SECS(2)), Some("/home/me".to_string()));
    // Much later, a newer terminal exists too; ours is still pid 20.
    let later = probe(
        "400.00",
        &[
            (20, 9850, "/tmp"),
            (30, 39_000, "/newer"),
            (31, 39_010, "/x"),
        ],
    );
    assert_eq!(t.read(Some(&later), SECS(302)), Some("/tmp".to_string()));
}

#[test]
fn two_shells_started_together_are_ambiguous() {
    let mut t = WslShellTracker::new();
    let out = probe("100.00", &[(20, 9850, "/a"), (21, 9900, "/b")]);
    assert_eq!(t.read(Some(&out), SECS(2)), None, "never guess");
}

#[test]
fn a_clearly_later_terminal_does_not_hide_ours() {
    let mut t = WslShellTracker::new();
    // Ours at 98.5 s, another opened 1.5 s later.
    let out = probe("100.50", &[(21, 10_000, "/b"), (20, 9850, "/a")]);
    assert_eq!(t.read(Some(&out), SECS(3)), Some("/a".to_string()));
}

#[test]
fn a_reused_pid_is_not_our_shell() {
    let mut t = WslShellTracker::new();
    let first = probe("100.00", &[(20, 9850, "/home/me")]);
    assert_eq!(t.read(Some(&first), SECS(2)), Some("/home/me".to_string()));
    // pid 20 now belongs to a process started much later: not ours.
    let later = probe("400.00", &[(20, 39_000, "/elsewhere")]);
    assert_eq!(t.read(Some(&later), SECS(302)), None);
}

#[test]
fn an_unreadable_directory_keeps_following() {
    let mut t = WslShellTracker::new();
    let first = probe("100.00", &[(20, 9850, "/home/me")]);
    assert_eq!(t.read(Some(&first), SECS(2)), Some("/home/me".to_string()));
    // `sudo -i` in the foreground: its cwd is not readable for the user.
    for _ in 0..5 {
        let sudo = probe("101.00", &[(20, 9850, "")]);
        assert_eq!(t.read(Some(&sudo), SECS(3)), None);
    }
    assert!(!t.gave_up());
    let back = probe("102.00", &[(20, 9850, "/srv")]);
    assert_eq!(t.read(Some(&back), SECS(4)), Some("/srv".to_string()));
}

#[test]
fn gives_up_after_repeated_failures_to_identify_the_shell() {
    let mut t = WslShellTracker::new();
    for _ in 0..MAX_IDENTIFY_FAILURES {
        assert!(!t.gave_up());
        assert_eq!(t.read(None, SECS(2)), None);
    }
    assert!(t.gave_up(), "stops spawning wsl.exe for good");
}

#[test]
fn a_success_resets_the_failure_count() {
    let mut t = WslShellTracker::new();
    for _ in 0..MAX_IDENTIFY_FAILURES - 1 {
        t.read(None, SECS(2));
    }
    let out = probe("100.00", &[(20, 9850, "/home/me")]);
    assert_eq!(t.read(Some(&out), SECS(2)), Some("/home/me".to_string()));
    t.read(None, SECS(2));
    assert!(!t.gave_up());
}

#[test]
fn probe_args_run_the_script_with_sh_exec_in_the_distro() {
    let args = probe_args("Debian-12");
    assert_eq!(&args[..5], ["-d", "Debian-12", "--exec", "sh", "-c"]);
    assert_eq!(args[5], WSL_CWD_SCRIPT);
    assert_eq!(args.len(), 6);
}

#[test]
fn script_prints_the_markers_it_is_parsed_by() {
    for marker in ["TH_SH:", "TH_UP:", "TH_HZ:"] {
        assert!(WSL_CWD_SCRIPT.contains(marker), "{marker}");
    }
    // Uptime is read last, right before the probe exits (see the module docs).
    let up = WSL_CWD_SCRIPT.find("/proc/uptime").expect("uptime");
    let sh = WSL_CWD_SCRIPT.find("TH_SH:").expect("shells");
    assert!(up > sh);
}

/// The script itself, against this host's `/proc`: it must list a shell on
/// a terminal with its directory. Linux only (the WSL distro is Linux).
#[cfg(target_os = "linux")]
#[test]
fn script_finds_a_terminal_shell_on_linux() {
    use std::process::Command;
    // `script` gives `sleep` a fresh pty, i.e. a new terminal session.
    let dir = std::env::temp_dir();
    let mut child = match Command::new("script")
        .args(["-qfc", "sleep 30", "/dev/null"])
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("SKIPPED: `script` unavailable: {e}");
            return;
        }
    };
    std::thread::sleep(Duration::from_millis(500));
    let out = Command::new("sh")
        .args(["-c", WSL_CWD_SCRIPT])
        .output()
        .expect("run sh");
    let _ = child.kill();
    let _ = child.wait();
    let p = parse_probe(&out.stdout).unwrap_or_else(|| {
        panic!(
            "no probe output: {:?} {:?}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    });
    let want = std::fs::canonicalize(&dir).expect("canonical temp dir");
    assert!(
        p.shells.iter().any(|s| s.cwd.as_deref() == want.to_str()),
        "no terminal process in {want:?}: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
}
