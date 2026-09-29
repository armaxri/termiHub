//! Spawn short-lived helper processes without flashing a console window on
//! Windows (#3814).
//!
//! Release builds of the desktop app use the GUI subsystem
//! (`windows_subsystem = "windows"`), so every console child it spawns
//! (`netstat`, `wsl.exe`, `docker`, `cmd /c code`, …) gets a fresh console
//! window unless the spawn sets [`CREATE_NO_WINDOW`]. A periodic or per-row
//! spawn then flashes windows several times a second, which looks like malware.
//!
//! Every helper spawn that runs on Windows goes through [`no_window_command`]
//! (or [`hide_console_window`] for a command built elsewhere). On every other
//! platform both are plain pass-throughs.

use std::ffi::OsStr;
use std::process::Command;

/// Windows `CREATE_NO_WINDOW` process-creation flag.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Mark `command` so that, on Windows, its child never gets a console window.
///
/// Sets the creation flags to [`CREATE_NO_WINDOW`] (replacing any earlier
/// `creation_flags` call). A no-op on non-Windows platforms. Returns the
/// command for chaining.
pub fn hide_console_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// `Command::new(program)` that never flashes a console window on Windows.
///
/// Use this for every helper process (probes, listings, version checks).
/// Convert with `tokio::process::Command::from` for async spawns.
pub fn no_window_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    hide_console_window(&mut command);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_no_window_is_the_win32_flag() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[cfg(windows)]
    #[test]
    fn no_window_flag_matches_windows_sys() {
        assert_eq!(
            CREATE_NO_WINDOW,
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
        );
    }

    /// Environment variable that turns [`console_probe_helper`] from a no-op
    /// into the child-side probe.
    #[cfg(windows)]
    const PROBE_ENV: &str = "TERMIHUB_NO_WINDOW_PROBE";

    /// Child side of [`no_window_command_child_has_no_console`]: reports
    /// whether this process owns a console window. A no-op in a normal run.
    #[cfg(windows)]
    #[test]
    fn console_probe_helper() {
        if std::env::var_os(PROBE_ENV).is_none() {
            return;
        }
        // SAFETY: `GetConsoleWindow` takes no arguments and only reads the
        // calling process's console attachment.
        let hwnd = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
        println!("NO_WINDOW_PROBE_CONSOLE={}", u8::from(!hwnd.is_null()));
    }

    /// Re-exec this test binary running only [`console_probe_helper`] and
    /// return the console marker it printed.
    #[cfg(windows)]
    fn probe_console(mut command: Command) -> String {
        let output = command
            .args([
                "--exact",
                "util::no_window::tests::console_probe_helper",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(PROBE_ENV, "1")
            .output()
            .expect("run console probe helper");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(output.status.success(), "probe helper failed: {stdout}");
        // libtest prints the marker on the same line as `test <name> ... `.
        stdout
            .split("NO_WINDOW_PROBE_CONSOLE=")
            .nth(1)
            .and_then(|rest| rest.chars().next())
            .map(String::from)
            .unwrap_or_else(|| panic!("probe marker missing from: {stdout}"))
    }

    /// A child spawned through the shared helper has no console window at all,
    /// while the same child forced onto a new console does — proving the probe
    /// can see a console and that the helper really sets `CREATE_NO_WINDOW`.
    #[cfg(windows)]
    #[test]
    fn no_window_command_child_has_no_console() {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

        let exe = std::env::current_exe().expect("current test exe");

        let mut control = Command::new(&exe);
        control.creation_flags(CREATE_NEW_CONSOLE);
        assert_eq!(
            probe_console(control),
            "1",
            "control child on a new console must see a console window"
        );

        assert_eq!(
            probe_console(no_window_command(&exe)),
            "0",
            "a child spawned via no_window_command must have no console window"
        );
    }
}
