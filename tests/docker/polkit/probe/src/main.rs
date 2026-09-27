//! Headless probe for termiHub's polkit D-Bus transport (#3553).
//!
//! Compiles the shipped `authority.rs` + `dbus.rs` by path and calls the real
//! `DbusAuthority` against the container's system bus and `polkitd`.
//! `scenarios.sh` sets up each case (policy installed or not, a rules file, a
//! scripted agent) and asserts on the lines this prints:
//!
//! - `polkit-probe registered <action>` → `registered=<bool>`
//! - `polkit-probe check <action>` →
//!   `authorized=<bool> challenge=<bool> dismissed=<bool>`; with
//!   `POLKIT_PROBE_WAIT_FOR_AGENT` set it first prints `pid=<pid>` and waits for
//!   a line on stdin, so the driver can register an agent for this process;
//!   `POLKIT_PROBE_TIMEOUT_SECS` shortens the prompt bound.
//! - `polkit-probe agent <dismiss|hang> <pid>` — a scripted polkit
//!   authentication agent for process `<pid>`. It prints `agent=registered`,
//!   then `begin=<action>` when polkit asks it to authenticate. `dismiss`
//!   answers with `org.freedesktop.PolicyKit1.Error.Cancelled` (what a desktop
//!   agent's Cancel button returns); `hang` never answers and prints
//!   `cancel=<cookie>` once polkit relays the caller's
//!   `CancelCheckAuthorization`.
//!
//! A transport error prints `error=<AuthorityError>` and exits 2.

#[cfg(target_os = "linux")]
#[path = "../../../../../src-tauri/src/credential/os_auth/polkit/authority.rs"]
mod authority;
#[cfg(target_os = "linux")]
#[path = "../../../../../src-tauri/src/credential/os_auth/polkit/dbus.rs"]
mod dbus;

// `dbus.rs` imports its contract from `super::`, i.e. this crate root.
#[cfg(target_os = "linux")]
pub use authority::{classify_dbus_error, AuthorityError, AuthorizationResult, PolkitAuthority};

#[cfg(target_os = "linux")]
mod agent {
    //! A scripted `org.freedesktop.PolicyKit1.AuthenticationAgent`.

    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;

    use zbus::blocking::connection::Builder;
    use zbus::zvariant::{OwnedValue, Value};

    const AGENT_PATH: &str = "/com/termihub/PolkitProbeAgent";

    /// How long the agent waits for polkit before giving up.
    const AGENT_DEADLINE: Duration = Duration::from_secs(60);

    #[derive(Debug, zbus::DBusError)]
    #[zbus(prefix = "org.freedesktop.PolicyKit1.Error")]
    enum AgentError {
        #[zbus(error)]
        ZBus(zbus::Error),
        Cancelled(String),
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Dismiss,
        Hang,
    }

    struct ScriptedAgent {
        mode: Mode,
        events: Sender<String>,
    }

    #[zbus::interface(name = "org.freedesktop.PolicyKit1.AuthenticationAgent")]
    impl ScriptedAgent {
        async fn begin_authentication(
            &self,
            action_id: String,
            _message: String,
            _icon_name: String,
            _details: HashMap<String, String>,
            _cookie: String,
            _identities: Vec<(String, HashMap<String, OwnedValue>)>,
        ) -> Result<(), AgentError> {
            let _ = self.events.send(format!("begin={action_id}"));
            match self.mode {
                Mode::Dismiss => Err(AgentError::Cancelled(
                    "the probe agent dismissed the dialog".to_string(),
                )),
                Mode::Hang => std::future::pending().await,
            }
        }

        async fn cancel_authentication(&self, cookie: String) {
            let _ = self.events.send(format!("cancel={cookie}"));
        }
    }

    /// Serve a scripted agent for `pid` until its scripted outcome happened.
    pub fn run(mode: &str, pid: u32) -> Result<(), String> {
        let mode = match mode {
            "dismiss" => Mode::Dismiss,
            "hang" => Mode::Hang,
            other => return Err(format!("unknown agent mode {other:?}")),
        };
        let (events, received) = channel();
        let connection = Builder::system()
            .and_then(|b| b.serve_at(AGENT_PATH, ScriptedAgent { mode, events }))
            .and_then(|b| b.build())
            .map_err(|e| format!("cannot serve the agent: {e}"))?;

        let mut subject_details: HashMap<&str, Value<'_>> = HashMap::new();
        subject_details.insert("pid", Value::from(pid));
        subject_details.insert("start-time", Value::from(0u64));
        connection
            .call_method(
                Some("org.freedesktop.PolicyKit1"),
                "/org/freedesktop/PolicyKit1/Authority",
                Some("org.freedesktop.PolicyKit1.Authority"),
                "RegisterAuthenticationAgent",
                &(("unix-process", subject_details), "C", AGENT_PATH),
            )
            .map_err(|e| format!("RegisterAuthenticationAgent failed: {e}"))?;
        announce("agent=registered");

        let done = match mode {
            Mode::Dismiss => "begin=",
            Mode::Hang => "cancel=",
        };
        loop {
            let event = received
                .recv_timeout(AGENT_DEADLINE)
                .map_err(|_| "polkit never reached the agent".to_string())?;
            announce(&event);
            if event.starts_with(done) {
                // Let the reply to polkit go out before the connection drops.
                std::thread::sleep(Duration::from_millis(500));
                return Ok(());
            }
        }
    }

    fn announce(line: &str) {
        println!("{line}");
        let _ = std::io::stdout().flush();
    }
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    use std::io::Write;
    use std::process::ExitCode;
    use std::time::Duration;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (command, action) = match args.as_slice() {
        ["agent", mode, pid] => {
            let Ok(pid) = pid.parse() else {
                eprintln!("agent pid must be a number");
                return ExitCode::from(64);
            };
            return match agent::run(mode, pid) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    println!("agent-error={error}");
                    ExitCode::from(2)
                }
            };
        }
        [command, action] => (*command, *action),
        _ => {
            eprintln!(
                "usage: polkit-probe <registered|check> <action-id> | agent <dismiss|hang> <pid>"
            );
            return ExitCode::from(64);
        }
    };

    let authority = match std::env::var("POLKIT_PROBE_TIMEOUT_SECS") {
        Ok(secs) => match secs.parse() {
            Ok(secs) => dbus::DbusAuthority::with_prompt_timeout(Duration::from_secs(secs)),
            Err(_) => {
                eprintln!("POLKIT_PROBE_TIMEOUT_SECS must be a whole number of seconds");
                return ExitCode::from(64);
            }
        },
        Err(_) => dbus::DbusAuthority::new(),
    };

    // Tell the driver which PID to register a scripted agent for, then wait
    // for its go-ahead on stdin.
    if std::env::var_os("POLKIT_PROBE_WAIT_FOR_AGENT").is_some() {
        println!("pid={}", std::process::id());
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }

    let outcome = match command {
        "registered" => authority
            .is_action_registered(action)
            .map(|registered| format!("registered={registered}")),
        "check" => authority.check_authorization(action).map(|result| {
            format!(
                "authorized={} challenge={} dismissed={}",
                result.is_authorized,
                result.is_challenge,
                result.details.contains_key("polkit.dismissed")
            )
        }),
        other => {
            eprintln!("unknown command {other:?}");
            return ExitCode::from(64);
        }
    };
    match outcome {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("error={error:?}");
            ExitCode::from(2)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("polkit-probe only runs on Linux (see tests/docker/polkit/run.sh)");
    std::process::exit(1);
}
