//! The handler records the algorithms a real key exchange negotiated
//! (#5896), driven over the in-process SFTP-only test server so russh's own
//! negotiation runs.

use std::sync::Arc;

use async_trait::async_trait;

use crate::backends::ssh::auth::handshake_and_authenticate_with;
use crate::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier};
use crate::backends::ssh::sftp_only_test_server::{serve, PASSWORD, USER};
use crate::config::SshConfig;
use crate::connection::ssh_algorithms::is_aead_cipher;

/// Trusts the test server's key without consulting any trust store.
struct TrustAll;

#[async_trait]
impl HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &HostKeyInfo) -> bool {
        true
    }
}

#[tokio::test]
async fn a_real_handshake_records_the_negotiated_algorithms() {
    let config = SshConfig {
        host: "algorithms.test".to_string(),
        port: 22,
        username: USER.to_string(),
        auth_method: "password".to_string(),
        password: Some(PASSWORD.to_string()),
        ..SshConfig::default()
    };
    let (stream, _observed) = serve();
    let login = handshake_and_authenticate_with(&config, stream, Some(Arc::new(TrustAll)));
    let (_session, _registry, liveness) =
        tokio::time::timeout(std::time::Duration::from_secs(30), login)
            .await
            .expect("the test server answers")
            .expect("login");

    let algorithms = liveness
        .algorithms()
        .expect("the first key exchange recorded its algorithms");
    // The test server's only host key is Ed25519.
    assert_eq!(algorithms.host_key, "ssh-ed25519");
    assert!(!algorithms.kex.is_empty(), "a key exchange is named");
    assert!(!algorithms.cipher.is_empty(), "a cipher is named");
    assert_ne!(algorithms.cipher, "none");
    // russh negotiates a MAC name even for an AEAD cipher; it is dropped then.
    assert_eq!(
        algorithms.mac.is_none(),
        is_aead_cipher(&algorithms.cipher),
        "the MAC is reported exactly when the cipher needs one: {algorithms:?}"
    );
}
