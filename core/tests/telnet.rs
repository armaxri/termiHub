//! Telnet Integration Tests (TEL-01 through TEL-03).
//!
//! Tests termiHub's telnet backend against the Docker telnet container.
//!
//! Container: `telnet-server` on port 2301.
//!
//! Requires: `docker compose -f tests/docker/docker-compose.yml up -d`
//! Skips gracefully if containers are not running.

mod common;

use std::time::Duration;

use common::{require_docker, PORT_TELNET};
use termihub_core::backends::telnet::Telnet;
use termihub_core::connection::ConnectionType;

// ── TEL-01: Connect and verify connected state ──────────────────────

#[tokio::test]
async fn tel_01_connect() {
    require_docker!(PORT_TELNET);

    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": PORT_TELNET
    });

    telnet
        .connect(settings)
        .await
        .expect("TEL-01: Telnet connect should succeed");

    assert!(telnet.is_connected(), "TEL-01: Telnet should be connected");

    telnet
        .disconnect()
        .await
        .expect("Disconnect should succeed");
}

// ── TEL-02: Receive banner/prompt output ─────────────────────────────

#[tokio::test]
async fn tel_02_receive_output() {
    require_docker!(PORT_TELNET);

    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": PORT_TELNET
    });

    telnet
        .connect(settings)
        .await
        .expect("TEL-02: Telnet connect should succeed");

    // Subscribe to output and wait for banner or login prompt.
    let mut rx = telnet.subscribe_output();
    let mut accumulated = String::new();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(data)) => {
                accumulated.push_str(&String::from_utf8_lossy(&data));
                // Telnet servers typically send a banner or login prompt.
                if !accumulated.is_empty() {
                    break;
                }
            }
            Ok(None) => {
                panic!("TEL-02: Output channel closed unexpectedly");
            }
            Err(_) => {
                panic!("TEL-02: Timed out waiting for telnet output");
            }
        }
    }

    assert!(
        !accumulated.is_empty(),
        "TEL-02: Should receive some output from telnet server"
    );

    telnet
        .disconnect()
        .await
        .expect("Disconnect should succeed");
}

// ── TEL-03: Command execution (login + whoami) ───────────────────────

#[tokio::test]
async fn tel_03_command_execution() {
    require_docker!(PORT_TELNET);

    let mut telnet = Telnet::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": PORT_TELNET
    });

    telnet
        .connect(settings)
        .await
        .expect("TEL-03: Telnet connect should succeed");

    let mut rx = telnet.subscribe_output();

    // Wait for the login prompt.
    let mut accumulated = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(data)) => {
                accumulated.push_str(&String::from_utf8_lossy(&data));
                if accumulated.to_lowercase().contains("login") {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    // Send username.
    telnet
        .write(b"testuser\r\n")
        .expect("Username write should succeed");

    // Wait for password prompt.
    accumulated.clear();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(data)) => {
                accumulated.push_str(&String::from_utf8_lossy(&data));
                if accumulated.to_lowercase().contains("password") {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    // Send password.
    telnet
        .write(b"testpass\r\n")
        .expect("Password write should succeed");

    // Wait for shell prompt ($ or #).
    accumulated.clear();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(data)) => {
                accumulated.push_str(&String::from_utf8_lossy(&data));
                if accumulated.contains('$') || accumulated.contains('#') {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    // Send whoami command.
    telnet
        .write(b"whoami\r\n")
        .expect("whoami write should succeed");

    // Read output until we find "testuser".
    accumulated.clear();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(data)) => {
                accumulated.push_str(&String::from_utf8_lossy(&data));
                if accumulated.contains("testuser") {
                    break;
                }
            }
            Ok(None) => {
                panic!("TEL-03: Channel closed before finding 'testuser'. Output so far: {accumulated}");
            }
            Err(_) => {
                panic!("TEL-03: Timed out waiting for 'testuser'. Output so far: {accumulated}");
            }
        }
    }

    assert!(
        accumulated.contains("testuser"),
        "TEL-03: 'whoami' should return 'testuser', got: {accumulated}"
    );

    telnet
        .disconnect()
        .await
        .expect("Disconnect should succeed");
}
