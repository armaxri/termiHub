//! How a followed Server Redirection shapes the reconnect (#5137): the hop's
//! identity and trust key, its connector settings, and a preflight that sends
//! nothing naming the user.

use std::time::Duration;

use ironrdp_connector::Credentials;
use ironrdp_pdu::gcc::{RedirectionFlags, RedirectionVersion};
use termihub_core::backends::rdp_sidecar::config::RdpConfig;
use tokio::io::AsyncReadExt as _;
use tokio::net::TcpListener;

use super::Hop;
use super::{hop_cluster_data, hop_connector_config, preflight_connector_config, probe_identity};
use crate::redirect::{Admitted, Endpoint, Redirect};

fn config() -> RdpConfig {
    RdpConfig {
        host: "broker.example.com".to_string(),
        username: "saved-user".to_string(),
        password: "saved-password".to_string(),
        domain: "SAVED".to_string(),
        ..RdpConfig::default()
    }
}

fn redirect(back_to_issuer: bool) -> Redirect {
    Redirect {
        endpoint: Endpoint {
            addresses: vec!["10.0.0.2".to_string()],
            server_name: "rdsh2.example.com".to_string(),
        },
        back_to_issuer,
        session_id: 42,
        routing_token: Some("Cookie: msts=1".to_string()),
        username: None,
        domain: None,
        password_cookie: None,
    }
}

fn admitted() -> Admitted {
    Admitted {
        address: "10.0.0.2".to_string(),
        trusted_fingerprint: Some("sha256:AA".to_string()),
    }
}

#[test]
fn a_redirect_hop_is_trusted_under_the_target_name() {
    let origin = Hop::origin(&config());
    assert_eq!(origin.trust_host, None, "the origin keys on its own host");
    assert!(origin.can_follow);

    let hop = origin.redirected(redirect(false), admitted());
    assert_eq!(hop.address, "10.0.0.2");
    assert_eq!(hop.port, origin.port);
    assert_eq!(hop.endpoint.server_name, "rdsh2.example.com");
    assert_eq!(hop.trust_host.as_deref(), Some("rdsh2.example.com"));
    assert_eq!(hop.trusted_fingerprint.as_deref(), Some("sha256:AA"));

    // Back to the issuer: still the issuer's trust key.
    let back = origin.redirected(redirect(true), admitted());
    assert_eq!(back.trust_host, None);
}

#[test]
fn a_forwarded_connection_cannot_follow_and_advertises_no_support() {
    let tunnelled = RdpConfig {
        host: "127.0.0.1".to_string(),
        tls_server_name: Some("desk.corp".to_string()),
        ..config()
    };
    let hop = Hop::origin(&tunnelled);
    assert!(!hop.can_follow);
    assert_eq!(hop_cluster_data(&hop), None);
}

#[test]
fn the_cluster_data_carries_the_redirected_session() {
    let origin = Hop::origin(&config());
    let first = hop_cluster_data(&origin).expect("redirection support is advertised");
    assert_eq!(first.flags, RedirectionFlags::REDIRECTION_SUPPORTED);
    assert_eq!(first.redirection_version, RedirectionVersion::V5);

    let hop = origin.redirected(redirect(false), admitted());
    let cluster = hop_cluster_data(&hop).unwrap();
    assert!(cluster
        .flags
        .contains(RedirectionFlags::REDIRECTED_SESSION_FIELD_VALID));
    assert_eq!(cluster.redirected_session_id, 42);
}

fn username(config: &ironrdp_connector::Config) -> String {
    match &config.credentials {
        Credentials::UsernamePassword { username, .. } => username.clone(),
        Credentials::SmartCard { .. } => panic!("no smart card"),
    }
}

#[test]
fn the_redirections_username_and_domain_replace_the_saved_ones() {
    let cfg = config();
    let origin = Hop::origin(&cfg);
    let saved = hop_connector_config(&cfg, &origin).unwrap();
    assert_eq!(username(&saved), "saved-user");

    // Absent from the redirection: the saved ones.
    let plain = origin.redirected(redirect(false), admitted());
    let config = hop_connector_config(&cfg, &plain).unwrap();
    assert_eq!(username(&config), "saved-user");
    assert_eq!(config.domain.as_deref(), Some("SAVED"));

    let mut with_creds = redirect(false);
    with_creds.username = Some("alice".to_string());
    with_creds.domain = Some("CORP".to_string());
    with_creds.password_cookie = Some(b"cookie".to_vec());
    let hop = origin.redirected(with_creds, admitted());
    let config = hop_connector_config(&cfg, &hop).unwrap();
    assert_eq!(username(&config), "alice");
    assert_eq!(config.domain.as_deref(), Some("CORP"));
    assert!(
        config.autologon,
        "the cookie rides an autologon Client Info"
    );
    let Credentials::UsernamePassword { password, .. } = &config.credentials else {
        panic!("password credentials");
    };
    assert_eq!(
        password, "saved-password",
        "the saved password authenticates"
    );
}

#[test]
fn the_preflight_config_carries_no_credentials() {
    let config = preflight_connector_config(&config()).unwrap();
    assert_eq!(username(&config), "");
    let Credentials::UsernamePassword { password, .. } = &config.credentials else {
        panic!("password credentials");
    };
    assert!(password.is_empty());
    assert_eq!(config.domain, None);
    assert!(!config.autologon);
}

/// The preflight's X.224 request, captured on the wire, names neither the
/// user nor the routing token: the trust gate has not run yet.
#[tokio::test]
async fn the_preflight_request_names_nobody() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0u8; 512];
        let n = socket.read(&mut request).await.unwrap();
        request.truncate(n);
        request
    });

    let cfg = RdpConfig {
        connect_timeout_secs: Some(2),
        ..config()
    };
    let probe = tokio::time::timeout(
        Duration::from_secs(10),
        probe_identity(&cfg, "127.0.0.1", port, "rdsh2.example.com"),
    )
    .await
    .expect("the probe is bounded");
    assert!(probe.is_err(), "the peer hangs up without answering");

    let request = server.await.unwrap();
    assert!(!request.is_empty(), "an X.224 request was sent");
    let text = String::from_utf8_lossy(&request);
    for secret in ["saved-user", "mstshash", "Cookie", "saved-password"] {
        assert!(!text.contains(secret), "{secret} in {text:?}");
    }
}
