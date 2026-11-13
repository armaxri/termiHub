//! An initial command held because the shell never announces its prompt
//! (#5509): the tab is told after the notice delay, Send now types it exactly
//! once, and the notice clears when the prompt comes after all.
//!
//! The same for a typed shell-integration setup held for the line editor's
//! mark (#5512): the initial command waits for the mark the setup brings,
//! never for a timeout, and Send now types the setup, then the command.

use super::initial_command::{
    emitted, mock_manager, open, probing_manager_with, sent, within, OutputSlot, Writes,
};
use super::*;

use std::time::Duration;

const NOTICE_AFTER: Duration = Duration::from_millis(200);

/// A manager whose session has an uncapped probe that reports the prompt
/// once `at_prompt` is set (never, for a shell with bracketed paste off).
fn held_manager() -> (SessionManager, Writes, Arc<AtomicBool>) {
    let at_prompt = Arc::new(AtomicBool::new(false));
    let flag = at_prompt.clone();
    let probe: termihub_core::connection::PromptProbe =
        Arc::new(move || flag.load(Ordering::SeqCst));
    let (mut manager, writes) = probing_manager_with(b"user@host:~$ ", Some(probe), true);
    manager.set_held_notice_after(NOTICE_AFTER);
    (manager, writes, at_prompt)
}

fn helds(emitter: &MockEventEmitter) -> Vec<bool> {
    emitter
        .initial_command_helds
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.held)
        .collect()
}

#[tokio::test]
async fn the_tab_is_told_after_the_notice_delay_and_nothing_is_typed() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    assert!(helds(&emitter).is_empty(), "no notice before the delay");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    let event = emitter.initial_command_helds.lock().unwrap()[0].clone();
    assert_eq!(event.session_id, sid);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(writes.lock().unwrap().is_empty(), "never typed blind");
    assert_eq!(emitted(&emitter), b"user@host:~$ ");
}

#[tokio::test]
async fn send_now_types_the_command_exactly_once() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    assert!(manager.send_held_initial_command(&sid));
    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    assert!(
        !manager.send_held_initial_command(&sid),
        "a second Send now sends nothing"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(&writes.lock().unwrap()[..], b"echo hi\r");
    assert_eq!(helds(&emitter), [true, false], "the notice clears");
}

#[tokio::test]
async fn send_now_before_the_notice_sends_nothing() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    assert!(!manager.send_held_initial_command(&sid));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_notice_clears_when_the_prompt_comes_after_all() {
    let (manager, writes, at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    at_prompt.store(true, Ordering::SeqCst);
    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(
        !manager.send_held_initial_command(&sid),
        "Send now after the prompt sent it does nothing"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(&writes.lock().unwrap()[..], b"echo hi\r");
}

#[tokio::test]
async fn a_prompt_before_the_delay_never_shows_the_notice() {
    let (manager, writes, at_prompt) = held_manager();
    at_prompt.store(true, Ordering::SeqCst);
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    tokio::time::sleep(NOTICE_AFTER * 2).await;
    assert!(helds(&emitter).is_empty());
}

#[tokio::test]
async fn closing_the_session_clears_the_notice() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    manager.close_session(&sid).await.expect("close");
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(!manager.send_held_initial_command(&sid));
    assert!(writes.lock().unwrap().is_empty());
}

// ── A held typed setup (#5512) ────────────────────────────────────────

/// What the mock's setup types.
const SETUP: &[u8] = b"SETUP\n";
/// The prompt-start mark the setup brings.
const MARK: &[u8] = b"\x1b]133;A\x07user@host:~$ ";

/// A typed setup that waits for the line editor's mark: [`Self::gate_opens`]
/// types it as the backend's gate would, Send now as the user's word.
struct FakeSetup {
    pending: AtomicBool,
    writes: Writes,
    output: OutputSlot,
    /// Whether typing it brings the prompt mark (a shell that runs it).
    marks: bool,
    /// [`GatedSetup::cap`]: `Some` for the canonical-mode cue (#5525).
    cap: Option<Duration>,
}

impl FakeSetup {
    fn type_it(&self) {
        if !self.pending.swap(false, Ordering::SeqCst) {
            return;
        }
        self.writes.lock().unwrap().extend_from_slice(SETUP);
        if self.marks {
            if let Some(tx) = self.output.lock().unwrap().as_ref() {
                tx.try_send(MARK.to_vec()).expect("mark fits");
            }
        }
    }

    /// The line editor announced its prompt after all.
    fn gate_opens(&self) {
        self.type_it();
    }
}

impl termihub_core::connection::GatedSetup for FakeSetup {
    fn is_pending(&self) -> bool {
        self.pending.load(Ordering::SeqCst)
    }
    fn send_now(&self) {
        self.type_it();
    }
    fn cap(&self) -> Option<Duration> {
        self.cap
    }
}

/// A manager whose session has a held setup and no probe: a shell with
/// bracketed paste off and the integration on.
fn setup_manager(marks: bool) -> (SessionManager, Writes, Arc<FakeSetup>) {
    setup_manager_capped(marks, None)
}

/// As [`setup_manager`], for a setup typed at the latest at `cap`.
fn setup_manager_capped(
    marks: bool,
    cap: Option<Duration>,
) -> (SessionManager, Writes, Arc<FakeSetup>) {
    let writes = Writes::default();
    let output = OutputSlot::default();
    let setup = Arc::new(FakeSetup {
        pending: AtomicBool::new(true),
        writes: writes.clone(),
        output: output.clone(),
        marks,
        cap,
    });
    let gated: Arc<dyn termihub_core::connection::GatedSetup> = setup.clone();
    let mut manager = mock_manager(
        b"user@host:~$ ",
        None,
        false,
        Some(gated),
        writes.clone(),
        output,
    );
    manager.set_held_notice_after(NOTICE_AFTER);
    manager.set_setup_cap_margin(CAP_MARGIN);
    (manager, writes, setup)
}

fn held_events(emitter: &MockEventEmitter) -> Vec<InitialCommandHeldEvent> {
    emitter.initial_command_helds.lock().unwrap().clone()
}

fn written(writes: &Writes) -> Vec<u8> {
    writes.lock().unwrap().clone()
}

#[tokio::test]
async fn a_held_setup_never_lets_the_initial_command_out_on_a_timeout() {
    let (manager, writes, setup) = setup_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    // Past the 1 s mark-only fallback the command used to be typed on.
    tokio::time::sleep(INITIAL_COMMAND_READY_TIMEOUT + Duration::from_millis(300)).await;
    assert!(written(&writes).is_empty(), "nothing typed blind");
    assert!(setup.pending.load(Ordering::SeqCst));
    let events = held_events(&emitter);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0],
        InitialCommandHeldEvent {
            session_id: sid,
            held: true,
            setup: true,
            initial_command: true,
        }
    );
}

#[tokio::test]
async fn send_now_types_the_setup_then_the_command_exactly_once() {
    let (manager, writes, _setup) = setup_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    assert!(manager.send_held_initial_command(&sid));
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
    assert!(
        !manager.send_held_initial_command(&sid),
        "a second Send now sends nothing"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(written(&writes), b"SETUP\necho hi\r");
    assert_eq!(helds(&emitter), [true, false], "the notice clears");
}

#[tokio::test]
async fn the_command_follows_the_setups_mark_when_the_gate_opens() {
    let (manager, writes, setup) = setup_manager(true);
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    tokio::time::sleep(Duration::from_millis(50)).await;
    setup.gate_opens();
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
    tokio::time::sleep(NOTICE_AFTER * 2).await;
    assert!(
        helds(&emitter).is_empty(),
        "no notice when the prompt came in time"
    );
    assert_eq!(written(&writes), b"SETUP\necho hi\r");
}

#[tokio::test]
async fn a_setup_without_an_initial_command_is_offered_too() {
    let (manager, writes, setup) = setup_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = manager
        .create_connection(
            "prompt",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("connect succeeds");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    let event = held_events(&emitter)[0].clone();
    assert!(event.setup && !event.initial_command, "{event:?}");
    assert!(written(&writes).is_empty());

    assert!(manager.send_held_initial_command(&sid));
    assert!(within(Duration::from_secs(2), || written(&writes) == SETUP).await);
    assert!(!setup.pending.load(Ordering::SeqCst));
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
}

#[tokio::test]
async fn a_setup_typed_by_its_gate_clears_the_setup_only_notice() {
    let (manager, writes, setup) = setup_manager(false);
    let emitter = MockEventEmitter::new();
    manager
        .create_connection(
            "prompt",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("connect succeeds");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    setup.gate_opens();
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert_eq!(written(&writes), SETUP);
}

#[tokio::test]
async fn closing_the_session_clears_a_held_setup_and_types_nothing() {
    let (manager, writes, _setup) = setup_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    manager.close_session(&sid).await.expect("close");
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(!manager.send_held_initial_command(&sid));
    assert!(written(&writes).is_empty());
}

// ── A setup on the canonical-mode cue (#5525) ─────────────────────────

/// A canonical-cue setup's cap: past the 1 s mark-only timeout.
const CAP: Duration = Duration::from_millis(1500);
const CAP_MARGIN: Duration = Duration::from_millis(300);

fn capped_manager(marks: bool) -> (SessionManager, Writes, Arc<FakeSetup>) {
    setup_manager_capped(marks, Some(CAP))
}

#[tokio::test]
async fn a_capped_setup_holds_the_command_past_the_mark_only_timeout() {
    let (manager, writes, setup) = capped_manager(true);
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    // A slow rc file: the setup's cue has not come by the 1 s fallback.
    tokio::time::sleep(INITIAL_COMMAND_READY_TIMEOUT + Duration::from_millis(200)).await;
    assert!(written(&writes).is_empty(), "nothing typed blind");
    assert!(
        helds(&emitter).is_empty(),
        "no notice before the setup's cap"
    );

    // The line editor reads: the setup goes in, its mark sends the command.
    setup.gate_opens();
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
    tokio::time::sleep(CAP + CAP_MARGIN).await;
    assert_eq!(written(&writes), b"SETUP\necho hi\r", "exactly once");
    assert!(helds(&emitter).is_empty(), "the prompt came in time");
}

#[tokio::test]
async fn a_capped_setup_without_its_mark_holds_the_command_for_send_now() {
    let (manager, writes, setup) = capped_manager(false);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    // The line editor takes over at the cap; no mark follows.
    tokio::time::sleep(CAP).await;
    setup.gate_opens();
    assert_eq!(written(&writes), SETUP);
    assert!(helds(&emitter).is_empty(), "the margin is not over yet");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    assert_eq!(
        held_events(&emitter)[0],
        InitialCommandHeldEvent {
            session_id: sid.clone(),
            held: true,
            setup: false,
            initial_command: true,
        }
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(written(&writes), SETUP, "the command is never typed blind");

    assert!(manager.send_held_initial_command(&sid));
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
    assert!(!manager.send_held_initial_command(&sid));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(written(&writes), b"SETUP\necho hi\r", "exactly once");
    assert_eq!(helds(&emitter), [true, false], "the notice clears");
}

#[tokio::test]
async fn send_now_on_a_still_pending_capped_setup_types_it_first() {
    let (manager, writes, _setup) = capped_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(4), || helds(&emitter) == [true]).await);
    assert!(held_events(&emitter)[0].setup);
    assert!(written(&writes).is_empty());

    assert!(manager.send_held_initial_command(&sid));
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
}

/// A connection without an initial command, its setup on the canonical-mode
/// cue.
async fn open_without_command(manager: &SessionManager, emitter: &MockEventEmitter) -> String {
    manager
        .create_connection(
            "prompt",
            serde_json::json!({}),
            None,
            None,
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("connect succeeds")
}

/// #5564: past its cap a canonical-cue setup is held, never typed blind,
/// even without an initial command; Send now types it once.
#[tokio::test]
async fn a_capped_setup_without_an_initial_command_is_held_for_send_now() {
    let (manager, writes, setup) = capped_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open_without_command(&manager, &emitter).await;

    tokio::time::sleep(CAP).await;
    assert!(helds(&emitter).is_empty(), "the margin is not over yet");
    assert!(written(&writes).is_empty(), "nothing typed at the cap");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    assert_eq!(
        held_events(&emitter)[0],
        InitialCommandHeldEvent {
            session_id: sid.clone(),
            held: true,
            setup: true,
            initial_command: false,
        }
    );
    assert!(written(&writes).is_empty(), "nothing typed blind");

    assert!(manager.send_held_initial_command(&sid));
    assert!(within(Duration::from_secs(2), || written(&writes) == SETUP).await);
    assert!(!setup.pending.load(Ordering::SeqCst));
    assert!(!manager.send_held_initial_command(&sid));
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(written(&writes), SETUP, "exactly once");
}

/// #5564: a late cue still types a held canonical-cue setup, and the notice
/// clears.
#[tokio::test]
async fn a_late_cue_releases_a_held_capped_setup() {
    let (manager, writes, setup) = capped_manager(true);
    let emitter = MockEventEmitter::new();
    open_without_command(&manager, &emitter).await;
    assert!(within(Duration::from_secs(4), || helds(&emitter) == [true]).await);

    setup.gate_opens();
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert_eq!(written(&writes), SETUP);
}

/// #5564: a late cue past the notice releases the setup and the command
/// behind it, once.
#[tokio::test]
async fn a_late_cue_releases_a_held_capped_setup_and_its_command() {
    let (manager, writes, setup) = capped_manager(true);
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(4), || helds(&emitter) == [true]).await);
    assert!(held_events(&emitter)[0].setup);
    assert!(written(&writes).is_empty());

    setup.gate_opens();
    assert!(
        within(Duration::from_secs(2), || written(&writes)
            == b"SETUP\necho hi\r")
        .await
    );
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(!manager.send_held_initial_command(&sid), "nothing left held");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(written(&writes), b"SETUP\necho hi\r", "exactly once");
}

// ── The product-test profile, end to end (#5515) ──────────────────────

/// A local zsh from 5.1 (it announces its line editor), if installed.
#[cfg(unix)]
fn zsh_with_line_editor_mark() -> bool {
    let Ok(out) = std::process::Command::new("zsh").arg("--version").output() else {
        eprintln!("SKIPPED: zsh is not installed");
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text.split_whitespace().nth(1).unwrap_or("");
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let ok = (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (5, 1);
    if !ok {
        eprintln!("SKIPPED: {text:?} announces no bracketed paste");
    }
    ok
}

/// The maintainer's product test: a zsh with the integration and an initial
/// command, whose `.zshrc` asks a one-key `read -q` question first. Nothing
/// may answer the question; after the user's `y` the setup goes in at the
/// first prompt, the initial command follows its mark, and commands get
/// their marks. The command used to be typed after 1 s into the question.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_zsh_startup_question_then_marks_and_the_initial_command() {
    use super::initial_command::{env_vars, local_shell, recording_manager};
    const RAN: &str = "\x1b]133;C\x07INITIAL-COMMAND-RAN";
    if !zsh_with_line_editor_mark() {
        return;
    }
    let home = tempfile::tempdir().expect("temp home");
    let path = |name: &str| home.path().join(name).to_string_lossy().into_owned();
    // No /etc/zshrc & co.: the system's own `compinit` must not ask first.
    std::fs::write(home.path().join(".zshenv"), "setopt no_global_rcs\n").expect("zshenv");
    // The kit's `.zshrc` (coordinator-handover/product-test/start.sh).
    std::fs::write(
        home.path().join(".zshrc"),
        "HISTFILE=\"$ZDOTDIR/.zsh_history\"\n\
         print -P \"%F{yellow}[product-test] .zshrc asks a one-key question:%f\"\n\
         if read -q \"?Continue startup? Press y or n: \"; then echo; echo \"ANSWER-Y\"; \
         else echo; echo \"ANSWER-N\"; fi\n\
         PROMPT='%F{green}question-shell%f %# '\n",
    )
    .expect("zshrc");
    for dir in [".config", ".local/share", ".local/state", ".cache"] {
        std::fs::create_dir_all(home.path().join(dir)).expect("scratch dir");
    }
    let (manager, writes) = recording_manager("local", local_shell);
    let settings = serde_json::json!({
        "shell": "zsh",
        "shellIntegration": true,
        "initialCommand": "echo INITIAL-COMMAND-RAN",
        "envVars": env_vars(&[
            ("HOME", &path("")),
            ("ZDOTDIR", &path("")),
            ("HISTFILE", &path(".zsh_history")),
            ("XDG_CONFIG_HOME", &path(".config")),
            ("XDG_DATA_HOME", &path(".local/share")),
            ("XDG_STATE_HOME", &path(".local/state")),
            ("XDG_CACHE_HOME", &path(".cache")),
            ("SHELL_SESSION_HISTORY", "0"),
            ("TERM_PROGRAM", ""),
        ]),
    });
    let emitter = MockEventEmitter::new();
    let sid = manager
        .create_connection("local", settings, None, None, false, false, emitter.clone())
        .await
        .expect("connect succeeds");
    let text = || String::from_utf8_lossy(&emitted(&emitter)).into_owned();

    assert!(
        within(Duration::from_secs(30), || text()
            .contains("Continue startup?"))
        .await,
        "no startup question: {:?}",
        text()
    );
    tokio::time::sleep(INITIAL_COMMAND_READY_TIMEOUT + Duration::from_millis(1500)).await;
    assert!(
        written(&writes).is_empty(),
        "something was typed into the startup question: {:?}",
        text()
    );

    manager.send_input(&sid, b"y").await.expect("answer");
    let ran = within(Duration::from_secs(30), || {
        // Its output follows its own command-start mark.
        text().contains(RAN)
    })
    .await;
    assert!(
        ran,
        "the initial command did not run with marks: {:?}",
        text()
    );
    manager.send_input(&sid, b"false\r").await.expect("false");
    let failed = within(Duration::from_secs(30), || text().contains("\x1b]133;D;1")).await;
    let out = text();
    let _ = manager.close_session(&sid).await;
    assert!(failed, "the failed command got no error mark: {out:?}");
    assert!(
        out.contains("ANSWER-Y") && !out.contains("ANSWER-N"),
        "{out:?}"
    );
    assert!(!out.contains("command not found"), "{out:?}");
    assert!(
        out.find("ANSWER-Y") < out.find(RAN),
        "the initial command ran before the answer: {out:?}"
    );
    assert_eq!(
        out.matches(RAN).count(),
        1,
        "the initial command ran once: {out:?}"
    );
}

// ── macOS /bin/bash 3.2 on the canonical-mode cue, end to end (#5525) ──

/// A local bash older than 5.1 (no bracketed-paste mark: the setup waits
/// for the canonical-mode cue), if installed: `TERMIHUB_TEST_OLD_BASH`, else
/// macOS's `/bin/bash` 3.2.
#[cfg(unix)]
fn bash_on_the_canonical_cue() -> Option<String> {
    let bash = std::env::var("TERMIHUB_TEST_OLD_BASH").unwrap_or_else(|_| "/bin/bash".into());
    let Ok(out) = std::process::Command::new(&bash).arg("--version").output() else {
        eprintln!("SKIPPED: {bash} is not installed");
        return None;
    };
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let version = text
        .split_whitespace()
        .skip_while(|w| *w != "version")
        .nth(1)
        .unwrap_or("");
    let mut parts = version.split('.').map(|p| {
        p.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    let old = (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) < (5, 1);
    if !old {
        eprintln!("SKIPPED: {bash} ({version}) announces its line editor");
    }
    old.then_some(bash)
}

/// Start `bash` with the integration and an initial command in a scratch
/// `HOME` whose `.bash_profile` and `.bashrc` are `profile` (a shell given
/// as a path starts as an interactive non-login shell).
#[cfg(unix)]
async fn start_old_bash(
    bash: &str,
    profile: &str,
) -> (
    SessionManager,
    Writes,
    MockEventEmitter,
    String,
    tempfile::TempDir,
) {
    use super::initial_command::{env_vars, local_shell, recording_manager};
    let home = tempfile::tempdir().expect("temp home");
    std::fs::write(home.path().join(".bash_profile"), profile).expect("profile");
    std::fs::write(home.path().join(".bashrc"), profile).expect("bashrc");
    for dir in [".config", ".local/share", ".local/state", ".cache"] {
        std::fs::create_dir_all(home.path().join(dir)).expect("scratch dir");
    }
    let path = |name: &str| home.path().join(name).to_string_lossy().into_owned();
    let (manager, writes) = recording_manager("local", local_shell);
    let settings = serde_json::json!({
        "shell": bash,
        "shellIntegration": true,
        "initialCommand": "echo INITIAL-COMMAND-RAN",
        "envVars": env_vars(&[
            ("HOME", &path("")),
            ("HISTFILE", &path(".bash_history")),
            ("INPUTRC", &path(".inputrc")),
            ("XDG_CONFIG_HOME", &path(".config")),
            ("XDG_DATA_HOME", &path(".local/share")),
            ("XDG_STATE_HOME", &path(".local/state")),
            ("XDG_CACHE_HOME", &path(".cache")),
            ("SHELL_SESSION_HISTORY", "0"),
            ("BASH_SILENCE_DEPRECATION_WARNING", "1"),
            ("TERM_PROGRAM", ""),
        ]),
    });
    let emitter = MockEventEmitter::new();
    let sid = manager
        .create_connection("local", settings, None, None, false, false, emitter.clone())
        .await
        .expect("connect succeeds");
    (manager, writes, emitter, sid, home)
}

/// The issue's case: `/bin/bash` 3.2 with a 2 s `sleep` in `.bash_profile`,
/// the integration on and an initial command. The command used to be typed
/// after 1 s into the still-cooked tty, ahead of the setup; it now waits for
/// the setup's prompt mark and runs once, after the rc output, with marks.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_bash_slow_rc_runs_the_initial_command_once_after_the_setup() {
    const RAN: &str = "\x1b]133;C\x07INITIAL-COMMAND-RAN";
    let Some(bash) = bash_on_the_canonical_cue() else {
        return;
    };
    let (manager, writes, emitter, sid, _home) = start_old_bash(
        &bash,
        "echo RC-START\nsleep 2\necho RC-DONE\nPS1='old-bash$ '\n",
    )
    .await;
    let text = || String::from_utf8_lossy(&emitted(&emitter)).into_owned();

    tokio::time::sleep(INITIAL_COMMAND_READY_TIMEOUT + Duration::from_millis(300)).await;
    assert!(
        written(&writes).is_empty(),
        "the initial command was typed during the rc: {:?}",
        text()
    );
    let ran = within(Duration::from_secs(30), || text().contains(RAN)).await;
    assert!(
        ran,
        "the initial command did not run with marks: {:?}",
        text()
    );
    manager.send_input(&sid, b"false\r").await.expect("false");
    let failed = within(Duration::from_secs(30), || text().contains("\x1b]133;D;1")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let out = text();
    let _ = manager.close_session(&sid).await;
    assert!(failed, "the failed command got no error mark: {out:?}");
    let rc_done = out.find("RC-DONE").expect("the rc ran");
    assert!(rc_done < out.find(RAN).expect("ran"), "{out:?}");
    assert_eq!(out.matches(RAN).count(), 1, "ran once: {out:?}");
    assert!(!out.contains("command not found"), "{out:?}");
    assert_eq!(
        written(&writes),
        b"echo INITIAL-COMMAND-RAN\rfalse\r",
        "termiHub typed the command once, then only the user's input"
    );
    assert!(
        held_events(&emitter).is_empty(),
        "no notice: the mark came in time"
    );
}

/// The setup's mark never comes in time (an rc file slower than the setup's
/// cap plus the margin): the tab gets the held notice with Send now, and
/// nothing is typed blind: neither the initial command (#5525) nor the setup,
/// whose echo used to follow `RC-START` (#5564).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_bash_without_the_setups_mark_holds_the_initial_command() {
    use crate::session::manager::held_initial_command::SETUP_CAP_MARGIN;
    use termihub_core::session::prompt_ready::PROBE_CAP;
    let Some(bash) = bash_on_the_canonical_cue() else {
        return;
    };
    let (manager, writes, emitter, sid, _home) =
        start_old_bash(&bash, "echo RC-START\nsleep 60\necho RC-DONE\n").await;
    let text = || String::from_utf8_lossy(&emitted(&emitter)).into_owned();

    // The setup's cap is the core's `READY_CAP`, the same 10 s as PROBE_CAP.
    let held = within(
        PROBE_CAP + SETUP_CAP_MARGIN + Duration::from_secs(5),
        || !held_events(&emitter).is_empty(),
    )
    .await;
    let events = held_events(&emitter);
    let out = text();
    let _ = manager.close_session(&sid).await;
    assert!(held, "no held notice: {out:?}");
    assert!(
        events[0].held && events[0].initial_command && events[0].setup,
        "{events:?}"
    );
    assert!(
        !out.contains("termihub-setup-done"),
        "the setup was typed blind: {out:?}"
    );
    assert!(
        written(&writes).is_empty(),
        "the initial command was typed blind: {out:?}"
    );
    assert!(
        out.contains("RC-START") && !out.contains("RC-DONE"),
        "{out:?}"
    );
}
