//! Regression test for #406: agent binary must be invoked with a full path
//! in non-interactive SSH exec channels.
//!
//! Non-interactive SSH sessions typically do NOT include `~/.local/bin` in
//! PATH (only `/usr/local/bin:/usr/bin:/bin` etc.). This test proves:
//! 1. A script placed in `~/.local/bin/` is NOT found via a bare command name.
//! 2. The same script IS found when invoked with `$HOME/.local/bin/…` (full path).
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{require_docker, ssh_exec, ssh_password_config, PORT_SSH_PASSWORD};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

/// Install a tiny dummy script in `~/.local/bin/` and verify that a bare
/// command name does NOT find it, while the `$HOME/…` full path does.
///
/// This reproduces the exact failure mode of #406.
#[test]
fn ssh_exec_bare_name_not_in_path() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = ssh_password_config(PORT_SSH_PASSWORD);
    let session = connect_and_authenticate(&config).expect("SSH auth should succeed");

    // 1. Create a dummy script at ~/.local/bin/termihub-test-probe
    let setup = ssh_exec(
        &session,
        "mkdir -p \"$HOME/.local/bin\" && \
         printf '#!/bin/sh\\necho probe-ok\\n' > \"$HOME/.local/bin/termihub-test-probe\" && \
         chmod +x \"$HOME/.local/bin/termihub-test-probe\" && \
         echo setup-done",
    )
    .expect("setup should succeed");
    assert!(setup.trim().contains("setup-done"), "Setup failed: {setup}");

    // 2. Bare command name — should NOT be in PATH for non-interactive exec
    let bare_result = ssh_exec(&session, "termihub-test-probe 2>&1 || echo BARE_FAILED");
    let bare_output = bare_result.unwrap_or_default();
    assert!(
        bare_output.contains("BARE_FAILED") || bare_output.contains("not found"),
        "Expected bare command to fail (not in PATH), but got: {bare_output}"
    );

    // 3. Full $HOME path — should always work (this is the fix for #406)
    let full_result = ssh_exec(
        &session,
        "$HOME/.local/bin/termihub-test-probe 2>&1 || echo FULL_FAILED",
    );
    let full_output = full_result.expect("full path exec should succeed");
    assert!(
        full_output.contains("probe-ok"),
        "Expected full-path command to succeed with 'probe-ok', but got: {full_output}"
    );

    // 4. Cleanup
    let _ = ssh_exec(&session, "rm -f \"$HOME/.local/bin/termihub-test-probe\"");
}
