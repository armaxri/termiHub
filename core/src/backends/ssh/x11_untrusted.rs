//! Untrusted X11 forwarding, the way `ssh -X` does it (#5585).
//!
//! Trusted forwarding (`ssh -Y`, termiHub's default) hands remote X clients
//! the real local `MIT-MAGIC-COOKIE-1`, so they get full access to the local
//! display: they can read other windows and watch keystrokes. With untrusted
//! forwarding (OpenSSH's `ForwardX11Trusted no`) termiHub instead asks the
//! local X server for a short-lived **untrusted** cookie through the X
//! SECURITY extension and forwards with that one:
//!
//! ```text
//! xauth -f <temp file> generate <display> MIT-MAGIC-COOKIE-1 untrusted timeout N
//! ```
//!
//! The temp authority file lives in a private (`0700`) directory and is
//! deleted as soon as the cookie is read back, long before the session ends;
//! the user's `~/.Xauthority` is never read or written (`xauth` authenticates
//! to the server with a second private file that holds only the real cookie).
//! Like OpenSSH's `ForwardX11Timeout`, new X11 connections are refused once
//! [`UNTRUSTED_X11_TIMEOUT`] has passed; the server-side cookie lives a little
//! longer ([`XAUTH_TIMEOUT_SLACK`]) so the client-side refusal always comes
//! first.
//!
//! **Fallback rule: fail closed.** When the local server has no SECURITY
//! extension (XQuartz, Xvfb on macOS, VcXsrv) or `xauth` is missing, the
//! session connects without X11 forwarding and says why, in the log and in
//! the connect status. A user who asked for untrusted forwarding never gets
//! trusted access behind their back; turning the option off restores trusted
//! forwarding. This is also what OpenSSH effectively does: its X11 channels
//! fail when the untrusted cookie cannot be generated.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use tracing::{info, warn};

use super::x11::{LocalXConnection, LocalXServerInfo, ResolvedXServer};
use super::x11_req::MIT_MAGIC_COOKIE_1;

/// How long new X11 connections are accepted with an untrusted cookie, like
/// OpenSSH's default `ForwardX11Timeout` (20 minutes).
pub const UNTRUSTED_X11_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// How much longer the server-side cookie lives than the client-side window,
/// as in OpenSSH (`X11_TIMEOUT_SLACK`).
pub const XAUTH_TIMEOUT_SLACK: Duration = Duration::from_secs(60);

/// How long `xauth generate` may take before it is given up on.
const XAUTH_RUN_TIMEOUT: Duration = Duration::from_secs(10);

/// `FamilyWild` in an X authority file: the entry matches any address.
const FAMILY_WILD: u16 = 0xffff;

static XAUTH_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Use `program` instead of `xauth` from `PATH` for untrusted cookies.
///
/// The first call wins; later calls are ignored. For an `xauth` outside
/// `PATH` and for tests that stand in a fake.
pub fn set_xauth_program(program: PathBuf) {
    let _ = XAUTH_OVERRIDE.set(program);
}

/// The `xauth` programs to try, in order.
fn xauth_candidates() -> Vec<OsString> {
    if let Some(program) = XAUTH_OVERRIDE.get() {
        return vec![program.clone().into_os_string()];
    }
    let mut candidates = vec![OsString::from("xauth")];
    // XQuartz installs it here, which a GUI app's PATH often lacks.
    if cfg!(target_os = "macos") {
        candidates.push(OsString::from("/opt/X11/bin/xauth"));
    }
    candidates
}

/// Why untrusted forwarding is not possible here. Carries no cookie bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UntrustedUnavailable {
    /// No `xauth` program could be started.
    NoXauth,
    /// The local X server has no SECURITY extension (XQuartz, VcXsrv).
    NoSecurityExtension,
    /// The local display cannot be named for `xauth` (an odd TCP port).
    DisplayNotAddressable,
    /// `xauth` failed otherwise; its trimmed error output (never a cookie).
    Failed(String),
}

impl UntrustedUnavailable {
    /// A user-facing line for the connect status and the log.
    pub fn describe(&self) -> String {
        let why = match self {
            Self::NoXauth => "xauth is not installed on this computer".to_string(),
            Self::NoSecurityExtension => {
                "the local X server does not support untrusted clients (no SECURITY \
                 extension, as with XQuartz and VcXsrv)"
                    .to_string()
            }
            Self::DisplayNotAddressable => "the local X display cannot be addressed".to_string(),
            Self::Failed(detail) => format!("xauth failed: {detail}"),
        };
        format!(
            "X11 forwarding is off for this session: untrusted X11 forwarding is on, but {why}. \
             Turn off \"Untrusted X11 forwarding\" in the connection settings to forward with \
             full (trusted) access instead."
        )
    }
}

/// An untrusted cookie for the local display. `Debug` never prints it.
#[derive(Clone)]
pub struct UntrustedCookie {
    /// The cookie, as hex.
    hex: String,
}

impl std::fmt::Debug for UntrustedCookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UntrustedCookie")
            .field("hex", &"<redacted>")
            .finish()
    }
}

/// Which cookie a forwarded display uses (#5585).
#[derive(Debug)]
pub enum X11CookieDecision {
    /// Trusted forwarding: the real local cookie, as before.
    Trusted,
    /// Untrusted forwarding with this generated cookie; new X11 connections
    /// are refused after the deadline.
    Untrusted {
        cookie: UntrustedCookie,
        deadline: tokio::time::Instant,
    },
    /// Untrusted forwarding was asked for but is not possible: no X11.
    Refuse(UntrustedUnavailable),
}

impl X11CookieDecision {
    /// Apply the decision to `server`: the server to forward to (with the
    /// cookie to use as the real one) and the deadline for new X11
    /// connections, or `None` when X11 forwarding is off for the session.
    pub fn apply(
        self,
        server: ResolvedXServer,
    ) -> Option<(ResolvedXServer, Option<tokio::time::Instant>)> {
        match self {
            Self::Trusted => Some((server, None)),
            Self::Untrusted { cookie, deadline } => Some((
                ResolvedXServer {
                    info: server.info,
                    cookie: Some(cookie.hex),
                },
                Some(deadline),
            )),
            Self::Refuse(_) => None,
        }
    }
}

/// Choose the cookie for `server` (#5585).
///
/// Trusted forwarding keeps the real cookie and never runs `xauth`.
/// Untrusted forwarding generates an untrusted cookie that expires
/// `timeout` + [`XAUTH_TIMEOUT_SLACK`] after its last use; when that is not
/// possible the decision is [`X11CookieDecision::Refuse`] (fail closed).
pub async fn choose_cookie(
    untrusted: bool,
    server: &ResolvedXServer,
    timeout: Duration,
) -> X11CookieDecision {
    choose_cookie_with(untrusted, server, timeout, &xauth_candidates()).await
}

/// [`choose_cookie`] with the `xauth` programs to try.
pub(crate) async fn choose_cookie_with(
    untrusted: bool,
    server: &ResolvedXServer,
    timeout: Duration,
    xauth: &[OsString],
) -> X11CookieDecision {
    if !untrusted {
        return X11CookieDecision::Trusted;
    }
    let display = match display_name(&server.info) {
        Some(display) => display,
        None => {
            return X11CookieDecision::Refuse(UntrustedUnavailable::DisplayNotAddressable);
        }
    };
    let real = server.cookie.clone();
    let xauth = xauth.to_vec();
    let started = tokio::time::Instant::now();
    let generated = tokio::task::spawn_blocking(move || {
        generate_untrusted_cookie(&xauth, &display, real.as_deref(), timeout)
    })
    .await
    .unwrap_or_else(|e| {
        Err(UntrustedUnavailable::Failed(format!(
            "xauth task failed: {e}"
        )))
    });
    match generated {
        Ok(cookie) => {
            info!(
                timeout_secs = timeout.as_secs(),
                "X11 forwarding: generated an untrusted cookie for the local display"
            );
            X11CookieDecision::Untrusted {
                cookie,
                deadline: started + timeout,
            }
        }
        Err(why) => {
            warn!("{}", why.describe());
            X11CookieDecision::Refuse(why)
        }
    }
}

/// The display name `xauth` connects to for `info`, or `None` when it has
/// none (a TCP port below 6000).
pub fn display_name(info: &LocalXServerInfo) -> Option<String> {
    match &info.connection {
        #[cfg(unix)]
        LocalXConnection::UnixSocket(path) => {
            let standard = format!("/.X11-unix/X{}", info.display_number);
            if path.ends_with(&standard) {
                Some(format!(":{}", info.display_number))
            } else {
                // XQuartz's launchd socket path is itself a display name.
                Some(path.clone())
            }
        }
        LocalXConnection::Tcp(host, port) => {
            let number = port.checked_sub(6000)?;
            Some(format!("{host}:{number}"))
        }
    }
}

/// One `MIT-MAGIC-COOKIE-1` entry in X authority file format, matching any
/// address and display (`FamilyWild`).
pub fn wild_authority_entry(cookie: &[u8]) -> Vec<u8> {
    // The family has no length prefix; every other field has a u16 one.
    let mut entry = FAMILY_WILD.to_be_bytes().to_vec();
    let fields: [&[u8]; 4] = [&[], &[], MIT_MAGIC_COOKIE_1.as_bytes(), cookie];
    for bytes in fields {
        let len = u16::try_from(bytes.len()).unwrap_or(u16::MAX);
        entry.extend_from_slice(&len.to_be_bytes());
        entry.extend_from_slice(&bytes[..usize::from(len)]);
    }
    entry
}

/// The first `MIT-MAGIC-COOKIE-1` cookie in an X authority file, as hex.
pub fn first_mit_cookie(authority: &[u8]) -> Option<String> {
    let mut at = 0usize;
    let take = |at: &mut usize| -> Option<Vec<u8>> {
        let len_bytes = authority.get(*at..*at + 2)?;
        let len = usize::from(u16::from_be_bytes([len_bytes[0], len_bytes[1]]));
        let bytes = authority.get(*at + 2..*at + 2 + len)?.to_vec();
        *at += 2 + len;
        Some(bytes)
    };
    while at + 2 <= authority.len() {
        at += 2; // family
        let _address = take(&mut at)?;
        let _number = take(&mut at)?;
        let name = take(&mut at)?;
        let data = take(&mut at)?;
        if name == MIT_MAGIC_COOKIE_1.as_bytes() && !data.is_empty() {
            return Some(hex::encode(data));
        }
    }
    None
}

/// Create a private (`0700`) directory for the temp authority files.
fn private_dir() -> std::io::Result<tempfile::TempDir> {
    let dir = tempfile::Builder::new().prefix("termihub-x11-").tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Write `bytes` to a new file only the user can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Run `xauth generate` for `display` and read the untrusted cookie back.
///
/// `xauth` authenticates to the server with a private authority file that
/// holds only `real_hex` (none for a cookieless server), and writes the new
/// cookie into another private file. Both are deleted before this returns.
fn generate_untrusted_cookie(
    xauth: &[OsString],
    display: &str,
    real_hex: Option<&str>,
    timeout: Duration,
) -> Result<UntrustedCookie, UntrustedUnavailable> {
    let io_failed = |e: std::io::Error| UntrustedUnavailable::Failed(e.to_string());
    let dir = private_dir().map_err(io_failed)?;
    let auth_in = dir.path().join("display.auth");
    let auth_out = dir.path().join("untrusted.auth");
    let real = real_hex
        .and_then(|h| hex::decode(h.trim()).ok())
        .filter(|bytes| !bytes.is_empty());
    let entry = real
        .as_deref()
        .map(wild_authority_entry)
        .unwrap_or_default();
    write_private(&auth_in, &entry).map_err(io_failed)?;

    let server_timeout = (timeout + XAUTH_TIMEOUT_SLACK).as_secs().to_string();
    for program in xauth {
        let mut command = crate::util::no_window::no_window_command(program);
        command
            .arg("-f")
            .arg(&auth_out)
            .args(["generate", display, MIT_MAGIC_COOKIE_1, "untrusted"])
            .args(["timeout", &server_timeout])
            .env("XAUTHORITY", &auth_in)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        let child = match command.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_failed(e)),
        };
        let (success, stderr) = wait_with_timeout(child, XAUTH_RUN_TIMEOUT)?;
        if !success {
            return Err(classify_xauth_failure(&stderr));
        }
        let written = std::fs::read(&auth_out).unwrap_or_default();
        return first_mit_cookie(&written)
            .map(|hex| UntrustedCookie { hex })
            .ok_or_else(|| UntrustedUnavailable::Failed("xauth wrote no cookie".to_string()));
    }
    Err(UntrustedUnavailable::NoXauth)
}

/// Wait for `child`, killing it after `limit`; whether it succeeded and its
/// error output.
fn wait_with_timeout(
    mut child: std::process::Child,
    limit: Duration,
) -> Result<(bool, String), UntrustedUnavailable> {
    use std::io::Read;
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(UntrustedUnavailable::Failed(
                    "xauth did not finish in time".to_string(),
                ));
            }
            Err(e) => return Err(UntrustedUnavailable::Failed(e.to_string())),
        }
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    Ok((status.success(), stderr))
}

/// Tell a missing SECURITY extension from other `xauth` failures.
pub fn classify_xauth_failure(stderr: &str) -> UntrustedUnavailable {
    if stderr.contains("Security extension") {
        return UntrustedUnavailable::NoSecurityExtension;
    }
    let detail: String = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no error output")
        .chars()
        .take(200)
        .collect();
    UntrustedUnavailable::Failed(detail)
}

/// Whether a new X11 connection may still be accepted at `now`.
pub fn accepts_new_connection(
    deadline: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
) -> bool {
    deadline.is_none_or(|deadline| now < deadline)
}

#[cfg(test)]
#[path = "x11_untrusted_tests.rs"]
mod tests;
