use crate::utils::errors::TerminalError;

/// The privilege-elevated write outcome and the writability verdict now live in
/// [`termihub_core::backends::ssh::sftp_ops`] so a single implementation backs
/// both the core `FileBrowser` path and this desktop command layer (#2104).
/// Re-exported here so the session-scoped SFTP command layer and its callers
/// keep their import paths.
pub use termihub_core::backends::ssh::sftp_ops::{ElevatedWriteResult, Writability};

/// Map a core [`FileError`](termihub_core::errors::FileError) from an SFTP
/// operation to the desktop [`TerminalError::SftpError`], preserving the
/// operation-specific message (`readdir failed: …`, `realpath failed: …`, etc.)
/// rather than double-wrapping it behind the generic "Operation failed:" prefix.
///
/// Shared by the session-scoped SFTP ops (`session/file_ops.rs`) and the
/// transfer/VS-Code command helpers so they map the core browser's errors
/// uniformly (#2104). The standalone UUID-keyed `SftpManager` session model this
/// once also served was retired in #2314 — SSH file browsing/transfer now resolve
/// their core [`SftpFileBrowser`](termihub_core::backends::ssh::SftpFileBrowser)
/// from the `ConnectionType`/session path.
pub(crate) fn sftp_op_error(err: termihub_core::errors::FileError) -> TerminalError {
    match err {
        termihub_core::errors::FileError::OperationFailed(msg) => TerminalError::SftpError(msg),
        other => TerminalError::SftpError(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use termihub_core::backends::ssh::SftpFileBrowser;

    use crate::terminal::backend::SshConfig;

    // The pure command-composition and classification unit tests for the
    // elevated (sudo) save and the writability probe live beside the single core
    // implementation in `core::backends::ssh::sftp_ops` (#2104). The Docker-backed
    // integration tests below stay here because they drive the desktop command
    // layer's SFTP session (the core `SftpFileBrowser`) end-to-end over a live SSH
    // connection.

    // ── Docker-backed elevated-save integration tests ────────────────────
    //
    // Exercise the real `SftpFileBrowser::write_file_content_elevated` path
    // end-to-end over a live SSH connection (temp SFTP upload → `sudo -S`
    // rewrite → typed classification → temp cleanup), covering the three
    // outcomes the #1328 unit tests can only stub: correct password, wrong
    // password, and no-sudo. They self-skip when the container is not up, but
    // hard-fail under `TERMIHUB_REQUIRE_DOCKER=1` (`utils::docker_fixture_gate`,
    // #3978) — the integration-fixtures lane sets it, so they cannot go green
    // there by skipping. Bring the fixtures up with:
    //   docker compose -f tests/docker/docker-compose.yml up -d ssh-sudo ssh-nosudo
    //
    // Ports are read from `TERMIHUB_TEST_SSH_SUDO_PORT` (default 2212) and
    // `TERMIHUB_TEST_SSH_NOSUDO_PORT` (default 2213) so a sharded / parallel
    // run can point at a separate container instance. A second, plain SSH
    // session (as `testuser`) reads the world-readable root-owned target back
    // to verify contents/owner/mode and to confirm no `/tmp/termihub-*` temp
    // leaked — never the elevated write path itself.
    //
    // The three tests share the one root-owned fixture file, so they must not
    // run concurrently against the same container (they clobber each other's
    // before/after expectations). They are serialized in-source with
    // `#[serial(elevated_save)]` (#2238), which keeps them parallel-safe under
    // the default `cargo test` regardless of the outer `--test-threads` setting.
    use crate::utils::docker_fixture_gate::fixture_ready;
    use crate::utils::remote_exec::run_remote_command;
    use crate::utils::ssh_auth::connect_and_authenticate;
    use serial_test::serial;
    use termihub_core::backends::ssh::handler::SshSession;
    use termihub_core::backends::ssh::SftpAdvancedOps;

    /// Root-owned file the fixtures ship (see `tests/docker/ssh-sudo`).
    const ELEVATED_TARGET: &str = "/etc/termihub-elevated-target.txt";
    /// Base host ports of the elevated-save fixtures (`tests/docker`), before
    /// this checkout's offset.
    const DEFAULT_SSH_SUDO_PORT: u16 = 2212;
    const DEFAULT_SSH_NOSUDO_PORT: u16 = 2213;
    const DEFAULT_SSH_SFTP_ONLY_PORT: u16 = 2215;
    /// A file the fixtures' `testuser` owns (`useradd -m` copies `/etc/skel`).
    const USER_OWNED_FILE: &str = "/home/testuser/.bashrc";

    /// A fixture's host port: `var` when set, else `base` shifted by this
    /// checkout's test-port offset (env or `dev.local.json`, #4338).
    fn env_port(var: &str, base: u16) -> u16 {
        termihub_core::test_fixtures::fixture_port(var, base)
    }

    /// Trust the loopback fixture host keys before connecting.
    ///
    /// The strict default host-key policy (#1969) trusts only a key already in
    /// the runner's `~/.ssh/known_hosts`, so a freshly-built fixture container is
    /// otherwise refused with "Unknown server key" (#2105). These loopback
    /// fixtures are trusted unconditionally, mirroring
    /// `sftp_transfer.rs::trust_fixture_host_keys` and core's
    /// `common::trust_fixture_host_keys`. The verifier is process-global and
    /// first-registration-wins, so calling it per test is a harmless no-op after
    /// the first.
    fn trust_fixture_host_keys() {
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };

        struct TrustLocalFixtures;

        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustLocalFixtures {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }

        let _ = set_host_key_verifier(Arc::new(TrustLocalFixtures));
    }

    /// Password-auth config for a fixture container on `127.0.0.1:port`.
    fn testuser_config(port: u16, password: &str) -> SshConfig {
        user_config(port, "testuser", password)
    }

    /// Password-auth config for `username` on a fixture container.
    fn user_config(port: u16, username: &str, password: &str) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: username.to_string(),
            auth_method: "password".to_string(),
            password: Some(password.to_string()),
            ..Default::default()
        }
    }

    /// Count of leftover `/tmp/termihub-*` temp files as seen by `testuser`.
    fn temp_leftover_count(verify: &SshSession) -> Result<usize, TerminalError> {
        // `2>/dev/null` swallows the "No such file" when the glob matches
        // nothing; `grep -c` avoids `wc`'s leading whitespace.
        let out = run_remote_command(
            verify,
            "ls -1d /tmp/termihub-* 2>/dev/null | grep -c . || true",
        )?;
        Ok(out.trim().parse().unwrap_or(0))
    }

    /// Run `f` with a fresh, plain SSH verify session (as `testuser`) on a
    /// blocking-pool thread — `connect_and_authenticate` and `run_remote_command`
    /// are synchronous, so they cannot run on the async test thread. Used only to
    /// read the target file back and count temp leftovers, never for the elevated
    /// write path itself (that goes through the async core browser under test).
    async fn with_verify<T, F>(config: SshConfig, f: F) -> Result<T, TerminalError>
    where
        F: FnOnce(&SshSession) -> Result<T, TerminalError> + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            let verify = connect_and_authenticate(&config)?;
            f(&verify)
        })
        .await
        .map_err(|e| TerminalError::SshError(format!("Task join error: {e}")))?
    }

    /// Correct password → `Success`: the root-owned file is rewritten, its
    /// owner/mode are preserved, and no temp upload leaks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn elevated_save_success_rewrites_root_file_over_real_ssh() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");
        let stat_cmd = format!("stat -c '%U %G %a' {ELEVATED_TARGET}");

        // Capture owner/group/mode before the elevated rewrite.
        let stat_before = with_verify(config.clone(), {
            let stat_cmd = stat_cmd.clone();
            move |v| run_remote_command(v, &stat_cmd)
        })
        .await
        .expect("stat before should succeed");

        // Elevated write through the single core browser (the desktop command
        // layer's SFTP path).
        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("elevated-rewrite-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")
            .await
            .expect("elevated save (success) should complete");

        // Read the target back and confirm no temp leaked.
        let (after, stat_after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let stat_after = run_remote_command(v, &stat_cmd)?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, stat_after, leftover))
        })
        .await
        .expect("readback after should succeed");

        assert_eq!(outcome, ElevatedWriteResult::Success, "expected Success");
        assert_eq!(
            after,
            new_content.trim(),
            "root-owned file should hold the newly written content"
        );
        assert_eq!(
            stat_before, stat_after,
            "owner/group/mode must be unchanged by the elevated rewrite"
        );
        assert_eq!(
            stat_after, "root root 644",
            "target must remain root-owned, mode 644"
        );
        assert_eq!(leftover, 0, "no /tmp/termihub-* temp should remain");
    }

    /// Wrong password → `IncorrectPassword`: the file is untouched and the temp
    /// upload is cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn elevated_save_wrong_password_leaves_file_untouched() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");

        let before = with_verify(config.clone(), move |v| {
            run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))
        })
        .await
        .expect("read before should succeed");

        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(
                ELEVATED_TARGET,
                &new_content,
                "definitely-the-wrong-password",
            )
            .await
            .expect("elevated save (wrong password) should complete");

        let (after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, leftover))
        })
        .await
        .expect("readback after should succeed");

        assert_eq!(
            outcome,
            ElevatedWriteResult::IncorrectPassword,
            "a rejected sudo password must classify as IncorrectPassword"
        );
        assert_eq!(
            after, before,
            "file must be unchanged on a rejected password"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    /// No sudo installed → `Other`: the file is untouched and the temp upload is
    /// cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn elevated_save_without_sudo_returns_other() {
        let port = env_port("TERMIHUB_TEST_SSH_NOSUDO_PORT", DEFAULT_SSH_NOSUDO_PORT);
        if !fixture_ready("ssh-nosudo", port) {
            return;
        }

        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");

        let before = with_verify(config.clone(), move |v| {
            run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))
        })
        .await
        .expect("read before should succeed");

        let browser = SftpFileBrowser::new(config.clone());
        let new_content = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
        let outcome = browser
            .write_file_content_elevated(ELEVATED_TARGET, &new_content, "testpass")
            .await
            .expect("elevated save (no sudo) should complete");

        let (after, leftover) = with_verify(config.clone(), move |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, leftover))
        })
        .await
        .expect("readback after should succeed");

        match outcome {
            ElevatedWriteResult::Other(msg) => {
                assert!(!msg.is_empty(), "Other must carry a displayable message")
            }
            other => panic!("expected Other when sudo is unavailable, got {other:?}"),
        }
        assert_eq!(
            after, before,
            "file must be unchanged when sudo is unavailable"
        );
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    // ── Elevated save on a German login locale (#4437) ─────────────────────
    //
    // #4290 made the elevated save classify sudo's outcome without reading
    // translated text (sudo is pinned to the C locale, and the result comes from
    // the prompt count, the exit status and an authorization marker). These run
    // the same live path as `deuser` / `denosudo` on `ssh-sudo`, whose sshd login
    // environment is `LANG=de_DE.UTF-8`, and first prove that locale is really
    // German — so a fixture that silently fell back to English cannot pass.

    /// `ssh-sudo` sudoer whose login locale is German (`tests/docker/ssh-sudo`).
    const DE_SUDO_USER: &str = "deuser";
    /// `ssh-sudo` non-sudoer whose login locale is German.
    const DE_NOSUDO_USER: &str = "denosudo";
    /// Account password of both German-locale fixture users.
    const DE_PASSWORD: &str = "testpass";

    /// Prove `config`'s remote login locale is German: `locale` reports
    /// `de_DE.UTF-8` cleanly, and sudo — run *without* the C override — prints
    /// its German translation rather than the English "Sorry, try again."
    async fn assert_remote_locale_is_german(config: SshConfig) {
        let (locale, probe) = with_verify(config, |v| {
            let locale = run_remote_command(v, "locale 2>&1")?;
            // One wrong password line, then EOF: sudo rejects it, re-prompts and
            // gives up. `-k` drops any cached credential; `; true` keeps the
            // non-zero exit from mattering. stderr is folded into stdout.
            let probe = run_remote_command(
                v,
                "printf 'definitely-wrong\\n' | sudo -k -S -p '[termihub-de-probe]' true 2>&1; true",
            )?;
            Ok((locale, probe))
        })
        .await
        .expect("locale probe should run");

        assert!(
            locale.contains("LANG=de_DE.UTF-8") && locale.contains("LC_MESSAGES=\"de_DE.UTF-8\""),
            "the fixture login locale must be de_DE.UTF-8, got:\n{locale}"
        );
        assert!(
            !locale.contains("Cannot set"),
            "the de_DE.UTF-8 locale must be generated on the fixture, got:\n{locale}"
        );
        let lower = probe.to_lowercase();
        assert!(
            probe.contains("[termihub-de-probe]"),
            "the sudo probe must have prompted, got:\n{probe}"
        );
        assert!(
            !lower.contains("sorry, try again") && !lower.contains("incorrect password"),
            "sudo must not answer in English on the German fixture, got:\n{probe}"
        );
        assert!(
            lower.contains("versuchen") || lower.contains("passwort") || lower.contains("fehl"),
            "sudo must answer in German without the C override, got:\n{probe}"
        );
    }

    /// Read the elevated target back as `config`'s user.
    async fn read_target(config: SshConfig) -> String {
        with_verify(config, |v| {
            run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))
        })
        .await
        .expect("read the elevated target")
    }

    /// German locale, wrong password → `IncorrectPassword` and the file is
    /// unchanged; then the right password → `Success` and the file is rewritten.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn elevated_save_classifies_password_on_a_german_locale() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }

        trust_fixture_host_keys();
        let config = user_config(port, DE_SUDO_USER, DE_PASSWORD);
        assert_remote_locale_is_german(config.clone()).await;

        let browser = SftpFileBrowser::new(config.clone());
        let before = read_target(config.clone()).await;

        let rejected = format!("should-not-land-{}\n", uuid::Uuid::new_v4());
        let wrong = browser
            .write_file_content_elevated(
                ELEVATED_TARGET,
                &rejected,
                "definitely-the-wrong-password",
            )
            .await
            .expect("elevated save (wrong password) should complete");
        let after_wrong = read_target(config.clone()).await;
        assert_eq!(
            wrong,
            ElevatedWriteResult::IncorrectPassword,
            "a rejected sudo password on a German locale must classify as IncorrectPassword"
        );
        assert_eq!(
            after_wrong, before,
            "file must be unchanged on a rejected password"
        );

        let accepted = format!("elevated-rewrite-de-{}\n", uuid::Uuid::new_v4());
        let right = browser
            .write_file_content_elevated(ELEVATED_TARGET, &accepted, DE_PASSWORD)
            .await
            .expect("elevated save (right password) should complete");
        let (after_right, stat, leftover) = with_verify(config.clone(), |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            let stat = run_remote_command(v, &format!("stat -c '%U %G %a' {ELEVATED_TARGET}"))?;
            let leftover = temp_leftover_count(v)?;
            Ok((after, stat, leftover))
        })
        .await
        .expect("readback after should succeed");
        assert_eq!(
            right,
            ElevatedWriteResult::Success,
            "the right sudo password on a German locale must classify as Success"
        );
        assert_eq!(
            after_right,
            accepted.trim(),
            "root-owned file should hold the newly written content"
        );
        assert_eq!(
            stat, "root root 644",
            "target must stay root-owned, mode 644"
        );
        assert_eq!(leftover, 0, "no /tmp/termihub-* temp should remain");
    }

    /// German locale, a user outside sudoers with the right password → the
    /// not-in-sudoers `Other` outcome, and the file is unchanged.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn elevated_save_reports_not_in_sudoers_on_a_german_locale() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }

        trust_fixture_host_keys();
        let config = user_config(port, DE_NOSUDO_USER, DE_PASSWORD);
        assert_remote_locale_is_german(config.clone()).await;

        let before = read_target(config.clone()).await;
        let browser = SftpFileBrowser::new(config.clone());
        let outcome = browser
            .write_file_content_elevated(
                ELEVATED_TARGET,
                &format!("should-not-land-{}\n", uuid::Uuid::new_v4()),
                DE_PASSWORD,
            )
            .await
            .expect("elevated save (not in sudoers) should complete");
        let (after, leftover) = with_verify(config.clone(), |v| {
            let after = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
            Ok((after, temp_leftover_count(v)?))
        })
        .await
        .expect("readback after should succeed");

        match outcome {
            ElevatedWriteResult::Other(msg) => assert!(
                msg.contains("sudoers"),
                "expected the not-in-sudoers message, got: {msg}"
            ),
            other => panic!("expected Other (not in sudoers), got {other:?}"),
        }
        assert_eq!(after, before, "file must be unchanged when sudo refuses");
        assert_eq!(leftover, 0, "temp upload must be cleaned up on failure");
    }

    // ── Read-only detection (#1325) and the SFTP-only fallback (#1330) ─────
    //
    // The editor's read-only badge/banner is driven by the `check_writable`
    // write-open probe, and the SFTP-only fallback (no "Edit with sudo"; offer
    // "Save a copy" instead) by `has_exec_capability`. These drive both against
    // the real fixtures; the badge and banner rendering itself is UI.

    /// The probe reports the fixture's root-owned file read-only and the
    /// `testuser`-owned file writable, without modifying either.
    async fn assert_root_owned_file_detected_read_only(service: &str, port: u16) {
        trust_fixture_host_keys();
        let config = testuser_config(port, "testpass");
        let read_both = || {
            with_verify(config.clone(), |v| {
                let target = run_remote_command(v, &format!("cat {ELEVATED_TARGET}"))?;
                let own = run_remote_command(v, &format!("md5sum {USER_OWNED_FILE}"))?;
                Ok((target, own))
            })
        };
        let before = read_both().await.expect("read before should succeed");

        let browser = SftpFileBrowser::new(config.clone());
        let root_owned = browser
            .check_writable(ELEVATED_TARGET)
            .await
            .expect("probe the root-owned file");
        let user_owned = browser
            .check_writable(USER_OWNED_FILE)
            .await
            .expect("probe the user-owned file");

        let after = read_both().await.expect("read after should succeed");
        assert_eq!(
            root_owned,
            Writability::ReadOnly,
            "{service}: a root-owned 644 file must be detected read-only"
        );
        assert_eq!(
            user_owned,
            Writability::Writable,
            "{service}: the user's own file must be detected writable"
        );
        assert_eq!(after, before, "{service}: the probe must not modify files");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn root_owned_file_is_detected_read_only_on_the_sudo_host() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }
        assert_root_owned_file_detected_read_only("ssh-sudo", port).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn root_owned_file_is_detected_read_only_on_the_nosudo_host() {
        let port = env_port("TERMIHUB_TEST_SSH_NOSUDO_PORT", DEFAULT_SSH_NOSUDO_PORT);
        if !fixture_ready("ssh-nosudo", port) {
            return;
        }
        assert_root_owned_file_detected_read_only("ssh-nosudo", port).await;
    }

    /// The fixture's root-owned file is detected read-only and an exec-capable
    /// host reports exec capability, which is what makes the editor offer
    /// "Edit with sudo" rather than the SFTP-only fallback.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(elevated_save)]
    async fn sudo_host_reports_exec_capability_so_no_fallback_is_needed() {
        let port = env_port("TERMIHUB_TEST_SSH_SUDO_PORT", DEFAULT_SSH_SUDO_PORT);
        if !fixture_ready("ssh-sudo", port) {
            return;
        }
        trust_fixture_host_keys();
        let browser = SftpFileBrowser::new(testuser_config(port, "testpass"));
        assert!(
            browser
                .has_exec_capability()
                .await
                .expect("probe exec capability"),
            "a shell host must be exec-capable"
        );
    }

    /// SFTP-only host (`ForceCommand internal-sftp`, #1330): no exec channel, so
    /// the editor cannot elevate. A root-owned file is still detected
    /// read-only, and the fallback's "Save a copy" to a writable path in the
    /// user's home lands over SFTP alone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sftp_only_host_takes_the_read_only_fallback_and_saves_a_copy() {
        use termihub_core::files::FileBrowser;

        let port = env_port(
            "TERMIHUB_TEST_SSH_SFTP_ONLY_PORT",
            DEFAULT_SSH_SFTP_ONLY_PORT,
        );
        if !fixture_ready("ssh-sftp-only", port) {
            return;
        }
        trust_fixture_host_keys();
        let browser = SftpFileBrowser::new(testuser_config(port, "testpass"));

        assert!(
            !browser
                .has_exec_capability()
                .await
                .expect("probe exec capability"),
            "an SFTP-only host must not be exec-capable (no Edit with sudo)"
        );
        assert_eq!(
            browser
                .check_writable("/etc/passwd")
                .await
                .expect("probe the root-owned file"),
            Writability::ReadOnly,
            "a root-owned file must be detected read-only over SFTP alone"
        );

        // "Save a copy" to the user's home, the editor's suggested destination.
        let home = browser.realpath(".").await.expect("resolve the home dir");
        let copy = format!("{home}/termihub-save-copy-{}.txt", uuid::Uuid::new_v4());
        let buffer = b"edited buffer saved as a copy\n";
        browser
            .write_file(&copy, buffer)
            .await
            .expect("save a copy to a writable path");
        let read_back = browser.read_file(&copy).await.expect("read the copy back");
        let copy_writable = browser.check_writable(&copy).await;
        browser.delete(&copy).await.expect("remove the copy");

        assert_eq!(read_back, buffer, "the copy must hold the buffer");
        assert_eq!(
            copy_writable.expect("probe the copy"),
            Writability::Writable,
            "the saved copy must be writable"
        );
    }
}
