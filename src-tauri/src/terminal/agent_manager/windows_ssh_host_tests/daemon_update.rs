//! Live agent **update while a daemon session runs** on a real Windows OpenSSH
//! host (#5254).
//!
//! A session daemon outlives the `--stdio` agent that started it and keeps the
//! installed `termihub-agent.exe` open. Windows refuses to replace or delete an
//! open image, so the old `move /Y` / `Move-Item -Force` install failed, the
//! restore failed too, and the error claimed the previous agent was gone. The
//! install now renames the running exe aside to a stale name first (Windows
//! allows renaming an open image). This case, once per OpenSSH `DefaultShell`:
//!
//! 1. installs a working agent, starts a persistent session (its daemon holds
//!    the exe) and disconnects the desktop — what `update_agent` leaves after
//!    `agent.shutdown`;
//! 2. plants an unlocked stale image, then **updates under the running
//!    daemon**: the result is `Deployed`, no backup is left, and the planted
//!    stale image is deleted (the cleanup runs);
//! 3. updates to a binary that cannot start, still under the daemon: the
//!    update **rolls back** cleanly to the working agent;
//! 4. reconnects: the daemon's session survived both updates, then closes it.
//!
//! Gated like the parent's tests; the recipe runs it after the rollback test.

use super::rollback::{
    assert_clean_install, assert_rolled_back, exists_probe, install, reset, run, BROKEN_AGENT,
};
use super::*;
use crate::terminal::agent_install::{InstallPlan, WINDOWS_STALE_PREFIX};

/// File name of the unlocked stale image the test plants, which the next
/// deploy's cleanup must delete.
const PLANTED_STALE: &str = "termihub-agent.stale-5254planted.exe";

/// The planted stale image's path, next to the install.
fn planted_stale_path(plan: &InstallPlan) -> String {
    let dir = plan
        .install_path
        .rsplit_once('\\')
        .map_or(plan.install_path.as_str(), |(dir, _)| dir);
    format!(r"{dir}\{PLANTED_STALE}")
}

/// A command (in `shell`'s syntax) writing a small text file at `path`.
fn plant_probe(shell: WindowsShell, path: &str) -> String {
    match shell {
        WindowsShell::Cmd => format!(r#"echo stale-5254> "{path}""#),
        WindowsShell::PowerShell => {
            format!(r#"Set-Content -ErrorAction Stop -Path "{path}" -Value stale-5254"#)
        }
    }
}

/// A command (in `shell`'s syntax) listing the stale images in the install
/// dir, to log what a running agent still holds.
fn stale_listing_probe(shell: WindowsShell, plan: &InstallPlan) -> String {
    let dir = plan
        .install_path
        .rsplit_once('\\')
        .map_or(plan.install_path.as_str(), |(dir, _)| dir);
    match shell {
        WindowsShell::Cmd => format!(r#"dir /B "{dir}\{WINDOWS_STALE_PREFIX}*.exe" 2>nul"#),
        WindowsShell::PowerShell => format!(
            r#"Get-ChildItem -Path "{dir}" -Filter "{WINDOWS_STALE_PREFIX}*.exe" -File -ErrorAction SilentlyContinue | ForEach-Object Name"#
        ),
    }
}

/// Run `f` with a fresh SSH session on a blocking thread (the remote-exec
/// helpers use `block_in_place`).
async fn with_session<T: Send + 'static>(
    fixture: &Fixture,
    f: impl FnOnce(&termihub_core::backends::ssh::handler::SshSession) -> T + Send + 'static,
) -> T {
    let ssh = fixture.ssh_config();
    tokio::task::spawn_blocking(move || {
        let session = connect_and_authenticate(&ssh)
            .unwrap_or_else(|e| panic!("SSH to the Windows host failed: {e}"));
        f(&session)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
}

/// Step 1: a working install plus a persistent session whose daemon keeps
/// running after the desktop disconnects. Returns the install path and the
/// session id.
async fn install_and_leave_a_daemon_session(fixture: &Fixture) -> (String, String) {
    let shell = fixture.default_shell;
    let bin = fixture.agent_bin.clone();
    let agent_path = with_session(fixture, move |session| {
        let plan = windows_install_plan(shell);
        reset(session, shell, &plan);
        let working = std::fs::read(&bin).unwrap_or_else(|e| panic!("read agent binary: {e}"));
        let first = install(session, &working, "installing the working agent");
        assert_clean_install(session, &first, shell, &plan)
    })
    .await;

    let config = fixture.agent_config(&agent_path);
    let mut request_id = 0u64;
    let (session, mut channel) = establish(&config, &mut request_id).await;
    let sid = create_powershell_session(&mut channel, &mut request_id, "update-5254").await;
    write_input(
        &mut channel,
        &mut request_id,
        &sid,
        "$i=0; while ($true) { \"TICK=$i\"; $i++; Start-Sleep -Milliseconds 200 }\r",
    )
    .await;
    read_counter_until(&mut channel, |m| m >= 3, Instant::now() + LIVE_CEILING)
        .await
        .expect("the daemon session never produced TICK values");
    // Desktop-side disconnect: the `--stdio` agent exits, the daemon (holding
    // the installed exe) keeps running — what `update_agent` faces.
    drop(channel);
    drop(session);
    tokio::time::sleep(Duration::from_millis(2000)).await;
    (agent_path, sid)
}

/// Steps 2 and 3: a working update, then a broken one, both while the daemon
/// session runs.
async fn update_under_the_daemon(fixture: &Fixture) {
    let shell = fixture.default_shell;
    let bin = fixture.agent_bin.clone();
    let fx = fixture.clone();
    with_session(fixture, move |session| {
        let plan = windows_install_plan(shell);
        let working = std::fs::read(&bin).unwrap_or_else(|e| panic!("read agent binary: {e}"));
        let planted = planted_stale_path(&plan);
        run(session, &plant_probe(shell, &planted), "planting a stale image");
        assert_eq!(
            run(session, &exists_probe(shell, &planted), "probing the plant").trim(),
            "PRESENT"
        );

        // ── 2. A working update under the running daemon installs.
        let updated = install(session, &working, "updating under a running daemon");
        assert_clean_install(session, &updated, shell, &plan);
        assert_eq!(
            run(session, &exists_probe(shell, &planted), "probing the plant").trim(),
            "ABSENT",
            "the deploy must delete a stale image nothing runs"
        );
        eprintln!(
            "{shell:?}: stale images still held after the update: {:?}",
            run(session, &stale_listing_probe(shell, &plan), "listing stale")
        );

        // ── 3. A broken update under the running daemon rolls back.
        let broken = install(session, BROKEN_AGENT, "broken update under a daemon");
        assert_rolled_back(&fx, session, &broken, &plan, working.len());
    })
    .await;
}

/// Step 4: the daemon's session survived both updates; close it.
async fn session_survived_and_close(fixture: &Fixture, agent_path: &str, sid: &str) {
    let config = fixture.agent_config(agent_path);
    let mut request_id = 0u64;
    let (session, mut channel) = establish(&config, &mut request_id).await;
    let list = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.list",
        serde_json::json!({}),
    )
    .await
    .expect("connection.list after the update failed");
    let survived = list["sessions"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["session_id"].as_str() == Some(sid)));
    let _ = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.close",
        serde_json::json!({ "session_id": sid }),
    )
    .await;
    drop(channel);
    drop(session);
    assert!(
        survived,
        "the daemon session {sid} did not survive the update — list: {list}"
    );
}

async fn update_with_daemon_session(want: WindowsShell) {
    let Some(fixture) = live_fixture() else {
        return;
    };
    if fixture.default_shell != want {
        eprintln!(
            "SKIPPED: the fixture's OpenSSH DefaultShell is {:?}, this test needs {want:?} \
             (the lane runs each shell's test in its own step)",
            fixture.default_shell
        );
        return;
    }
    trust_all_host_keys();
    let (agent_path, sid) = install_and_leave_a_daemon_session(&fixture).await;
    update_under_the_daemon(&fixture).await;
    session_survived_and_close(&fixture, &agent_path, &sid).await;
    with_session(&fixture, move |session| {
        reset(session, want, &windows_install_plan(want));
    })
    .await;
}

/// #5254 with the OpenSSH `DefaultShell` left at `cmd.exe`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cmd_default_shell_update_with_daemon_session() {
    update_with_daemon_session(WindowsShell::Cmd).await;
}

/// #5254 with the OpenSSH `DefaultShell` set to PowerShell.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn powershell_default_shell_update_with_daemon_session() {
    update_with_daemon_session(WindowsShell::PowerShell).await;
}

// ── Command-shape unit tests (run everywhere) ──────────────────────────

#[test]
fn planted_stale_image_matches_the_cleanup_pattern_only() {
    assert!(PLANTED_STALE.starts_with(WINDOWS_STALE_PREFIX));
    assert!(PLANTED_STALE.ends_with(".exe"));
    for shell in [WindowsShell::Cmd, WindowsShell::PowerShell] {
        let plan = windows_install_plan(shell);
        let planted = planted_stale_path(&plan);
        let dir = plan.install_path.rsplit_once('\\').unwrap().0;
        assert_eq!(planted, format!(r"{dir}\{PLANTED_STALE}"));
        assert!(stale_listing_probe(shell, &plan).contains(WINDOWS_STALE_PREFIX));
    }
    assert!(plant_probe(WindowsShell::Cmd, "x").starts_with("echo stale-5254> "));
    assert!(plant_probe(WindowsShell::PowerShell, "x").contains("-ErrorAction Stop"));
}
