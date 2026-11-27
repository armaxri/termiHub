//! A target that takes the channel and ends it at once without a byte is
//! counted as refused (#6139): Win32-OpenSSH opens a `direct-tcpip` channel
//! before its connect to the target and closes it when the target refuses.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::super::channel::test_support::HoldingChannelOpener;
use super::super::config::LocalForwardConfig;
use super::LocalForwarder;

fn config() -> LocalForwardConfig {
    LocalForwardConfig {
        local_host: "127.0.0.1".to_string(),
        local_port: 0,
        remote_host: "target".to_string(),
        remote_port: 80,
    }
}

async fn until(what: &str, pred: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !pred() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn a_channel_the_server_ends_at_once_without_a_byte_is_refused() {
    let opener = HoldingChannelOpener::new();
    let (opens, fars) = (opener.opens(), opener.fars_handle());
    let forwarder = LocalForwarder::start_with_opener(&config(), opener).unwrap();
    let mut client = TcpStream::connect(forwarder.local_addr()).await.unwrap();
    client.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
    until("the channel opens", || opens.load(Ordering::SeqCst) == 1).await;
    // The server ends the channel: the target refused.
    fars.lock().unwrap().clear();
    let mut answer = Vec::new();
    let _ = client.read_to_end(&mut answer).await;
    assert!(answer.is_empty());
    drop(client);
    until("the refusal is counted", || {
        forwarder.get_stats().refused == 1
    })
    .await;
}

#[tokio::test]
async fn a_client_that_leaves_first_is_not_a_refusal() {
    let opener = HoldingChannelOpener::new();
    let (opens, fars) = (opener.opens(), opener.fars_handle());
    let forwarder = LocalForwarder::start_with_opener(&config(), opener).unwrap();
    let client = TcpStream::connect(forwarder.local_addr()).await.unwrap();
    until("the channel opens", || opens.load(Ordering::SeqCst) == 1).await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(100)).await;
    fars.lock().unwrap().clear();
    until("the relay ends", || {
        forwarder.get_stats().active_connections == 0
    })
    .await;
    assert_eq!(forwarder.get_stats().refused, 0);
}

#[tokio::test]
async fn a_target_that_answered_is_not_a_refusal() {
    let opener = HoldingChannelOpener::new();
    let (opens, fars) = (opener.opens(), opener.fars_handle());
    let forwarder = LocalForwarder::start_with_opener(&config(), opener).unwrap();
    let mut client = TcpStream::connect(forwarder.local_addr()).await.unwrap();
    until("the channel opens", || opens.load(Ordering::SeqCst) == 1).await;
    let mut far = fars.lock().unwrap().pop().unwrap();
    far.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.unwrap();
    drop(far);
    let mut answer = Vec::new();
    let _ = client.read_to_end(&mut answer).await;
    assert!(!answer.is_empty());
    drop(client);
    until("the relay ends", || {
        forwarder.get_stats().active_connections == 0
    })
    .await;
    assert_eq!(forwarder.get_stats().refused, 0);
}
