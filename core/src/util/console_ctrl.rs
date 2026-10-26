//! Keep Ctrl+C working in the processes a PTY session starts (Windows).
//!
//! Windows keeps a per-process "ignore Ctrl+C" attribute, and every child
//! process inherits it. A process gets it when its parent spawned it with
//! `CREATE_NEW_PROCESS_GROUP` or called `SetConsoleCtrlHandler(NULL, TRUE)`
//! before the spawn, and it then passes it on to *its* children. So when
//! termiHub is started by such a launcher (a CI runner, a service wrapper, a
//! script host, the agent's detached daemon), every shell it hosts in a ConPTY
//! inherits it too: a `\x03` typed into the tab reaches the pseudoconsole, the
//! console host turns it into `CTRL_C_EVENT`, and the foreground program
//! (`ping`, PowerShell's `Start-Sleep`, …) never sees it (#4828, #4981).
//!
//! [`restore_ctrl_c_for_children`] clears that attribute for the calling process
//! right before a PTY child is spawned, so the child starts with normal Ctrl+C
//! processing. It never changes how this process itself treats Ctrl+C beyond
//! the default: a GUI desktop app or a detached daemon is attached to no console
//! and receives no console Ctrl+C events, and a console-attached process (a
//! debug build, the agent started by hand) gets the default behaviour, which is
//! what an unaffected launch has anyway. A no-op on every other platform, where
//! a PTY delivers `SIGINT` to the foreground process group regardless.

/// Clear this process's inherited "ignore Ctrl+C" attribute so the processes it
/// spawns from now on handle Ctrl+C normally (Windows).
///
/// Idempotent and cheap; call it before every PTY spawn. Returns the OS error if
/// the call fails; callers treat that as non-fatal (the session still works,
/// only Ctrl+C may not interrupt). A no-op returning `Ok(())` off Windows.
pub fn restore_ctrl_c_for_children() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        // SAFETY: a plain Win32 call; a `None` handler with `FALSE` only clears
        // the process's inherited ignore-Ctrl+C attribute.
        if unsafe { SetConsoleCtrlHandler(None, 0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_ctrl_c_for_children_succeeds_and_is_idempotent() {
        restore_ctrl_c_for_children().expect("first call succeeds");
        restore_ctrl_c_for_children().expect("a repeat call succeeds");
    }
}
