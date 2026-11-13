//! Unit tests for the identity-keeping relaunch (#5647).

use std::cell::RefCell;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::*;

/// A [`Spawner`] that records the commands instead of starting them.
#[derive(Default)]
struct RecordingSpawner {
    spawned: RefCell<Vec<RelaunchCommand>>,
    fail: bool,
}

impl Spawner for RecordingSpawner {
    fn spawn(&self, command: &RelaunchCommand) -> io::Result<()> {
        if self.fail {
            return Err(io::Error::new(io::ErrorKind::NotFound, "no such binary"));
        }
        self.spawned.borrow_mut().push(command.clone());
        Ok(())
    }
}

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(n, v)| (OsString::from(n), OsString::from(v)))
        .collect()
}

/// The environment of a dev/test instance started by the harness.
fn isolated_env() -> Vec<(OsString, OsString)> {
    os(&[
        ("HOME", "/Users/someone"),
        ("PATH", "/usr/bin:/bin"),
        ("TERMIHUB_CONFIG_DIR", "/tmp/thub-profile"),
        ("TERMIHUB_LOG_DIR", "/tmp/thub-logs"),
        ("TERMIHUB_DEV_NAME", "dev1"),
        ("TERMIHUB_TEST_BRIDGE_PORT", "45123"),
    ])
}

fn bundle_binary() -> PathBuf {
    PathBuf::from("/Applications/termiHub.app/Contents/MacOS/termiHub")
}

fn lookup(env: &[(OsString, OsString)]) -> impl Fn(&str) -> Option<OsString> + '_ {
    move |name| {
        env.iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    }
}

// ── parent side ────────────────────────────────────────────────────────────

#[test]
fn the_relaunch_starts_the_binary_itself_with_the_original_arguments() {
    let spawner = RecordingSpawner::default();
    let args = vec![OsString::from("--workspace"), OsString::from("Main")];
    spawn_relaunch(&spawner, bundle_binary(), args.clone(), isolated_env(), 4242).unwrap();
    let spawned = spawner.spawned.borrow();
    assert_eq!(spawned.len(), 1);
    // Directly the bundle's executable — never `/usr/bin/open` (LaunchServices).
    assert_eq!(spawned[0].program, bundle_binary());
    assert_eq!(spawned[0].args, args);
}

#[test]
fn the_relaunch_keeps_every_variable_of_the_instance() {
    let spawner = RecordingSpawner::default();
    spawn_relaunch(&spawner, bundle_binary(), [], isolated_env(), 4242).unwrap();
    let command = &spawner.spawned.borrow()[0];
    for (name, value) in isolated_env() {
        assert_eq!(command.env_value(&name), Some(value.as_os_str()), "{name:?}");
    }
    assert!(identity_not_kept(&isolated_env(), command).is_empty());
}

#[test]
fn the_relaunch_names_its_parent_and_the_identity_it_must_keep() {
    let command = RelaunchCommand::build(bundle_binary(), [], isolated_env(), 4242);
    assert_eq!(
        command.env_value(OsStr::new(RELAUNCH_AFTER_PID_ENV)),
        Some(OsStr::new("4242"))
    );
    assert_eq!(
        command.env_value(OsStr::new(RELAUNCH_IDENTITY_ENV)),
        Some(OsStr::new(
            "TERMIHUB_CONFIG_DIR,TERMIHUB_DEV_NAME,TERMIHUB_LOG_DIR,TERMIHUB_TEST_BRIDGE_PORT"
        ))
    );
}

#[test]
fn a_second_relaunch_replaces_the_markers_of_the_first() {
    let mut env = isolated_env();
    env.extend(os(&[
        (RELAUNCH_AFTER_PID_ENV, "1"),
        (RELAUNCH_IDENTITY_ENV, "TERMIHUB_GONE"),
    ]));
    let command = RelaunchCommand::build(bundle_binary(), [], env, 4242);
    let markers: Vec<_> = command
        .env
        .iter()
        .filter(|(n, _)| n == RELAUNCH_AFTER_PID_ENV || n == RELAUNCH_IDENTITY_ENV)
        .collect();
    assert_eq!(markers.len(), 2, "exactly one of each marker");
    assert_eq!(
        command.env_value(OsStr::new(RELAUNCH_AFTER_PID_ENV)),
        Some(OsStr::new("4242"))
    );
    let identity = command.env_value(OsStr::new(RELAUNCH_IDENTITY_ENV)).unwrap();
    assert!(!identity.to_string_lossy().contains("TERMIHUB_GONE"));
}

#[test]
fn an_installed_instance_relaunches_with_an_empty_identity() {
    let env = os(&[("HOME", "/Users/someone")]);
    let command = RelaunchCommand::build(bundle_binary(), [], env, 7);
    assert_eq!(
        command.env_value(OsStr::new(RELAUNCH_IDENTITY_ENV)),
        Some(OsStr::new(""))
    );
}

#[test]
fn identity_not_kept_names_a_dropped_or_changed_variable() {
    let mut command = RelaunchCommand::build(bundle_binary(), [], isolated_env(), 1);
    command.env.retain(|(n, _)| n != "TERMIHUB_CONFIG_DIR");
    for (name, value) in &mut command.env {
        if name == "TERMIHUB_DEV_NAME" {
            *value = OsString::from("dev0");
        }
    }
    let mut lost = identity_not_kept(&isolated_env(), &command);
    lost.sort();
    assert_eq!(lost, ["TERMIHUB_CONFIG_DIR", "TERMIHUB_DEV_NAME"]);
}

#[test]
fn a_failed_spawn_is_reported() {
    let spawner = RecordingSpawner {
        fail: true,
        ..Default::default()
    };
    let err = spawn_relaunch(&spawner, bundle_binary(), [], isolated_env(), 1).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn the_process_command_passes_exactly_the_built_environment() {
    let command = RelaunchCommand::build(bundle_binary(), [OsString::from("-x")], isolated_env(), 9);
    let process = command.to_command();
    assert_eq!(process.get_program(), bundle_binary().as_os_str());
    assert_eq!(process.get_args().collect::<Vec<_>>(), [OsStr::new("-x")]);
    let envs: Vec<(OsString, Option<OsString>)> = process
        .get_envs()
        .map(|(n, v)| (n.to_os_string(), v.map(OsStr::to_os_string)))
        .collect();
    for (name, value) in &command.env {
        assert!(
            envs.contains(&(name.clone(), Some(value.clone()))),
            "{name:?} not passed"
        );
    }
    // `env_clear` is in effect: nothing beyond the built environment leaks in.
    assert_eq!(envs.len(), command.env.len());
}

#[cfg(unix)]
#[test]
fn the_relaunch_really_carries_the_environment_and_detaches_stdin() {
    // Run `/bin/sh` through the real command builder and let it report what it got.
    let env = os(&[
        ("PATH", "/usr/bin:/bin"),
        ("TERMIHUB_CONFIG_DIR", "/tmp/thub profile"),
        ("TERMIHUB_DEV_NAME", "dev1"),
    ]);
    let script = "printf '%s|%s|%s|' \"$TERMIHUB_CONFIG_DIR\" \"$TERMIHUB_DEV_NAME\" \
                  \"$TERMIHUB_RELAUNCH_AFTER_PID\"; cat; echo end";
    let command = RelaunchCommand::build(
        PathBuf::from("/bin/sh"),
        [OsString::from("-c"), OsString::from(script)],
        env,
        31337,
    );
    let output = command
        .to_command()
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "/tmp/thub profile|dev1|31337|end\n"
    );
}

// ── child side ─────────────────────────────────────────────────────────────

#[test]
fn a_normal_start_is_not_a_relaunch() {
    assert_eq!(
        classify_startup(lookup(&isolated_env())),
        RelaunchStartup::NotRelaunched
    );
}

#[test]
fn a_relaunch_with_its_identity_waits_for_the_parent() {
    let command = RelaunchCommand::build(bundle_binary(), [], isolated_env(), 4242);
    assert_eq!(
        classify_startup(lookup(&command.env)),
        RelaunchStartup::WaitForParent { parent_pid: 4242 }
    );
}

#[test]
fn a_relaunch_that_lost_its_profile_refuses_to_start() {
    // What LaunchServices did: the markers made it, the isolation did not.
    let command = RelaunchCommand::build(bundle_binary(), [], isolated_env(), 4242);
    let stripped: Vec<_> = command
        .env
        .into_iter()
        .filter(|(n, _)| n != "TERMIHUB_CONFIG_DIR" && n != "TERMIHUB_DEV_NAME")
        .collect();
    assert_eq!(
        classify_startup(lookup(&stripped)),
        RelaunchStartup::IdentityLost {
            missing: vec!["TERMIHUB_CONFIG_DIR".into(), "TERMIHUB_DEV_NAME".into()]
        }
    );
}

#[test]
fn a_garbled_pid_skips_the_wait() {
    let env = os(&[(RELAUNCH_AFTER_PID_ENV, "not-a-pid"), (RELAUNCH_IDENTITY_ENV, "")]);
    assert_eq!(classify_startup(lookup(&env)), RelaunchStartup::NotRelaunched);
}

#[test]
fn waiting_returns_once_the_parent_is_gone() {
    let mut checks = 0;
    let mut slept = Duration::ZERO;
    let start = Instant::now();
    let exited = wait_for_parent_exit(
        || {
            checks += 1;
            checks < 4
        },
        Duration::from_secs(60),
        Duration::from_millis(50),
        || start + slept,
        |d| slept += d,
    );
    assert!(exited);
    assert_eq!(checks, 4);
    assert_eq!(slept, Duration::from_millis(150));
}

#[test]
fn waiting_gives_up_after_the_timeout() {
    let mut slept = Duration::ZERO;
    let start = Instant::now();
    let exited = wait_for_parent_exit(
        || true,
        Duration::from_secs(1),
        Duration::from_millis(250),
        || start + slept,
        |d| slept += d,
    );
    assert!(!exited);
    assert_eq!(slept, Duration::from_secs(1));
}

#[cfg(any(unix, windows))]
#[test]
fn process_alive_sees_this_process_and_not_a_finished_one() {
    assert!(process_alive(std::process::id()));
    #[cfg(unix)]
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .unwrap();
    #[cfg(windows)]
    let mut child = std::process::Command::new("cmd")
        .args(["/C", "exit 0"])
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(!process_alive(pid));
}
