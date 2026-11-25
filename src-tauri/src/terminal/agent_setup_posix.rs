//! The agent setup script for POSIX hosts (#5822, #5999).
//!
//! The script itself is `agent_setup_posix.sh`; its head says how it keeps a
//! working agent through a failure at any point. The setup uploads it next to
//! the agent and `exec`s it in the setup tab's shell, so its exit code is the
//! tab's: 0 installed, anything else failed, with two codes that say more.

/// The script's exit code when the setup failed and the agent that was
/// installed before is still in place and starts. The setup tab reads it
/// (`agentSetupTabNotice`).
pub(super) const EXIT_PREVIOUS_KEPT: i32 = 10;

/// The script's exit code when the new agent is installed and starts, but its
/// systemd service could not be set up.
pub(super) const EXIT_SERVICE_FAILED: i32 = 11;

/// The script, with `__PLACEHOLDER__`s for [`generate_setup_script`].
pub(super) const SETUP_SCRIPT_TEMPLATE: &str = include_str!("agent_setup_posix.sh");

/// Generate the POSIX setup script that installs `binary_src` to `remote_path`.
///
/// `remote_path` was checked by `validate_posix_agent_path` and `binary_src`
/// is inside a dir checked by `parse_prepared_upload_dir`, so both are safe
/// inside double quotes.
pub fn generate_setup_script(remote_path: &str, install_service: bool, binary_src: &str) -> String {
    let service_flag = if install_service { "true" } else { "false" };
    without_markers(&fill_setup_script(remote_path, service_flag, binary_src))
}

fn fill_setup_script(remote_path: &str, service_flag: &str, binary_src: &str) -> String {
    SETUP_SCRIPT_TEMPLATE
        .replace("__BINARY_SRC__", binary_src)
        .replace("__INSTALL_PATH__", remote_path)
        .replace("__INSTALL_SERVICE__", service_flag)
        .replace("__EXIT_PREVIOUS_KEPT__", &EXIT_PREVIOUS_KEPT.to_string())
        .replace("__EXIT_SERVICE_FAILED__", &EXIT_SERVICE_FAILED.to_string())
}

/// Drop the `#@` lines, which only the tests use.
fn without_markers(script: &str) -> String {
    script
        .lines()
        .filter(|line| line.trim() != "#@")
        .map(|line| format!("{line}\n"))
        .collect()
}

#[cfg(test)]
#[path = "agent_setup_posix_tests.rs"]
mod tests;
