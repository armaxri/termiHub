//! Decide when the WSL shell is ready for the shell-integration `source` line
//! (#4057).
//!
//! The WSL backend injects `source /tmp/.termihub_init-<uuid> 2>/dev/null` into
//! the PTY once the shell is up. On a distribution that has never been launched,
//! `wsl.exe -d <distro>` does not start a shell — it runs the distro's
//! first-launch user setup ("OOBE"):
//!
//! ```text
//! Please create a default UNIX user account. The username does not need to match ...
//! Enter new UNIX username:
//! ```
//!
//! The old "first OSC 7, or 500 ms of quiet, or 5 s" heuristic fired on that
//! prompt and typed the `source` line in as the username. This module replaces
//! it with a detector that only injects once a shell prompt is plausible:
//!
//! - An OSC 7 / OSC 133 sequence is a definitive prompt marker → inject.
//! - Quiet after *visible* output → inject, **unless** the output is blocked:
//!   the first-launch setup is running (a known OOBE line was seen and no prompt
//!   has followed) or the current line is an input request (`…:`, `…?`,
//!   `[Y/n]`). While blocked, only a prompt marker or a line that looks like a
//!   shell prompt (`…$`, `…#`, `…%`, `…>`, `❯`) releases it.
//! - No visible output by the normal deadline (slow start) → keep waiting
//!   rather than typing blind into whatever comes up first.
//! - A long setup cap bounds the wait; on expiry nothing is injected (the
//!   next session gets shell integration, since setup has then completed).
//!
//! Pure and platform-independent so the transcript tests run on every CI leg;
//! only the thin caller in the `#[cfg(windows)]` `wsl` module is Windows-only.

use std::time::Duration;

/// Lower-case fragments of the WSL first-launch setup (OOBE) output.
///
/// Matching any of them means the PTY is talking to `adduser`/`passwd`, not a
/// shell, so nothing may be typed into it.
const FIRST_LAUNCH_MARKERS: &[&str] = &[
    "installing, this may take a few minutes",
    "please create a default unix user account",
    "enter new unix username",
    "new password:",
    "retype new password:",
    "is the information correct?",
];

/// Cap for the rolling visible-text buffers (bytes).
const TEXT_CAP: usize = 512;

/// Cap for the OSC payload prefix kept for marker detection (bytes).
const OSC_PREFIX_CAP: usize = 8;

/// What the caller should do after an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadyDecision {
    /// Not ready yet — keep watching.
    Wait,
    /// A shell prompt is (plausibly) up — inject the `source` line now.
    Inject,
}

/// Escape-sequence parser state, carried across chunk boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscState {
    Ground,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

/// Incremental readiness detector over raw PTY output.
#[derive(Debug)]
pub(crate) struct ShellReadyDetector {
    esc: EscState,
    osc_prefix: Vec<u8>,
    /// Visible text of the current line (escape sequences stripped).
    line: Vec<u8>,
    /// Lower-cased visible text since the last prompt marker / setup match.
    recent: Vec<u8>,
    /// Any non-whitespace visible text seen yet.
    visible_output: bool,
    /// The first-launch setup is running and no prompt has followed it.
    in_first_launch_setup: bool,
    /// An OSC 7 / 133 prompt marker was seen after any setup output.
    prompt_marker: bool,
}

impl Default for ShellReadyDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellReadyDetector {
    pub(crate) fn new() -> Self {
        Self {
            esc: EscState::Ground,
            osc_prefix: Vec::new(),
            line: Vec::new(),
            recent: Vec::new(),
            visible_output: false,
            in_first_launch_setup: false,
            prompt_marker: false,
        }
    }

    /// Whether any visible (non-whitespace) output has arrived.
    pub(crate) fn has_visible_output(&self) -> bool {
        self.visible_output
    }

    /// Whether the first-launch user setup is currently running.
    #[cfg(test)]
    pub(crate) fn in_first_launch_setup(&self) -> bool {
        self.in_first_launch_setup
    }

    /// Feed one chunk of PTY output.
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> ReadyDecision {
        for &b in chunk {
            self.step(b);
        }
        self.scan_first_launch_markers();
        if self.prompt_marker && !self.in_first_launch_setup {
            ReadyDecision::Inject
        } else {
            ReadyDecision::Wait
        }
    }

    /// The output has been quiet for the idle period.
    pub(crate) fn on_idle(&mut self) -> ReadyDecision {
        if !self.visible_output {
            // Only blank-screen paint so far (ConPTY clears the screen before
            // the distro prints anything) — the real first output is pending.
            return ReadyDecision::Wait;
        }
        if self.is_blocked() {
            if self.line_looks_like_shell_prompt() {
                // Setup finished and a shell prompt is sitting there.
                self.in_first_launch_setup = false;
                return ReadyDecision::Inject;
            }
            return ReadyDecision::Wait;
        }
        ReadyDecision::Inject
    }

    /// The normal (short) deadline expired while output was still streaming.
    ///
    /// Preserves the old "always make progress" behaviour for a busy but
    /// healthy shell, but never injects blind (no visible output yet) or into a
    /// blocked prompt — those keep waiting under the caller's long cap.
    pub(crate) fn on_deadline(&mut self) -> ReadyDecision {
        if self.visible_output && !self.is_blocked() {
            ReadyDecision::Inject
        } else {
            ReadyDecision::Wait
        }
    }

    fn is_blocked(&self) -> bool {
        self.in_first_launch_setup || self.line_is_input_request()
    }

    fn step(&mut self, b: u8) {
        match self.esc {
            EscState::Ground => match b {
                0x1b => self.esc = EscState::Esc,
                b'\n' | b'\r' => {
                    self.line.clear();
                    self.push_recent(b'\n');
                }
                0x08 => {
                    self.line.pop();
                }
                b'\t' => self.push_text(b' '),
                0x00..=0x1f | 0x7f => {}
                _ => self.push_text(b),
            },
            EscState::Esc => match b {
                b'[' => self.esc = EscState::Csi,
                b']' => {
                    self.osc_prefix.clear();
                    self.esc = EscState::Osc;
                }
                _ => self.esc = EscState::Ground,
            },
            EscState::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    // Cursor home / screen clear start a fresh visible line.
                    if matches!(b, b'H' | b'J' | b'f') {
                        self.line.clear();
                    }
                    self.esc = EscState::Ground;
                }
            }
            EscState::Osc => match b {
                0x07 => self.esc = EscState::Ground,
                0x1b => self.esc = EscState::OscEsc,
                _ => {
                    if self.osc_prefix.len() < OSC_PREFIX_CAP {
                        self.osc_prefix.push(b);
                        if self.osc_prefix == b"7;" || self.osc_prefix == b"133;" {
                            self.on_prompt_marker();
                        }
                    }
                }
            },
            EscState::OscEsc => {
                // ESC \ (ST) ends the OSC; anything else is malformed — bail out.
                self.esc = EscState::Ground;
            }
        }
    }

    fn on_prompt_marker(&mut self) {
        self.prompt_marker = true;
        self.in_first_launch_setup = false;
        self.recent.clear();
    }

    fn push_text(&mut self, b: u8) {
        if !b.is_ascii_whitespace() {
            self.visible_output = true;
        }
        push_capped(&mut self.line, b);
        self.push_recent(b.to_ascii_lowercase());
    }

    fn push_recent(&mut self, b: u8) {
        push_capped(&mut self.recent, b);
    }

    fn scan_first_launch_markers(&mut self) {
        let recent = String::from_utf8_lossy(&self.recent);
        if FIRST_LAUNCH_MARKERS.iter().any(|m| recent.contains(m)) {
            self.in_first_launch_setup = true;
            self.prompt_marker = false;
            self.recent.clear();
        }
    }

    fn trimmed_line(&self) -> String {
        String::from_utf8_lossy(&self.line).trim_end().to_string()
    }

    /// The cursor sits after a question/field label waiting for an answer.
    fn line_is_input_request(&self) -> bool {
        let line = self.trimmed_line();
        let lower = line.to_ascii_lowercase();
        line.ends_with(':')
            || line.ends_with('?')
            || lower.ends_with("[y/n]")
            || lower.ends_with("(y/n)")
    }

    /// The current line ends the way common shell prompts do.
    fn line_looks_like_shell_prompt(&self) -> bool {
        let line = self.trimmed_line();
        ['$', '#', '%', '>', '\u{276f}', '\u{279c}', '\u{3bb}']
            .iter()
            .any(|c| line.ends_with(*c))
    }
}

fn push_capped(buf: &mut Vec<u8>, b: u8) {
    if buf.len() >= TEXT_CAP {
        buf.drain(..TEXT_CAP / 2);
    }
    buf.push(b);
}

/// Timing knobs for [`wait_for_shell_ready`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReadyTimings {
    /// Quiet period after output that counts as "settled".
    pub idle: Duration,
    /// Normal deadline: a still-streaming, unblocked shell is injected here.
    pub deadline: Duration,
    /// Hard cap while blocked (first-launch setup, input request, or no
    /// output yet). On expiry nothing is injected.
    pub setup_cap: Duration,
}

impl ReadyTimings {
    /// Production timings: 500 ms idle, 5 s deadline, 10 min setup cap.
    #[cfg(all(feature = "wsl", windows))]
    pub(crate) const DEFAULT: Self = Self {
        idle: Duration::from_millis(500),
        deadline: Duration::from_secs(5),
        setup_cap: Duration::from_secs(600),
    };
}

/// Watch the setup tap until the shell is ready.
///
/// Returns `true` when the `source` line should be injected, `false` when it
/// must not be (the session closed, or the setup cap expired while the
/// first-launch setup or another input prompt was still waiting).
pub(crate) async fn wait_for_shell_ready(
    rx: &mut tokio::sync::mpsc::Receiver<Vec<u8>>,
    timings: ReadyTimings,
) -> bool {
    let start = tokio::time::Instant::now();
    let deadline = start + timings.deadline;
    let hard_cap = start + timings.setup_cap.max(timings.deadline);
    let mut detector = ShellReadyDetector::new();
    let mut deadline_checked = false;

    loop {
        let now = tokio::time::Instant::now();
        if now >= hard_cap {
            return false;
        }
        if !deadline_checked && now >= deadline {
            deadline_checked = true;
            if detector.on_deadline() == ReadyDecision::Inject {
                return true;
            }
        }
        let next_wake = if deadline_checked { hard_cap } else { deadline };
        let until_wake = next_wake.saturating_duration_since(now);
        let idle_wait = detector.has_visible_output() && timings.idle < until_wake;
        let wait = if idle_wait { timings.idle } else { until_wake };

        match tokio::time::timeout(wait, rx.recv()).await {
            Err(_) => {
                if idle_wait && detector.on_idle() == ReadyDecision::Inject {
                    return true;
                }
            }
            Ok(None) => return false,
            Ok(Some(chunk)) => {
                if detector.feed(&chunk) == ReadyDecision::Inject {
                    return true;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real first-launch transcript from the live WSL CI lane (PR #4050, run
    /// 36852906287): ConPTY's blank-screen paint, the title OSC, then the
    /// distro's user-setup prompt.
    fn oobe_transcript() -> Vec<u8> {
        let mut out = b"\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[m\x1b[K\r\n".to_vec();
        for _ in 0..48 {
            out.extend_from_slice(b"\x1b[K\r\n");
        }
        out.extend_from_slice(
            b"\x1b[K\x1b[H\x1b]0;C:\\Windows\\System32\\wsl.exe\x07\x1b[?25h\
              Please create a default UNIX user account. The username does not need \
              to match your Windows username.\r\n\
              For more information visit: https://aka.ms/wslusers\r\n\
              Enter new UNIX username: ",
        );
        out
    }

    fn bash_prompt_with_osc7() -> &'static [u8] {
        b"\x1b]0;user@host: ~\x07\x1b]7;file:///home/user\x07\
          \x1b[01;32muser@host\x1b[00m:\x1b[01;34m~\x1b[00m$ "
    }

    fn feed_all(d: &mut ShellReadyDetector, data: &[u8]) -> ReadyDecision {
        d.feed(data)
    }

    // ── Detector over captured transcripts ─────────────────────────────

    #[test]
    fn oobe_prompt_blocks_injection_on_idle_and_deadline() {
        let mut d = ShellReadyDetector::new();
        assert_eq!(feed_all(&mut d, &oobe_transcript()), ReadyDecision::Wait);
        assert!(d.in_first_launch_setup());
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
        assert_eq!(d.on_deadline(), ReadyDecision::Wait);
    }

    #[test]
    fn oobe_prompt_split_across_byte_chunks_is_detected() {
        let mut d = ShellReadyDetector::new();
        for b in oobe_transcript() {
            assert_eq!(d.feed(&[b]), ReadyDecision::Wait);
        }
        assert!(d.in_first_launch_setup());
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
    }

    #[test]
    fn oobe_password_stage_still_blocks() {
        let mut d = ShellReadyDetector::new();
        d.feed(&oobe_transcript());
        d.feed(b"arne\r\nNew password: ");
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
        d.feed(b"\r\nRetype new password: ");
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
        // Typed username echo leaves the line not looking like a prompt.
        let mut d = ShellReadyDetector::new();
        d.feed(&oobe_transcript());
        d.feed(b"arne");
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
    }

    #[test]
    fn shell_after_oobe_releases_via_osc7() {
        let mut d = ShellReadyDetector::new();
        d.feed(&oobe_transcript());
        d.feed(b"arne\r\nNew password: \r\nRetype new password: \r\n");
        d.feed(b"passwd: password updated successfully\r\nInstallation successful!\r\n");
        assert_eq!(d.feed(bash_prompt_with_osc7()), ReadyDecision::Inject);
        assert!(!d.in_first_launch_setup());
    }

    #[test]
    fn shell_after_oobe_releases_via_prompt_heuristic() {
        let mut d = ShellReadyDetector::new();
        d.feed(&oobe_transcript());
        d.feed(b"arne\r\nNew password: \r\nRetype new password: \r\n");
        d.feed(b"Installation successful!\r\n\x1b[01;32marne@host\x1b[00m:~$ ");
        assert_eq!(d.on_idle(), ReadyDecision::Inject);
    }

    #[test]
    fn normal_bash_prompt_with_osc7_injects_immediately() {
        let mut d = ShellReadyDetector::new();
        assert_eq!(d.feed(bash_prompt_with_osc7()), ReadyDecision::Inject);
    }

    #[test]
    fn osc7_split_across_chunks_is_detected() {
        let mut d = ShellReadyDetector::new();
        assert_eq!(d.feed(b"\x1b]"), ReadyDecision::Wait);
        assert_eq!(d.feed(b"7"), ReadyDecision::Wait);
        assert_eq!(d.feed(b";file:///home/u\x07$ "), ReadyDecision::Inject);
    }

    #[test]
    fn osc133_counts_as_prompt_marker() {
        let mut d = ShellReadyDetector::new();
        assert_eq!(d.feed(b"\x1b]133;A\x1b\\% "), ReadyDecision::Inject);
    }

    #[test]
    fn title_osc_is_not_a_prompt_marker() {
        let mut d = ShellReadyDetector::new();
        assert_eq!(d.feed(b"\x1b]0;wsl.exe\x07"), ReadyDecision::Wait);
    }

    #[test]
    fn quiet_zsh_prompt_without_markers_injects_on_idle() {
        let mut d = ShellReadyDetector::new();
        d.feed(b"Welcome to Ubuntu 24.04 LTS\r\n\r\nuser@host ~ % ");
        assert_eq!(d.on_idle(), ReadyDecision::Inject);
    }

    #[test]
    fn unrecognised_prompt_still_injects_on_idle_when_not_blocked() {
        let mut d = ShellReadyDetector::new();
        d.feed(b"[user@host ~]\xce\xbb ");
        assert_eq!(d.on_idle(), ReadyDecision::Inject);
    }

    #[test]
    fn blank_screen_paint_alone_is_not_output() {
        let mut d = ShellReadyDetector::new();
        d.feed(b"\x1b[?25l\x1b[m\x1b[K\r\n\x1b[K\r\n\x1b[H\x1b]0;wsl.exe\x07");
        assert!(!d.has_visible_output());
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
        assert_eq!(d.on_deadline(), ReadyDecision::Wait);
    }

    #[test]
    fn generic_input_request_blocks() {
        for line in ["Password: ", "Continue? ", "Proceed [Y/n] "] {
            let mut d = ShellReadyDetector::new();
            d.feed(line.as_bytes());
            assert_eq!(d.on_idle(), ReadyDecision::Wait, "{line:?}");
            assert_eq!(d.on_deadline(), ReadyDecision::Wait, "{line:?}");
        }
    }

    #[test]
    fn installing_banner_blocks_slow_first_launch() {
        let mut d = ShellReadyDetector::new();
        d.feed(b"Installing, this may take a few minutes...\r\n");
        assert!(d.in_first_launch_setup());
        assert_eq!(d.on_idle(), ReadyDecision::Wait);
        assert_eq!(d.on_deadline(), ReadyDecision::Wait);
    }

    #[test]
    fn busy_unblocked_shell_injects_at_deadline() {
        let mut d = ShellReadyDetector::new();
        d.feed(b"systemd noise line\r\nmore noise\r\n");
        assert_eq!(d.on_deadline(), ReadyDecision::Inject);
    }

    // ── Async loop (paused clock) ──────────────────────────────────────

    const T: ReadyTimings = ReadyTimings {
        idle: Duration::from_millis(500),
        deadline: Duration::from_secs(5),
        setup_cap: Duration::from_secs(600),
    };

    #[tokio::test(start_paused = true)]
    async fn loop_never_injects_into_oobe_and_gives_up_at_cap() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        tx.send(oobe_transcript()).await.unwrap();
        let start = tokio::time::Instant::now();
        assert!(!wait_for_shell_ready(&mut rx, T).await);
        assert!(start.elapsed() >= T.setup_cap);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn loop_injects_once_shell_follows_oobe() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let feeder = tokio::spawn(async move {
            tx.send(oobe_transcript()).await.unwrap();
            // The user takes a minute to answer the setup prompts.
            tokio::time::sleep(Duration::from_secs(60)).await;
            tx.send(b"arne\r\nNew password: \r\nRetype new password: \r\n".to_vec())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(20)).await;
            tx.send(bash_prompt_with_osc7().to_vec()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(tx);
        });
        let start = tokio::time::Instant::now();
        assert!(wait_for_shell_ready(&mut rx, T).await);
        assert!(start.elapsed() >= Duration::from_secs(80));
        feeder.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn loop_injects_on_normal_bash_prompt() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        tx.send(bash_prompt_with_osc7().to_vec()).await.unwrap();
        let start = tokio::time::Instant::now();
        assert!(wait_for_shell_ready(&mut rx, T).await);
        assert!(start.elapsed() < Duration::from_millis(10));
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn loop_injects_quiet_prompt_after_idle() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        tx.send(b"user@host ~ % ".to_vec()).await.unwrap();
        let start = tokio::time::Instant::now();
        assert!(wait_for_shell_ready(&mut rx, T).await);
        assert_eq!(start.elapsed(), T.idle);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn loop_slow_start_waits_past_deadline_for_first_output() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let feeder = tokio::spawn(async move {
            // Distro boot takes longer than the 5 s deadline.
            tokio::time::sleep(Duration::from_secs(12)).await;
            tx.send(bash_prompt_with_osc7().to_vec()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(tx);
        });
        let start = tokio::time::Instant::now();
        assert!(wait_for_shell_ready(&mut rx, T).await);
        assert!(start.elapsed() >= Duration::from_secs(12));
        feeder.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn loop_slow_start_into_oobe_never_injects() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        let feeder = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            tx.send(b"Installing, this may take a few minutes...\r\n".to_vec())
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            tx.send(oobe_transcript()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(tx);
        });
        assert!(!wait_for_shell_ready(&mut rx, T).await);
        feeder.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn loop_busy_shell_injects_at_deadline() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let feeder = tokio::spawn(async move {
            for _ in 0..100 {
                if tx.send(b"noise\r\n".to_vec()).await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let start = tokio::time::Instant::now();
        assert!(wait_for_shell_ready(&mut rx, T).await);
        assert!(start.elapsed() >= T.deadline);
        assert!(start.elapsed() < T.deadline + Duration::from_secs(1));
        feeder.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn loop_closed_channel_does_not_inject() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        drop(tx);
        assert!(!wait_for_shell_ready(&mut rx, T).await);
    }
}
