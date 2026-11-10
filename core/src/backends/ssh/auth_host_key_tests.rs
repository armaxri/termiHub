//! The interactive host-key trust prompt during a connect (#5185), driven over
//! the in-process test server so the real handshake runs.
//!
//! Each test hands the handshake its own [`HostKeyVerifier`] (the process-wide
//! one is set-once, and the other core tests rely on none being registered).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use super::*;
use crate::backends::ssh::host_key::{HostKeyDecision, HostKeyInfo};
use crate::backends::ssh::ki_test_server::{serve, PasswordPolicy, Script};

fn config() -> SshConfig {
    SshConfig {
        host: "hostkey-5185.invalid".to_string(),
        port: 2222,
        username: "alice".to_string(),
        auth_method: "password".to_string(),
        password: Some("hunter2".to_string()),
        ..SshConfig::default()
    }
}

fn script() -> Script {
    Script {
        rounds: Vec::new(),
        password: PasswordPolicy::Sole("hunter2"),
    }
}

/// A verifier standing in for the desktop's trust prompt: it "asks" for
/// `think` and then answers `decision`. `dropped` records a prompt that was
/// dismissed (its future dropped) before it answered.
struct PromptingVerifier {
    think: Option<Duration>,
    decision: HostKeyDecision,
    asked: AtomicBool,
    dropped: Arc<AtomicBool>,
}

impl PromptingVerifier {
    fn new(think: Option<Duration>, decision: HostKeyDecision) -> Arc<Self> {
        Arc::new(Self {
            think,
            decision,
            asked: AtomicBool::new(false),
            dropped: Arc::new(AtomicBool::new(false)),
        })
    }
}

/// Sets its flag when dropped unless disarmed — i.e. when the prompt future
/// was dropped before it answered.
struct DropFlag(Option<Arc<AtomicBool>>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        if let Some(flag) = self.0.take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[async_trait]
impl HostKeyVerifier for PromptingVerifier {
    async fn verify(&self, info: &HostKeyInfo) -> bool {
        self.decide(info).await.is_accepted()
    }

    async fn decide(&self, _info: &HostKeyInfo) -> HostKeyDecision {
        self.asked.store(true, Ordering::SeqCst);
        let mut flag = DropFlag(Some(self.dropped.clone()));
        match self.think {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending::<()>().await,
        }
        flag.0 = None;
        self.decision
    }
}

/// Rejecting the key in the trust prompt is the typed `HostKeyUntrusted`
/// saying the user rejected it — not "SSH handshake failed" — and no
/// credential is sent.
#[tokio::test]
async fn interactive_reject_is_host_key_untrusted() {
    let (stream, observed) = serve(script());
    let verifier = PromptingVerifier::new(Some(Duration::ZERO), HostKeyDecision::RejectedByUser);
    let err = match handshake_and_authenticate_with(&config(), stream, Some(verifier.clone())).await
    {
        Ok(_) => panic!("a rejected host key must not connect"),
        Err(e) => e,
    };
    assert!(
        verifier.asked.load(Ordering::SeqCst),
        "the prompt was shown"
    );
    assert_eq!(
        err.connect_failure_kind(),
        Some(ConnectFailureKind::HostKeyUntrusted),
        "got {err:?}"
    );
    let msg = err.to_string();
    assert!(msg.contains("You rejected the host key"), "got {msg}");
    assert!(msg.contains("hostkey-5185.invalid:2222"), "got {msg}");
    assert!(!msg.contains("handshake failed"), "got {msg}");
    assert_eq!(observed.lock().unwrap().authenticated, 0);
}

/// A policy refusal (nobody asked) keeps the plain handshake error: only a
/// person saying no is reported as "You rejected the host key".
#[tokio::test]
async fn policy_refusal_is_not_reported_as_a_user_reject() {
    let (stream, _observed) = serve(script());
    let verifier = PromptingVerifier::new(Some(Duration::ZERO), HostKeyDecision::Refused);
    let err = match handshake_and_authenticate_with(&config(), stream, Some(verifier)).await {
        Ok(_) => panic!("a refused host key must not connect"),
        Err(e) => e,
    };
    assert_eq!(err.connect_failure_kind(), None, "got {err:?}");
    assert!(err.to_string().contains("SSH handshake failed"));
}

/// The time the trust prompt is open does not count against the connect
/// timeout: a 1.5 s hesitation fits a 1 s connect budget (#5185).
#[tokio::test]
async fn trust_prompt_time_is_excluded_from_the_connect_timeout() {
    let (stream, observed) = serve(script());
    let verifier =
        PromptingVerifier::new(Some(Duration::from_millis(1500)), HostKeyDecision::Accepted);
    let res = timeout_excluding_prompts(
        Duration::from_secs(1),
        handshake_and_authenticate_with(&config(), stream, Some(verifier.clone())),
    )
    .await;
    match res {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => panic!("the connect failed: {e}"),
        Err(_) => panic!("the trust prompt's time was charged to the connect timeout"),
    }
    assert!(!verifier.dropped.load(Ordering::SeqCst));
    assert_eq!(observed.lock().unwrap().authenticated, 1);
}

/// The same exclusion applies to a jump-host hop's budget, which nests a hop
/// deadline inside the connect's own (#5185).
#[tokio::test]
async fn trust_prompt_time_is_excluded_from_a_nested_hop_timeout() {
    let (stream, _observed) = serve(script());
    let verifier =
        PromptingVerifier::new(Some(Duration::from_millis(1500)), HostKeyDecision::Accepted);
    let res = timeout_excluding_prompts(Duration::from_secs(1), async {
        timeout_excluding_prompts(
            Duration::from_secs(1),
            handshake_and_authenticate_with(&config(), stream, Some(verifier)),
        )
        .await
    })
    .await;
    assert!(
        matches!(res, Ok(Ok(Ok(_)))),
        "a hop must not time out under the prompt"
    );
}

/// A connect that gives up while the prompt is open (abort, timeout) drops —
/// dismisses — the prompt instead of leaving it waiting for an answer to a
/// connect that no longer exists (#5185).
#[tokio::test]
async fn abandoning_the_connect_dismisses_the_prompt() {
    let (stream, _observed) = serve(script());
    let verifier = PromptingVerifier::new(None, HostKeyDecision::Accepted);
    let res = tokio::time::timeout(
        Duration::from_millis(300),
        handshake_and_authenticate_with(&config(), stream, Some(verifier.clone())),
    )
    .await;
    assert!(
        res.is_err(),
        "the prompt never answers, so the connect waits"
    );
    assert!(
        verifier.asked.load(Ordering::SeqCst),
        "the prompt was shown"
    );
    // The prompt runs on russh's session task: give it a moment to observe the
    // abandon signal.
    for _ in 0..100 {
        if verifier.dropped.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the open prompt was not dismissed when the connect gave up");
}

/// A cancelled connect (the Abort of a connecting tab or pre-connect, #5180)
/// dismisses the open prompt the same way.
#[tokio::test]
async fn cancelling_the_connect_dismisses_the_prompt() {
    let (stream, _observed) = serve(script());
    let verifier = PromptingVerifier::new(None, HostKeyDecision::Accepted);
    let token = CancellationToken::new();
    let cfg = config();
    let connect = handshake_and_authenticate_with(&cfg, stream, Some(verifier.clone()));
    let cancel = token.clone();
    let asked = verifier.clone();
    tokio::spawn(async move {
        while !asked.asked.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cancel.cancel();
    });
    let res = tokio::select! {
        biased;
        _ = token.cancelled() => None,
        r = connect => Some(r),
    };
    assert!(res.is_none(), "the cancel ended the connect");
    for _ in 0..100 {
        if verifier.dropped.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the open prompt was not dismissed when the connect was cancelled");
}

/// A prompt nobody answers fails the connect after the prompt's own timeout,
/// as a typed `Timeout` naming the unconfirmed host key.
#[tokio::test(start_paused = true)]
async fn an_unanswered_prompt_times_out_on_its_own_bound() {
    let (stream, _observed) = serve(script());
    let verifier = PromptingVerifier::new(None, HostKeyDecision::Accepted);
    let err = match handshake_and_authenticate_with(&config(), stream, Some(verifier)).await {
        Ok(_) => panic!("an unanswered prompt must not connect"),
        Err(e) => e,
    };
    assert_eq!(
        err.connect_failure_kind(),
        Some(ConnectFailureKind::Timeout),
        "got {err:?}"
    );
    assert!(err.to_string().contains("was not confirmed within 300s"));
}

/// Records the prompt owner it sees while deciding (#5243).
struct OwnerRecordingVerifier {
    seen: std::sync::Mutex<Option<Option<String>>>,
}

#[async_trait]
impl HostKeyVerifier for OwnerRecordingVerifier {
    async fn verify(&self, info: &HostKeyInfo) -> bool {
        self.decide(info).await.is_accepted()
    }

    async fn decide(&self, _info: &HostKeyInfo) -> HostKeyDecision {
        *self.seen.lock().unwrap() =
            Some(crate::backends::ssh::prompt_owner::current_prompt_owner());
        HostKeyDecision::Accepted
    }
}

/// The trust prompt runs on russh's session task, yet it sees the owner the
/// connecting task scoped (#5243) — so the desktop can name the connect on the
/// prompt event and the frontend pauses that tab's own deadline.
#[tokio::test]
async fn trust_prompt_sees_the_connecting_tasks_prompt_owner() {
    let (stream, _observed) = serve(script());
    let verifier = Arc::new(OwnerRecordingVerifier {
        seen: std::sync::Mutex::new(None),
    });
    crate::backends::ssh::prompt_owner::with_prompt_owner(
        Some("tab-5243:0"),
        handshake_and_authenticate_with(&config(), stream, Some(verifier.clone())),
    )
    .await
    .expect("connect");
    assert_eq!(
        *verifier.seen.lock().unwrap(),
        Some(Some("tab-5243:0".to_string())),
        "the verifier was asked with the connect's owner"
    );
}

/// Without an owner scope the trust prompt carries none.
#[tokio::test]
async fn trust_prompt_without_an_owner_scope_has_no_owner() {
    let (stream, _observed) = serve(script());
    let verifier = Arc::new(OwnerRecordingVerifier {
        seen: std::sync::Mutex::new(None),
    });
    handshake_and_authenticate_with(&config(), stream, Some(verifier.clone()))
        .await
        .expect("connect");
    assert_eq!(*verifier.seen.lock().unwrap(), Some(None));
}
