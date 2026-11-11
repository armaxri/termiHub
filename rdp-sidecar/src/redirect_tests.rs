//! Target selection, the hop limit / loop guard, and the trust-gate-first
//! ordering of a followed Server Redirection (#5137).

use super::*;
use ironrdp_pdu::rdp::server_redirection::ServerRedirectionPdu;

fn origin() -> Endpoint {
    Endpoint {
        addresses: vec!["broker.example.com".to_string()],
        server_name: "broker.example.com".to_string(),
    }
}

fn pdu() -> ServerRedirectionPdu {
    ServerRedirectionPdu {
        session_id: 7,
        ..ServerRedirectionPdu::default()
    }
}

#[test]
fn addresses_are_tried_net_address_first_then_the_list_then_names() {
    let pdu = ServerRedirectionPdu {
        target_net_address: Some("10.0.0.2\0".to_string()),
        target_net_addresses: Some(vec![
            "10.0.0.2".to_string(),
            "fe80::2".to_string(),
            "  ".to_string(),
        ]),
        target_fqdn: Some("RDSH2.example.com".to_string()),
        target_netbios_name: Some("rdsh2.EXAMPLE.com".to_string()),
        ..pdu()
    };
    // Trimmed, blanks dropped, duplicates (case-insensitive) removed.
    assert_eq!(
        target_addresses(&pdu),
        vec!["10.0.0.2", "fe80::2", "RDSH2.example.com"]
    );
}

#[test]
fn the_server_name_prefers_the_fqdn_then_netbios_then_the_address() {
    let by_fqdn = ServerRedirectionPdu {
        target_net_address: Some("10.0.0.2".to_string()),
        target_fqdn: Some("rdsh2.example.com".to_string()),
        target_netbios_name: Some("RDSH2".to_string()),
        ..pdu()
    };
    let redirect = plan(&by_fqdn, &origin()).unwrap();
    assert_eq!(redirect.endpoint.server_name, "rdsh2.example.com");
    assert_eq!(redirect.endpoint.addresses[0], "10.0.0.2");
    assert!(!redirect.back_to_issuer);

    let by_netbios = ServerRedirectionPdu {
        target_net_address: Some("10.0.0.2".to_string()),
        target_netbios_name: Some("RDSH2".to_string()),
        ..pdu()
    };
    assert_eq!(
        plan(&by_netbios, &origin()).unwrap().endpoint.server_name,
        "RDSH2"
    );

    let by_address = ServerRedirectionPdu {
        target_net_address: Some("10.0.0.2".to_string()),
        ..pdu()
    };
    assert_eq!(
        plan(&by_address, &origin()).unwrap().endpoint.server_name,
        "10.0.0.2"
    );
}

#[test]
fn a_routing_token_without_a_target_reconnects_to_the_issuer() {
    let revector = ServerRedirectionPdu {
        load_balance_info: Some(b"Cookie: msts=3640205228.15629.0000\r\n".to_vec()),
        ..pdu()
    };
    let redirect = plan(&revector, &origin()).unwrap();
    assert!(redirect.back_to_issuer);
    assert_eq!(redirect.endpoint, origin());
    // Sent without its CRLF; the X.224 encoder adds it.
    assert_eq!(
        redirect.routing_token.as_deref(),
        Some("Cookie: msts=3640205228.15629.0000")
    );
    assert_eq!(redirect.session_id, 7);
}

#[test]
fn a_redirection_naming_nothing_is_refused() {
    assert_eq!(
        plan(&pdu(), &origin()).unwrap_err(),
        RedirectRefused::NoTarget
    );
}

#[test]
fn an_unsendable_routing_token_is_refused() {
    for info in [
        b"\x01\x02binary".to_vec(),
        vec![b'a'; 239],
        b"\r\n".to_vec(),
    ] {
        let bad = ServerRedirectionPdu {
            target_fqdn: Some("rdsh2".to_string()),
            load_balance_info: Some(info),
            ..pdu()
        };
        assert_eq!(
            plan(&bad, &origin()).unwrap_err(),
            RedirectRefused::UnusableRoutingToken {
                target: "rdsh2".to_string()
            }
        );
    }
}

#[test]
fn the_redirections_credentials_replace_the_saved_ones_when_present() {
    let with_creds = ServerRedirectionPdu {
        target_fqdn: Some("rdsh2".to_string()),
        username: Some("alice\0".to_string()),
        domain: Some("CORP".to_string()),
        password: Some(b"c\0o\0o\0k\0i\0e\0".to_vec()),
        ..pdu()
    };
    let redirect = plan(&with_creds, &origin()).unwrap();
    assert_eq!(redirect.username.as_deref(), Some("alice"));
    assert_eq!(redirect.domain.as_deref(), Some("CORP"));
    assert_eq!(
        redirect.password_cookie.as_deref(),
        Some(&b"c\0o\0o\0k\0i\0e\0"[..])
    );
    // The cookie never reaches a log line.
    let debug = format!("{redirect:?}");
    assert!(!debug.contains("c\\0o"), "{debug}");
    assert!(debug.contains("password_cookie: true"), "{debug}");

    let without = ServerRedirectionPdu {
        target_fqdn: Some("rdsh2".to_string()),
        username: Some("  ".to_string()),
        ..pdu()
    };
    let redirect = plan(&without, &origin()).unwrap();
    assert_eq!(redirect.username, None);
    assert_eq!(redirect.domain, None);
    assert_eq!(redirect.password_cookie, None);
}

#[test]
fn a_pk_encrypted_password_is_not_sent_as_a_cookie() {
    let rdstls = ServerRedirectionPdu {
        target_fqdn: Some("rdsh2".to_string()),
        flags: ServerRedirectionFlags::PASSWORD_IS_PK_ENCRYPTED,
        password: Some(vec![0xAB; 32]),
        ..pdu()
    };
    assert_eq!(plan(&rdstls, &origin()).unwrap().password_cookie, None);
}

fn redirect_to(name: &str, token: Option<&str>, session_id: u32) -> Redirect {
    Redirect {
        endpoint: Endpoint {
            addresses: vec![name.to_string()],
            server_name: name.to_string(),
        },
        back_to_issuer: false,
        session_id,
        routing_token: token.map(str::to_string),
        username: None,
        domain: None,
        password_cookie: None,
    }
}

#[test]
fn three_hops_are_followed_and_a_fourth_is_refused() {
    let mut guard = HopGuard::new(&origin());
    for name in ["a", "b", "c"] {
        guard.admit(&redirect_to(name, None, 1)).unwrap();
    }
    assert_eq!(guard.hops(), MAX_REDIRECT_HOPS);
    let refused = guard.admit(&redirect_to("d", None, 1)).unwrap_err();
    assert_eq!(
        refused,
        RedirectRefused::TooManyHops {
            target: "d".to_string()
        }
    );
    assert!(refused.to_string().contains("after 3 redirections"));
}

#[test]
fn revisiting_a_target_with_the_same_token_and_session_is_a_loop() {
    let mut guard = HopGuard::new(&origin());
    guard.admit(&redirect_to("rdsh2", Some("t"), 5)).unwrap();
    // Ping-pong back to the broker is a new visit (it now carries a session) …
    let mut back = redirect_to("broker.example.com", None, 5);
    back.endpoint = origin();
    guard.admit(&back).unwrap();
    // … but the same target again, case aside, is a loop.
    let refused = guard
        .admit(&redirect_to("RDSH2", Some("t"), 5))
        .unwrap_err();
    assert_eq!(
        refused,
        RedirectRefused::Loop {
            target: "RDSH2".to_string()
        }
    );
    assert!(refused.to_string().contains("in a loop, back to RDSH2"));
}

#[test]
fn a_redirection_straight_back_to_the_origin_is_a_loop() {
    let mut guard = HopGuard::new(&origin());
    let mut same = redirect_to("broker.example.com", None, 0);
    same.endpoint = origin();
    assert!(matches!(
        guard.admit(&same),
        Err(RedirectRefused::Loop { .. })
    ));
    // With a routing token it is revectoring, not a loop.
    let mut revector = redirect_to("broker.example.com", Some("tok"), 0);
    revector.endpoint = origin();
    guard.admit(&revector).unwrap();
}

/// Records what the redirect admission does, in order.
#[derive(Default)]
struct Recorder {
    events: Vec<String>,
    unreachable: Vec<&'static str>,
    reject: bool,
}

impl Preflight for Recorder {
    async fn probe(&mut self, address: &str, server_name: &str) -> Result<ServerIdentity> {
        self.events
            .push(format!("probe {address} as {server_name}"));
        if self.unreachable.contains(&address) {
            anyhow::bail!("connection refused");
        }
        Ok(ServerIdentity {
            fingerprint: format!("sha256:{address}"),
            subject: None,
            issuer: None,
        })
    }

    async fn trust(&mut self, server_name: &str, identity: &ServerIdentity) -> Result<()> {
        self.events
            .push(format!("trust {} for {server_name}", identity.fingerprint));
        if self.reject {
            anyhow::bail!("connection rejected: not trusted");
        }
        Ok(())
    }
}

fn two_address_redirect() -> Redirect {
    Redirect {
        endpoint: Endpoint {
            addresses: vec!["10.0.0.2".to_string(), "10.0.0.3".to_string()],
            server_name: "rdsh2.example.com".to_string(),
        },
        routing_token: Some("tok".to_string()),
        password_cookie: Some(b"secret".to_vec()),
        ..redirect_to("unused", None, 7)
    }
}

/// The new server's certificate passes the trust gate before the reconnect
/// (which carries the routing token and credentials) is allowed to start: the
/// probe sends nothing identifying, then the gate runs, then admission returns.
#[tokio::test]
async fn the_trust_gate_runs_before_anything_is_sent() {
    let mut recorder = Recorder::default();
    let admitted = admit(&mut recorder, &two_address_redirect()).await.unwrap();
    assert_eq!(
        recorder.events,
        vec![
            "probe 10.0.0.2 as rdsh2.example.com",
            "trust sha256:10.0.0.2 for rdsh2.example.com",
        ]
    );
    assert_eq!(admitted.address, "10.0.0.2");
    assert_eq!(
        admitted.trusted_fingerprint.as_deref(),
        Some("sha256:10.0.0.2")
    );
}

#[tokio::test]
async fn an_untrusted_target_ends_the_redirection_without_trying_others() {
    let mut recorder = Recorder {
        reject: true,
        ..Recorder::default()
    };
    let error = admit(&mut recorder, &two_address_redirect())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not trusted"), "{error}");
    // No further probe: a rejection is the user's verdict on the target.
    assert_eq!(recorder.events.len(), 2, "{:?}", recorder.events);
}

#[tokio::test]
async fn an_unreachable_address_falls_through_to_the_next() {
    let mut recorder = Recorder {
        unreachable: vec!["10.0.0.2"],
        ..Recorder::default()
    };
    let admitted = admit(&mut recorder, &two_address_redirect()).await.unwrap();
    assert_eq!(admitted.address, "10.0.0.3");
    assert_eq!(
        recorder.events,
        vec![
            "probe 10.0.0.2 as rdsh2.example.com",
            "probe 10.0.0.3 as rdsh2.example.com",
            "trust sha256:10.0.0.3 for rdsh2.example.com",
        ]
    );

    let mut none = Recorder {
        unreachable: vec!["10.0.0.2", "10.0.0.3"],
        ..Recorder::default()
    };
    assert!(admit(&mut none, &two_address_redirect()).await.is_err());
    assert!(none.events.iter().all(|e| e.starts_with("probe")));
}

#[tokio::test]
async fn a_redirection_back_to_the_issuer_needs_no_preflight() {
    let mut recorder = Recorder::default();
    let mut back = two_address_redirect();
    back.back_to_issuer = true;
    let admitted = admit(&mut recorder, &back).await.unwrap();
    assert!(recorder.events.is_empty());
    assert_eq!(admitted.trusted_fingerprint, None);
}

#[test]
fn only_the_preflighted_certificate_skips_the_second_prompt() {
    assert!(already_trusted(Some("sha256:AA"), "sha256:AA"));
    assert!(!already_trusted(Some("sha256:AA"), "sha256:BB"));
    assert!(!already_trusted(None, "sha256:AA"));
}

#[test]
fn the_target_name_never_carries_secrets() {
    let pdu = ServerRedirectionPdu {
        target_net_address: Some("10.0.0.2".to_string()),
        password: Some(b"hunter2".to_vec()),
        ..pdu()
    };
    assert_eq!(target_name(&pdu), "10.0.0.2");
    assert_eq!(
        target_name(&ServerRedirectionPdu::default()),
        "another server"
    );
}
