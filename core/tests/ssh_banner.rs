//! SSH Banner Integration Tests (SSH-BANNER-01 through SSH-BANNER-02).
//!
//! Tests that termiHub correctly handles SSH pre-authentication banners
//! and distinguishes banner-enabled servers from standard ones.
//!
//! Docker containers used:
//! - `ssh-banner` on port 2206 (pre-auth banner + MOTD)
//! - `ssh-password` on port 2201 (standard server, no banner)
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use common::{require_docker, ssh_password_config, PORT_SSH_BANNER, PORT_SSH_PASSWORD};
use termihub_core::backends::ssh::auth::connect_and_authenticate;

// ── SSH-BANNER-01: Pre-auth banner delivered ─────────────────────────

/// Verify the ssh-banner container sends its configured banner text after auth.
///
/// The `ssh2::Session::banner()` method returns the `SSH_MSG_USERAUTH_BANNER`
/// message sent by the server. The banner text is configured in the container's
/// `/etc/ssh/banner.txt` via `sshd_config Banner` directive.
#[test]
fn ssh_banner_01_banner_received() {
    require_docker!(PORT_SSH_BANNER);

    let config = ssh_password_config(PORT_SSH_BANNER);
    let session = connect_and_authenticate(&config)
        .expect("SSH-BANNER-01: Should authenticate to the banner server");

    let banner = session.banner();
    assert!(
        banner.is_some(),
        "SSH-BANNER-01: Banner server should send a banner, but session.banner() returned None"
    );

    let banner_text = banner.unwrap();
    assert!(
        banner_text.contains("AUTHORIZED ACCESS ONLY"),
        "SSH-BANNER-01: Banner should contain 'AUTHORIZED ACCESS ONLY', got:\n{banner_text}"
    );
    assert!(
        banner_text.contains("termiHub test server"),
        "SSH-BANNER-01: Banner should contain 'termiHub test server', got:\n{banner_text}"
    );
}

// ── SSH-BANNER-02: Standard server sends no banner ───────────────────

/// Verify that the standard ssh-password container does not send a banner.
///
/// The `ssh-password` container has no `Banner` directive in its sshd_config,
/// so `session.banner()` should return `None` or an empty string.
#[test]
fn ssh_banner_02_no_banner_on_standard_server() {
    require_docker!(PORT_SSH_PASSWORD);

    let config = ssh_password_config(PORT_SSH_PASSWORD);
    let session = connect_and_authenticate(&config)
        .expect("SSH-BANNER-02: Should authenticate to the standard server");

    let banner = session.banner();
    let is_empty = banner.map(|b| b.trim().is_empty()).unwrap_or(true);
    assert!(
        is_empty,
        "SSH-BANNER-02: Standard SSH server should not send a banner, got: {:?}",
        banner
    );
}
