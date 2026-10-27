//! Following a WSL shell's directory without touching the shell (#5013).
//!
//! Stub: the reader is implemented in the next commit.

use std::time::Duration;

/// Identification attempts before the session stops probing for good.
pub(crate) const MAX_IDENTIFY_FAILURES: u32 = 3;

/// The probe script (see the module docs).
pub(crate) const WSL_CWD_SCRIPT: &str = "";

/// One terminal session's top process, as the probe saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbedShell {
    pub pid: u32,
    pub start_ticks: u64,
    pub cwd: Option<String>,
}

/// One run of the probe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Probe {
    pub uptime: f64,
    pub hz: u64,
    pub shells: Vec<ProbedShell>,
}

/// Parse the probe's stdout.
pub(crate) fn parse_probe(_stdout: &[u8]) -> Option<Probe> {
    None
}

/// The `wsl.exe` arguments that run the probe in `distribution`.
pub(crate) fn probe_args(_distribution: &str) -> Vec<String> {
    Vec::new()
}

/// Which distro shell is this session's.
#[derive(Debug, Default)]
pub(crate) struct WslShellTracker;

impl WslShellTracker {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) fn gave_up(&self) -> bool {
        false
    }

    pub(crate) fn read(
        &mut self,
        _stdout: Option<&[u8]>,
        _since_spawn: Duration,
    ) -> Option<String> {
        None
    }
}

#[cfg(test)]
#[path = "wsl_cwd_tests.rs"]
mod tests;
