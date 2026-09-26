//! In-process russh SSH server offering `keyboard-interactive`, for tests of
//! the keyboard-interactive client flow (#3371).
//!
//! The server runs over a `tokio::io::duplex` pipe — no sockets, no Docker. A
//! [`Script`] describes the info-request rounds to send and the answers each
//! round expects; the client side uses [`AcceptAnyKey`] (host-key checking is
//! out of scope here) or any other handler.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use russh::server::{Auth, Response};
use russh::{MethodKind, MethodSet};
use zeroize::Zeroizing;

use super::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractiveRequest, KeyboardInteractivePrompter,
};

/// One info-request round: what the server asks and what it accepts.
#[derive(Clone)]
pub(crate) struct Round {
    pub name: &'static str,
    pub instructions: &'static str,
    /// `(prompt text, echo)`.
    pub prompts: Vec<(&'static str, bool)>,
    /// Answers the server accepts for this round, in prompt order.
    pub expected: Vec<&'static str>,
}

impl Round {
    pub(crate) fn new(prompts: Vec<(&'static str, bool)>, expected: Vec<&'static str>) -> Self {
        Self {
            name: "",
            instructions: "",
            prompts,
            expected,
        }
    }
}

/// How the server treats the `password` method.
#[derive(Clone, Copy)]
pub(crate) enum PasswordPolicy {
    /// `PasswordAuthentication no`: always refused, keyboard-interactive offered.
    Disabled,
    /// The password is accepted as the **first** factor only: a correct one
    /// yields partial success with keyboard-interactive remaining (sshd
    /// `AuthenticationMethods password,keyboard-interactive`).
    FirstFactor(&'static str),
}

/// The server's behaviour.
#[derive(Clone)]
pub(crate) struct Script {
    pub rounds: Vec<Round>,
    pub password: PasswordPolicy,
}

/// What the server observed, for assertions.
#[derive(Default)]
pub(crate) struct Observed {
    /// Responses received per round (the test server is the only place that
    /// ever sees them in the clear).
    pub responses: Vec<Vec<String>>,
}

struct KiServer {
    script: Arc<Script>,
    observed: Arc<Mutex<Observed>>,
    round: usize,
}

fn partial(round: &Round) -> Auth {
    Auth::Partial {
        name: Cow::Owned(round.name.to_string()),
        instructions: Cow::Owned(round.instructions.to_string()),
        prompts: Cow::Owned(
            round
                .prompts
                .iter()
                .map(|(p, echo)| (Cow::Owned((*p).to_string()), *echo))
                .collect(),
        ),
    }
}

fn only_keyboard_interactive() -> MethodSet {
    MethodSet::from(&[MethodKind::KeyboardInteractive][..])
}

impl russh::server::Handler for KiServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(match self.script.password {
            PasswordPolicy::Disabled => Auth::Reject {
                proceed_with_methods: Some(only_keyboard_interactive()),
                partial_success: false,
            },
            PasswordPolicy::FirstFactor(expected) if expected == password => Auth::Reject {
                proceed_with_methods: Some(only_keyboard_interactive()),
                partial_success: true,
            },
            PasswordPolicy::FirstFactor(_) => Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(
                    &[MethodKind::Password, MethodKind::KeyboardInteractive][..],
                )),
                partial_success: false,
            },
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let Some(response) = response else {
            // Exchange start.
            self.round = 0;
            return Ok(match self.script.rounds.first() {
                Some(r) => partial(r),
                None => Auth::Accept,
            });
        };
        let answers: Vec<String> = response
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .collect();
        self.observed
            .lock()
            .expect("observed")
            .responses
            .push(answers.clone());
        let Some(round) = self.script.rounds.get(self.round) else {
            return Ok(Auth::reject());
        };
        if answers != round.expected {
            return Ok(Auth::Reject {
                proceed_with_methods: Some(only_keyboard_interactive()),
                partial_success: false,
            });
        }
        self.round += 1;
        Ok(match self.script.rounds.get(self.round) {
            Some(next) => partial(next),
            None => Auth::Accept,
        })
    }
}

/// Client handler that trusts any host key (tests only).
pub(crate) struct AcceptAnyKey;

impl russh::client::Handler for AcceptAnyKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Start a scripted server and return a connected (unauthenticated) client
/// handle plus the server's observations.
pub(crate) async fn connect(
    script: Script,
) -> (russh::client::Handle<AcceptAnyKey>, Arc<Mutex<Observed>>) {
    let key = russh::keys::PrivateKey::from(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7u8; 32]),
    );
    let server_config = Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: std::time::Duration::ZERO,
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let observed = Arc::new(Mutex::new(Observed::default()));
    let handler = KiServer {
        script: Arc::new(script),
        observed: observed.clone(),
        round: 0,
    };
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if let Ok(running) = russh::server::run_stream(server_config, server_io, handler).await {
            let _ = running.await;
        }
    });
    let client = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_io,
        AcceptAnyKey,
    )
    .await
    .expect("client handshake");
    (client, observed)
}

/// A prompter that replays scripted answers (`None` = cancel) and records every
/// request it was shown.
#[derive(Default)]
pub(crate) struct ScriptedPrompter {
    answers: Mutex<VecDeque<Option<Vec<&'static str>>>>,
    pub seen: Mutex<Vec<KbdInteractiveRequest>>,
}

impl ScriptedPrompter {
    pub(crate) fn new(answers: Vec<Option<Vec<&'static str>>>) -> Self {
        Self {
            answers: Mutex::new(answers.into()),
            seen: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn seen(&self) -> Vec<KbdInteractiveRequest> {
        self.seen.lock().expect("seen").clone()
    }
}

#[async_trait]
impl KeyboardInteractivePrompter for ScriptedPrompter {
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
        self.seen.lock().expect("seen").push(request.clone());
        match self.answers.lock().expect("answers").pop_front().flatten() {
            Some(a) => KbdInteractiveAnswer::Responses(
                a.into_iter()
                    .map(|s| Zeroizing::new(s.to_string()))
                    .collect(),
            ),
            None => KbdInteractiveAnswer::Cancelled,
        }
    }
}
