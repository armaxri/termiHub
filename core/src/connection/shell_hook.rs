//! The one-time reset of the old shell-hook default (#5009).
//!
//! Until #5009 local and SSH connections defaulted to `shellIntegration: true`,
//! which types a hook into the user's shell, and the connection form saved that
//! default into every connection. The file browser now follows a shell's
//! directory without a hook, and the hook (for command marks only) is opt-in.
//! The connection stores therefore switch a saved `true` off **once**, as a
//! numbered schema step: the store is then saved at the new version, so an
//! opt-in the user makes afterwards is never reset again.

/// The settings key of the opt-in shell hook.
pub const SHELL_HOOK_KEY: &str = "shellIntegration";

/// Connection types whose hook became opt-in: local shells (`local`, the
/// agent's `shell`) and SSH. WSL keeps its hook (#5013).
fn hook_became_opt_in(type_id: &str) -> bool {
    matches!(type_id, "local" | "shell" | "ssh")
}

/// Switch a saved `shellIntegration: true` off for a connection of
/// `type_id`. Returns whether it changed anything.
pub fn reset_old_shell_hook_default(type_id: &str, settings: &mut serde_json::Value) -> bool {
    if !hook_became_opt_in(type_id) {
        return false;
    }
    match settings.get_mut(SHELL_HOOK_KEY) {
        Some(value) if value.as_bool() == Some(true) => {
            *value = serde_json::Value::Bool(false);
            true
        }
        _ => false,
    }
}

/// Stub (#5013): implemented in the next commit.
pub fn reset_old_wsl_shell_hook_default(_type_id: &str, _settings: &mut serde_json::Value) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_saved_true_on_local_or_ssh_is_switched_off() {
        for type_id in ["local", "shell", "ssh"] {
            let mut s = json!({ "shellIntegration": true, "host": "h" });
            assert!(reset_old_shell_hook_default(type_id, &mut s));
            assert_eq!(s, json!({ "shellIntegration": false, "host": "h" }));
        }
        // WSL has its own, later step (#5013).
        let mut wsl = json!({ "shellIntegration": true });
        assert!(!reset_old_shell_hook_default("wsl", &mut wsl));
        assert_eq!(wsl, json!({ "shellIntegration": true }));
        let mut absent = json!({ "host": "h" });
        assert!(!reset_old_shell_hook_default("ssh", &mut absent));
        assert_eq!(absent, json!({ "host": "h" }));
    }

    #[test]
    fn only_a_saved_true_on_wsl_is_switched_off_by_the_wsl_step() {
        let mut wsl = json!({ "shellIntegration": true, "distribution": "D" });
        assert!(reset_old_wsl_shell_hook_default("wsl", &mut wsl));
        assert_eq!(
            wsl,
            json!({ "shellIntegration": false, "distribution": "D" })
        );
        for type_id in ["local", "shell", "ssh"] {
            let mut s = json!({ "shellIntegration": true });
            assert!(
                !reset_old_wsl_shell_hook_default(type_id, &mut s),
                "{type_id}"
            );
            assert_eq!(s, json!({ "shellIntegration": true }));
        }
        let mut off = json!({ "shellIntegration": false });
        assert!(!reset_old_wsl_shell_hook_default("wsl", &mut off));
    }
}
