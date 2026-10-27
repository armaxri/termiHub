//! Following a WSL shell's directory without touching the shell (#5013).
//!
//! Like local and SSH sessions (#5009), a WSL session's file browser follows
//! the shell's directory with nothing typed into the shell: termiHub reads
//! the directory of the shell's process from `/proc` inside the distribution
//! and adds the OSC 7 to the output itself
//! ([`CwdFollower`](crate::session::cwd_follow::CwdFollower) decides when).
//!
//! # Reading it
//!
//! A short-lived `wsl.exe -d <distro> --exec sh -c` runs [`WSL_CWD_SCRIPT`]
//! (POSIX `sh`, so the user's login shell does not matter). The
//! `\\wsl.localhost` share is no alternative: Windows cannot read a WSL
//! symlink's target over it (see the file browser's `readlink` helper), and
//! `/proc/<pid>/cwd` is such a link.
//!
//! # Finding this session's shell
//!
//! Every terminal session in the distribution — termiHub's, or one in another
//! terminal app — has a top process on a terminal (`tty_nr` ≠ 0) whose parent
//! is not on the same terminal (WSL's relay, `tmux`, `sshd`, …). The script
//! lists them with their start time and the directory of the terminal's
//! foreground process (a nested shell or a running program; the top process
//! itself when that is unreadable), then prints the distribution's uptime
//! last. The probe's own terminal is left out: `wsl.exe` gives even a piped
//! `--exec` a terminal when it has a console.
//!
//! The Windows side knows when it spawned `wsl.exe`, so the session's shell
//! is the oldest one that started after that ([`WslShellTracker`]): a shell
//! whose age is larger than the time since the spawn was there before.
//! When two shells started within [`AMBIGUOUS_GAP`] of each other the
//! tracker does not guess — the file browser then just does not follow.
//! Once found, the shell is followed by `(pid, start time)`, so a reused pid
//! is never mistaken for it.
//!
//! The session stops probing for good when its shell could not be found
//! [`MAX_IDENTIFY_FAILURES`] times in a row (no `sh`, no `/proc`, two shells
//! started together, no shell [`STARTUP_GRACE`] after the spawn), or when the shell it found is gone (a distribution's
//! first-launch user setup that hands over to a new shell).

use std::time::Duration;

/// Identification attempts before the session stops probing for good.
pub(crate) const MAX_IDENTIFY_FAILURES: u32 = 3;

/// Clock tolerance between the Windows side and the distribution.
const CLOCK_SLACK: f64 = 0.3;

/// How long after the spawn a probe that finds no shell yet is not counted
/// as a failure.
pub(crate) const STARTUP_GRACE: Duration = Duration::from_secs(30);

/// Two shells that started closer together than this cannot be told apart.
pub(crate) const AMBIGUOUS_GAP: Duration = Duration::from_secs(1);

/// Prints, for every terminal session's top process,
/// `TH_SH:<pid> <start ticks> <cwd>`, then `TH_UP:<uptime>` and
/// `TH_HZ:<ticks per second>` (see the module docs). Only `sh` builtins in
/// the `/proc` loop, so it costs one `awk` plus one `readlink` per session.
pub(crate) const WSL_CWD_SCRIPT: &str = r#"
hz=$(getconf CLK_TCK 2>/dev/null) || hz=100
me=0
if { read -r s < "/proc/$$/stat"; } 2>/dev/null; then r=${s##*) }; set -- $r; me=$5; fi
for d in /proc/[0-9]*; do
  { read -r s < "$d/stat"; } 2>/dev/null || continue
  r=${s##*) }
  set -- $r
  echo "${d#/proc/} $2 $5 $6 ${20}"
done | awk -v me="$me" '{ p[NR]=$1; pp[NR]=$2; t[$1]=$3; fg[NR]=$4; st[NR]=$5 }
  END { for (i = 1; i <= NR; i++) { x = t[p[i]]
    if (x != 0 && x != me && t[pp[i]] != x) print p[i], fg[i], st[i] } }' |
while read -r pid fg st; do
  c=
  for x in $fg $pid; do
    [ "$x" -gt 0 ] 2>/dev/null || continue
    c=$(readlink "/proc/$x/cwd" 2>/dev/null) && [ -n "$c" ] && break
    c=
  done
  echo "TH_SH:$pid $st $c"
done
read -r up _ < /proc/uptime
echo "TH_UP:$up"
echo "TH_HZ:$hz"
"#;

/// One terminal session's top process, as the probe saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbedShell {
    pub pid: u32,
    pub start_ticks: u64,
    /// `None` when unreadable (another user's process, e.g. `sudo -i`).
    pub cwd: Option<String>,
}

/// One run of the probe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Probe {
    /// Seconds since the distribution's (VM's) boot.
    pub uptime: f64,
    /// Clock ticks per second of [`ProbedShell::start_ticks`].
    pub hz: u64,
    pub shells: Vec<ProbedShell>,
}

impl Probe {
    /// How long ago `shell` started, in seconds.
    fn age(&self, shell: &ProbedShell) -> f64 {
        self.uptime - shell.start_ticks as f64 / self.hz as f64
    }
}

/// Parse the probe's stdout; `None` when it did not run to the end.
pub(crate) fn parse_probe(stdout: &[u8]) -> Option<Probe> {
    let text = String::from_utf8_lossy(stdout);
    let mut uptime = None;
    let mut hz = None;
    let mut shells = Vec::new();
    for line in text.lines().map(|l| l.trim_end_matches('\r')) {
        if let Some(v) = line.strip_prefix("TH_UP:") {
            uptime = v.trim().parse::<f64>().ok();
        } else if let Some(v) = line.strip_prefix("TH_HZ:") {
            hz = v.trim().parse::<u64>().ok();
        } else if let Some(v) = line.strip_prefix("TH_SH:") {
            let mut parts = v.splitn(3, ' ');
            let (Some(pid), Some(start)) = (parts.next(), parts.next()) else {
                continue;
            };
            let (Ok(pid), Ok(start_ticks)) = (pid.parse(), start.parse()) else {
                continue;
            };
            let cwd = parts
                .next()
                .filter(|c| c.starts_with('/'))
                .map(str::to_string);
            shells.push(ProbedShell {
                pid,
                start_ticks,
                cwd,
            });
        }
    }
    Some(Probe {
        uptime: uptime?,
        hz: hz.filter(|&h| h > 0).unwrap_or(100),
        shells,
    })
}

/// The `wsl.exe` arguments that run the probe in `distribution`.
pub(crate) fn probe_args(distribution: &str) -> Vec<String> {
    super::wsl_exec::distro_sh_args(distribution, WSL_CWD_SCRIPT, &[])
}

/// Which shell in the distribution is this session's (see the module docs).
#[derive(Debug, Default)]
pub(crate) struct WslShellTracker {
    /// `(pid, start ticks)` of the session's shell, once found.
    shell: Option<(u32, u64)>,
    failures: u32,
}

impl WslShellTracker {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Whether the shell could not be found too often: stop probing.
    pub(crate) fn gave_up(&self) -> bool {
        self.failures >= MAX_IDENTIFY_FAILURES
    }

    /// The session's directory from one probe's `stdout` (`None`: the probe
    /// failed), `since_spawn` after `wsl.exe` was spawned (measured when the
    /// probe returned).
    pub(crate) fn read(&mut self, stdout: Option<&[u8]>, since_spawn: Duration) -> Option<String> {
        let Some(probe) = stdout.and_then(parse_probe) else {
            self.failures += 1;
            return None;
        };
        if let Some((pid, start)) = self.shell {
            if let Some(shell) = probe
                .shells
                .iter()
                .find(|s| s.pid == pid && s.start_ticks == start)
            {
                return shell.cwd.clone();
            }
            // The shell is gone (or its pid was reused). Never look again:
            // by now any later terminal would pass for it.
            self.failures = MAX_IDENTIFY_FAILURES;
            return None;
        }
        match identify(&probe, since_spawn) {
            Identified::Shell(shell) => {
                self.failures = 0;
                self.shell = Some((shell.pid, shell.start_ticks));
                shell.cwd.clone()
            }
            // `wsl.exe` paints (ConPTY's first screen) before the shell runs,
            // and a cold distribution takes a while to boot.
            Identified::NotYet if since_spawn < STARTUP_GRACE => None,
            Identified::NotYet | Identified::Ambiguous => {
                self.failures += 1;
                None
            }
        }
    }
}

/// What [`identify`] found.
enum Identified<'a> {
    Shell(&'a ProbedShell),
    /// No shell started after the spawn (yet).
    NotYet,
    /// Two started too close together to tell apart.
    Ambiguous,
}

/// The oldest shell that started after the spawn, unless another started
/// too close to it to tell them apart.
fn identify(probe: &Probe, since_spawn: Duration) -> Identified<'_> {
    let max_age = since_spawn.as_secs_f64() + CLOCK_SLACK;
    let mut newer: Vec<&ProbedShell> = probe
        .shells
        .iter()
        .filter(|s| probe.age(s) <= max_age)
        .collect();
    newer.sort_by_key(|s| s.start_ticks);
    let Some(&first) = newer.first() else {
        return Identified::NotYet;
    };
    if let Some(second) = newer.get(1) {
        let gap = (second.start_ticks - first.start_ticks) as f64 / probe.hz as f64;
        if gap < AMBIGUOUS_GAP.as_secs_f64() {
            return Identified::Ambiguous;
        }
    }
    Identified::Shell(first)
}

#[cfg(test)]
#[path = "wsl_cwd_tests.rs"]
mod tests;
