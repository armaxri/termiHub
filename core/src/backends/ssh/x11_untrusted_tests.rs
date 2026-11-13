//! Untrusted X11 forwarding (#5585): cookie source selection, the `xauth`
//! call and its failure modes, the authority file format and the timeout.

// Test code: a failed setup step is a bug in the test.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::*;

const REAL_HEX: &str = "00112233445566778899aabbccddeeff";

fn tcp_server(port: u16, cookie: Option<&str>) -> ResolvedXServer {
    ResolvedXServer {
        info: LocalXServerInfo {
            display_number: u32::from(port.saturating_sub(6000)),
            connection: LocalXConnection::Tcp("127.0.0.1".into(), port),
        },
        cookie: cookie.map(str::to_string),
    }
}

// ── Authority file format ───────────────────────────────────────────────

#[test]
fn a_wild_entry_round_trips_through_the_reader() {
    let entry = wild_authority_entry(&hex::decode(REAL_HEX).unwrap());
    assert_eq!(&entry[..2], &[0xff, 0xff], "FamilyWild");
    assert_eq!(first_mit_cookie(&entry).as_deref(), Some(REAL_HEX));
}

#[test]
fn the_reader_skips_other_protocols_and_survives_truncation() {
    let mut file = Vec::new();
    // A non-MIT entry first: family 0x0100 (local), address "h", number "0".
    for field in [&b"h"[..], b"0", b"XDM-AUTHORIZATION-1", b"0123456789abcdef"] {
        if file.is_empty() {
            file.extend_from_slice(&[0x01, 0x00]);
        }
        file.extend_from_slice(&(field.len() as u16).to_be_bytes());
        file.extend_from_slice(field);
    }
    file.extend_from_slice(&wild_authority_entry(&[0xab; 16]));
    assert_eq!(first_mit_cookie(&file), Some(hex::encode([0xab; 16])));
    for cut in 0..file.len() - 1 {
        // Never panics; a cut inside the MIT entry finds nothing.
        let _ = first_mit_cookie(&file[..cut]);
    }
    assert_eq!(first_mit_cookie(&[]), None);
}

// ── Display names and failure classification ────────────────────────────

#[test]
fn display_names_follow_the_local_connection() {
    assert_eq!(
        display_name(&tcp_server(6007, None).info).as_deref(),
        Some("127.0.0.1:7")
    );
    assert_eq!(display_name(&tcp_server(5999, None).info), None);
    #[cfg(unix)]
    {
        let socket = |path: &str, n| LocalXServerInfo {
            display_number: n,
            connection: LocalXConnection::UnixSocket(path.into()),
        };
        assert_eq!(
            display_name(&socket("/tmp/.X11-unix/X3", 3)).as_deref(),
            Some(":3")
        );
        let launchd = "/private/tmp/com.apple.launchd.abc/org.xquartz:0";
        assert_eq!(display_name(&socket(launchd, 0)).as_deref(), Some(launchd));
    }
}

#[test]
fn a_missing_security_extension_is_told_apart() {
    assert_eq!(
        classify_xauth_failure(
            "/opt/X11/bin/xauth: (argv):1:  couldn't query Security extension on display \":0\"\n"
        ),
        UntrustedUnavailable::NoSecurityExtension
    );
    assert_eq!(
        classify_xauth_failure("\n  unable to open display \":9\".\n"),
        UntrustedUnavailable::Failed("unable to open display \":9\".".into())
    );
    assert_eq!(
        classify_xauth_failure(""),
        UntrustedUnavailable::Failed("no error output".into())
    );
}

#[test]
fn every_refusal_maps_to_a_typed_session_reason() {
    use crate::connection::X11ForwardingReason as R;
    assert_eq!(
        UntrustedUnavailable::NoXauth.reason(),
        R::UntrustedXauthMissing
    );
    assert_eq!(
        UntrustedUnavailable::NoSecurityExtension.reason(),
        R::UntrustedNoSecurityExtension
    );
    assert_eq!(
        UntrustedUnavailable::DisplayNotAddressable.reason(),
        R::UntrustedXauthFailed
    );
    // The xauth detail text stays out of the reason the UI gets.
    let failed = UntrustedUnavailable::Failed("secret-ish detail".into()).reason();
    assert_eq!(failed, R::UntrustedXauthFailed);
    let wire = serde_json::to_string(&failed).unwrap();
    assert!(!wire.contains("detail"), "{wire}");
}

#[test]
fn every_refusal_tells_the_user_how_to_get_x11_back() {
    for why in [
        UntrustedUnavailable::NoXauth,
        UntrustedUnavailable::NoSecurityExtension,
        UntrustedUnavailable::DisplayNotAddressable,
        UntrustedUnavailable::Failed("boom".into()),
    ] {
        let text = why.describe();
        assert!(text.starts_with("X11 forwarding is off"), "{text}");
        assert!(text.contains("Untrusted X11 forwarding"), "{text}");
    }
}

#[test]
fn debug_output_never_shows_the_untrusted_cookie() {
    let cookie = UntrustedCookie {
        hex: REAL_HEX.into(),
    };
    assert!(!format!("{cookie:?}").contains(REAL_HEX));
}

// ── Timeout ─────────────────────────────────────────────────────────────

#[test]
fn new_connections_are_accepted_only_before_the_deadline() {
    let now = tokio::time::Instant::now();
    assert!(accepts_new_connection(None, now));
    assert!(accepts_new_connection(
        Some(now + Duration::from_secs(1)),
        now
    ));
    assert!(!accepts_new_connection(Some(now), now));
    assert!(!accepts_new_connection(
        Some(now),
        now + Duration::from_secs(1)
    ));
}

#[test]
fn the_configured_timeout_maps_to_a_window_or_no_limit() {
    // Unset: OpenSSH's default 20 minutes.
    assert_eq!(untrusted_x11_timeout(None), Some(UNTRUSTED_X11_TIMEOUT));
    assert_eq!(UNTRUSTED_X11_TIMEOUT, Duration::from_secs(20 * 60));
    // 0: no client-side limit.
    assert_eq!(untrusted_x11_timeout(Some(0)), None);
    assert_eq!(
        untrusted_x11_timeout(Some(1)),
        Some(Duration::from_secs(60))
    );
    assert_eq!(
        untrusted_x11_timeout(Some(90)),
        Some(Duration::from_secs(90 * 60))
    );
    let max = crate::config::MAX_X11_UNTRUSTED_TIMEOUT_MINS;
    assert_eq!(max, 1440);
    assert_eq!(
        untrusted_x11_timeout(Some(max)),
        Some(Duration::from_secs(u64::from(max) * 60))
    );
    // Out of range (a hand-edited config): capped, never wider.
    assert_eq!(
        untrusted_x11_timeout(Some(u32::MAX)),
        Some(Duration::from_secs(u64::from(max) * 60))
    );
}

// ── Cookie source selection ─────────────────────────────────────────────

#[tokio::test]
async fn trusted_forwarding_keeps_the_real_cookie_and_never_runs_xauth() {
    let server = tcp_server(6000, Some(REAL_HEX));
    // A program that cannot exist: running it would refuse, not trust.
    let xauth = [OsString::from("/nonexistent/termihub-5585-xauth")];
    let decision = choose_cookie_with(false, &server, Some(UNTRUSTED_X11_TIMEOUT), &xauth).await;
    assert!(matches!(decision, X11CookieDecision::Trusted));
    let (applied, deadline) = decision.apply(server).unwrap();
    assert_eq!(applied.cookie.as_deref(), Some(REAL_HEX));
    assert!(deadline.is_none());
}

#[tokio::test]
async fn untrusted_without_xauth_fails_closed() {
    let server = tcp_server(6000, Some(REAL_HEX));
    let xauth = [OsString::from("/nonexistent/termihub-5585-xauth")];
    let decision = choose_cookie_with(true, &server, Some(UNTRUSTED_X11_TIMEOUT), &xauth).await;
    assert!(matches!(
        decision,
        X11CookieDecision::Refuse(UntrustedUnavailable::NoXauth)
    ));
    assert!(decision.apply(server).is_none(), "no X11 at all");
}

#[tokio::test]
async fn untrusted_on_an_unaddressable_display_fails_closed() {
    let server = tcp_server(5999, Some(REAL_HEX));
    let decision = choose_cookie_with(true, &server, Some(UNTRUSTED_X11_TIMEOUT), &[]).await;
    assert!(matches!(
        decision,
        X11CookieDecision::Refuse(UntrustedUnavailable::DisplayNotAddressable)
    ));
}

#[cfg(unix)]
mod fake_xauth {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// The cookie the fake `xauth` "generates": `UNTRUSTED-COOKIE`.
    const UNTRUSTED: &[u8; 16] = b"UNTRUSTED-COOKIE";

    /// A fake `xauth` in `dir` that runs `body` (POSIX sh) and is first on
    /// the list; returns its path.
    fn fake(dir: &Path, body: &str) -> OsString {
        let path = dir.join("xauth");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.into_os_string()
    }

    /// A fake that records its arguments, the private dir's mode and the
    /// `XAUTHORITY` it was handed, then writes [`UNTRUSTED`] to `-f`'s file.
    fn recording_fake(dir: &Path) -> OsString {
        let log = dir.join("log");
        fake(
            dir,
            &format!(
                r#"log="{log}"
printf '%s\n' "$@" > "$log.args"
ls -ld "$(dirname "$2")" | cut -c1-10 > "$log.mode"
printf '%s\n' "$XAUTHORITY" > "$log.xauthority"
cp "$XAUTHORITY" "$log.display-auth"
printf '\377\377\000\000\000\000\000\022MIT-MAGIC-COOKIE-1\000\020UNTRUSTED-COOKIE' > "$2""#,
                log = log.display()
            ),
        )
    }

    #[tokio::test]
    async fn untrusted_forwarding_uses_the_generated_cookie() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [recording_fake(dir.path())];
        let server = tcp_server(6007, Some(REAL_HEX));
        let before = tokio::time::Instant::now();
        let decision =
            choose_cookie_with(true, &server, Some(Duration::from_secs(120)), &xauth).await;
        let (applied, deadline) = decision.apply(server).expect("forwarded");
        assert_eq!(
            applied.cookie.as_deref(),
            Some(hex::encode(UNTRUSTED).as_str()),
            "the untrusted cookie replaces the real one"
        );
        let deadline = deadline.expect("a deadline");
        assert!(deadline >= before + Duration::from_secs(120));

        let read = |ext: &str| std::fs::read_to_string(dir.path().join(format!("log.{ext}")));
        let args: Vec<String> = read("args").unwrap().lines().map(String::from).collect();
        assert_eq!(args[0], "-f");
        assert_eq!(
            &args[2..],
            [
                "generate",
                "127.0.0.1:7",
                "MIT-MAGIC-COOKIE-1",
                "untrusted",
                "timeout",
                "180" // 120 s + 60 s slack, as in OpenSSH
            ]
        );
        assert_eq!(read("mode").unwrap().trim(), "drwx------");

        // xauth authenticated with a private file holding only the real cookie.
        let authority = read("xauthority").unwrap();
        let authority = Path::new(authority.trim());
        assert_ne!(authority.file_name().unwrap(), ".Xauthority");
        let display_auth = std::fs::read(dir.path().join("log.display-auth")).unwrap();
        assert_eq!(
            display_auth,
            wild_authority_entry(&hex::decode(REAL_HEX).unwrap())
        );
        // Both temp files and their directory are gone.
        assert!(!authority.exists());
        assert!(!Path::new(&args[1]).exists());
        assert!(!authority.parent().unwrap().exists());
    }

    /// The arguments the recording fake was last run with.
    fn recorded_args(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log.args"))
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    #[tokio::test]
    async fn the_configured_timeout_sets_the_cookie_lifetime_and_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [recording_fake(dir.path())];
        let server = tcp_server(6007, Some(REAL_HEX));
        let timeout = untrusted_x11_timeout(Some(90));
        let before = tokio::time::Instant::now();
        let decision = choose_cookie_with(true, &server, timeout, &xauth).await;
        let after = tokio::time::Instant::now();
        let (_, deadline) = decision.apply(server).expect("forwarded");
        let deadline = deadline.expect("a deadline");
        let window = Duration::from_secs(90 * 60);
        assert!(deadline >= before + window && deadline <= after + window);
        let args = recorded_args(dir.path());
        assert_eq!(&args[args.len() - 2..], ["timeout", "5460"]); // 90 min + 60 s
    }

    #[tokio::test]
    async fn no_limit_asks_for_a_lasting_cookie_and_sets_no_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [recording_fake(dir.path())];
        let server = tcp_server(6007, Some(REAL_HEX));
        let decision =
            choose_cookie_with(true, &server, untrusted_x11_timeout(Some(0)), &xauth).await;
        let (applied, deadline) = decision.apply(server).expect("forwarded");
        assert_eq!(
            applied.cookie.as_deref(),
            Some(hex::encode(UNTRUSTED).as_str())
        );
        assert!(deadline.is_none(), "no client-side refusal");
        let args = recorded_args(dir.path());
        assert_eq!(&args[args.len() - 2..], ["timeout", "0"]);
    }

    #[tokio::test]
    async fn a_server_without_security_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [fake(
            dir.path(),
            r#"echo "xauth: (argv):1:  couldn't query Security extension on display \"$4\"" >&2
exit 1"#,
        )];
        let server = tcp_server(6000, None);
        let decision = choose_cookie_with(true, &server, Some(UNTRUSTED_X11_TIMEOUT), &xauth).await;
        assert!(matches!(
            decision,
            X11CookieDecision::Refuse(UntrustedUnavailable::NoSecurityExtension)
        ));
        assert!(decision.apply(server).is_none());
    }

    #[tokio::test]
    async fn xauth_that_writes_no_cookie_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [fake(dir.path(), ": > \"$2\"")];
        let decision = choose_cookie_with(
            true,
            &tcp_server(6000, Some(REAL_HEX)),
            Some(UNTRUSTED_X11_TIMEOUT),
            &xauth,
        )
        .await;
        assert!(matches!(
            decision,
            X11CookieDecision::Refuse(UntrustedUnavailable::Failed(_))
        ));
    }

    #[tokio::test]
    async fn the_next_candidate_is_tried_when_one_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let xauth = [
            OsString::from("/nonexistent/termihub-5585-xauth"),
            recording_fake(dir.path()),
        ];
        let decision = choose_cookie_with(
            true,
            &tcp_server(6000, Some(REAL_HEX)),
            Some(UNTRUSTED_X11_TIMEOUT),
            &xauth,
        )
        .await;
        assert!(matches!(decision, X11CookieDecision::Untrusted { .. }));
    }
}
