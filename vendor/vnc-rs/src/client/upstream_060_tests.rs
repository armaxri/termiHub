//! termiHub fork (#3499): regression tests for the fixes ported from vnc-rs
//! 0.6.0's RFB hardening (upstream b266a3f, 6adeb0d, dea233d). Each test drives
//! the real handshake / client over an in-memory duplex "server".

use std::future::Ready;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::auth::{AuthHelper, AuthResult, SecurityType};
use super::connector::VncConnector;
use crate::{PixelFormat, VncEncoding, VncError, VncVersion, X11Event};

type Password = Ready<Result<String, VncError>>;

fn password() -> Password {
    std::future::ready(Ok("secret".to_string()))
}

/// Run the client handshake against a scripted server. `server` gets the
/// server end of the pipe after the version exchange.
async fn handshake<Fut>(
    version: &'static [u8; 12],
    server: impl FnOnce(DuplexStream) -> Fut,
) -> Result<(), VncError>
where
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (client_io, mut server_io) = tokio::io::duplex(4096);
    server_io.write_all(version).await.unwrap();
    let mut echoed = [0; 12];
    let connector = VncConnector::<_, Password>::new(client_io)
        .set_auth_method(password())
        .add_encoding(VncEncoding::Raw)
        .set_pixel_format(PixelFormat::rgba())
        .build()
        .unwrap();
    let client = tokio::spawn(async move { connector.try_start().await.map(|_| ()) });
    server_io.read_exact(&mut echoed).await.unwrap();
    let server_task = tokio::spawn(server(server_io));
    let result = tokio::time::timeout(Duration::from_secs(5), client)
        .await
        .expect("handshake must not hang")
        .unwrap();
    server_task.abort();
    result
}

// ------------------------------------------------------------ auth.rs ---

#[tokio::test]
async fn security_result_is_checked_instead_of_transmuted() {
    for status in [0_u32, 1, 2, 256, u32::MAX] {
        let (mut server, mut client) = tokio::io::duplex(8);
        server.write_all(&status.to_be_bytes()).await.unwrap();
        let result = super::auth::read_auth_result(&mut client).await;
        match status {
            0 => assert_eq!(result.unwrap(), AuthResult::Ok),
            1 => assert_eq!(result.unwrap(), AuthResult::Failed),
            _ => assert!(matches!(result, Err(VncError::Protocol(_))), "{status}"),
        }
    }
    // The VncAuth path goes through the same check.
    let (mut server, mut client) = tokio::io::duplex(64);
    server.write_all(&[0; 16]).await.unwrap();
    server.write_all(&7_u32.to_be_bytes()).await.unwrap();
    let auth = AuthHelper::read(&mut client, "pw").await.unwrap();
    assert!(auth.finish(&mut client).await.is_err());
}

#[tokio::test]
async fn rfb33_security_type_is_not_narrowed_to_u8() {
    // 257 as u8 == 1 (None): upstream 0.5.3 silently skipped authentication.
    for value in [3_u32, 257, 258, u32::MAX] {
        let result =
            SecurityType::read(&mut value.to_be_bytes().as_slice(), &VncVersion::RFB33).await;
        assert!(
            matches!(result, Err(VncError::Protocol(_))),
            "{value}: {result:?}"
        );
    }
    let ok = SecurityType::read(&mut 2_u32.to_be_bytes().as_slice(), &VncVersion::RFB33).await;
    assert_eq!(ok.unwrap(), vec![SecurityType::VncAuth]);
}

#[tokio::test]
async fn unknown_offered_security_types_are_skipped() {
    let mut offers = &[3, 250, 2, 1][..];
    assert_eq!(
        SecurityType::read(&mut offers, &VncVersion::RFB38)
            .await
            .unwrap(),
        vec![SecurityType::VncAuth, SecurityType::None]
    );
    assert!(offers.is_empty(), "the whole offer list is consumed");
    let mut unknown = &[1, 250][..];
    assert!(SecurityType::read(&mut unknown, &VncVersion::RFB38)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn failure_reason_is_bounded_and_framed() {
    for version in [VncVersion::RFB33, VncVersion::RFB37, VncVersion::RFB38] {
        let mut bytes = if version == VncVersion::RFB33 {
            vec![0; 4]
        } else {
            vec![0]
        };
        bytes.extend(2_u32.to_be_bytes());
        bytes.extend(b"noNEXT");
        let mut input = bytes.as_slice();
        assert!(matches!(
            SecurityType::read(&mut input, &version).await,
            Err(VncError::General(reason)) if reason == "no"
        ));
        assert_eq!(input, b"NEXT", "{version:?}: reason length respected");
    }
    // A 4 GiB reason is truncated to the bound, not allocated.
    let mut bytes = vec![0];
    bytes.extend(u32::MAX.to_be_bytes());
    bytes.extend(vec![b'x'; 10_000]);
    match SecurityType::read(&mut bytes.as_slice(), &VncVersion::RFB38).await {
        Err(VncError::General(reason)) => {
            assert_eq!(reason.len(), super::auth::MAX_REASON_BYTES as usize)
        }
        other => panic!("{other:?}"),
    }
}

// ------------------------------------------------------- connector.rs ---

#[tokio::test]
async fn an_offer_of_only_unknown_types_is_an_error_not_a_panic() {
    let result = handshake(b"RFB 003.008\n", |mut s| async move {
        s.write_all(&[2, 200, 250]).await.unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn rfb38_no_auth_failure_result_is_honoured() {
    let result = handshake(b"RFB 003.008\n", |mut s| async move {
        s.write_all(&[1, 1]).await.unwrap(); // offer None
        let mut chosen = [0];
        s.read_exact(&mut chosen).await.unwrap();
        assert_eq!(chosen, [1]);
        s.write_all(&1_u32.to_be_bytes()).await.unwrap(); // Failed
        s.write_all(&6_u32.to_be_bytes()).await.unwrap();
        s.write_all(b"denied").await.unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(
        matches!(&result, Err(VncError::General(r)) if r == "denied"),
        "{result:?}"
    );
}

#[tokio::test]
async fn rfb38_no_auth_with_unknown_result_is_rejected() {
    let result = handshake(b"RFB 003.008\n", |mut s| async move {
        s.write_all(&[1, 1]).await.unwrap();
        let mut chosen = [0];
        s.read_exact(&mut chosen).await.unwrap();
        s.write_all(&9_u32.to_be_bytes()).await.unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(matches!(result, Err(VncError::Protocol(_))), "{result:?}");
}

#[tokio::test]
async fn rfb33_vnc_auth_failure_does_not_wait_for_a_reason() {
    // RFB 3.3 sends no reason after a failed SecurityResult; upstream 0.5.3
    // (and the fork before #3499) tried to read one and hung until the server
    // closed the socket. The server here keeps it open.
    let result = handshake(b"RFB 003.003\n", |mut s| async move {
        s.write_all(&2_u32.to_be_bytes()).await.unwrap(); // VncAuth
        s.write_all(&[0; 16]).await.unwrap(); // challenge
        let mut response = [0; 16];
        s.read_exact(&mut response).await.unwrap();
        s.write_all(&1_u32.to_be_bytes()).await.unwrap(); // Failed
        std::future::pending::<()>().await;
    })
    .await;
    assert!(matches!(result, Err(VncError::WrongPassword)), "{result:?}");
}

#[tokio::test]
async fn invalid_caller_pixel_format_is_rejected_at_build() {
    let (client_io, _server) = tokio::io::duplex(64);
    let mut pf = PixelFormat::rgba();
    pf.red_shift = 30;
    let built = VncConnector::<_, Password>::new(client_io)
        .add_encoding(VncEncoding::Raw)
        .set_pixel_format(pf)
        .build();
    assert!(matches!(built, Err(VncError::WrongPixelFormat)));
}

// ------------------------------------------------------ connection.rs ---

/// ServerInit for a `w` x `h` desktop with the given (server) pixel format.
fn server_init(w: u16, h: u16, pf: PixelFormat) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend(<PixelFormat as Into<Vec<u8>>>::into(pf));
    v.extend_from_slice(&4_u32.to_be_bytes());
    v.extend_from_slice(b"test");
    v
}

/// Connect a client over RFB 3.8 / None against a server end that we keep.
async fn connected_client(
    init: Vec<u8>,
    pf: Option<PixelFormat>,
    pipe: usize,
) -> (Result<super::VncClient, VncError>, DuplexStream) {
    let (client_io, mut s) = tokio::io::duplex(pipe);
    let mut connector = VncConnector::<_, Password>::new(client_io).add_encoding(VncEncoding::Raw);
    if let Some(pf) = pf {
        connector = connector.set_pixel_format(pf);
    }
    let connector = connector.build().unwrap();
    let client = tokio::spawn(async move { connector.try_start().await?.finish() });
    s.write_all(b"RFB 003.008\n").await.unwrap();
    let mut buf = [0; 12];
    s.read_exact(&mut buf).await.unwrap();
    s.write_all(&[1, 1]).await.unwrap();
    let mut one = [0; 1];
    s.read_exact(&mut one).await.unwrap(); // chosen type
    s.write_all(&0_u32.to_be_bytes()).await.unwrap(); // SecurityResult OK
    s.read_exact(&mut one).await.unwrap(); // shared flag
    s.write_all(&init).await.unwrap();
    let client = tokio::time::timeout(Duration::from_secs(5), client)
        .await
        .expect("connect must not hang")
        .unwrap();
    (client, s)
}

#[tokio::test]
async fn adopted_server_pixel_format_is_validated() {
    let mut bad = PixelFormat::rgba();
    bad.green_shift = 4; // green overlaps red
    let (client, _s) = connected_client(server_init(64, 64, bad), None, 4096).await;
    assert!(matches!(client, Err(VncError::WrongPixelFormat)));
    // A caller-chosen format replaces the server's, so it is not held against it.
    let (client, _s) =
        connected_client(server_init(64, 64, bad), Some(PixelFormat::rgba()), 4096).await;
    assert!(client.is_ok());
}

#[tokio::test]
async fn oversize_server_init_framebuffer_is_rejected() {
    let (client, _s) =
        connected_client(server_init(9000, 64, PixelFormat::rgba()), None, 4096).await;
    assert!(
        matches!(client, Err(VncError::Protocol(_))),
        "{:?}",
        client.err()
    );
}

#[tokio::test]
async fn close_is_not_blocked_by_input_backpressure() {
    // A server that never reads: the tiny pipe fills, the connection task
    // blocks writing, the input queue fills, and `input()` waits for capacity.
    // Upstream held the client mutex across that wait, so `close()` (and
    // `poll_event`) deadlocked behind it.
    let (client, _server) = connected_client(
        server_init(64, 64, PixelFormat::rgba()),
        Some(PixelFormat::rgba()),
        64,
    )
    .await;
    let client = client.unwrap();
    let spammer = {
        let client = client.clone();
        tokio::spawn(async move {
            loop {
                let text = X11Event::CopyText("x".repeat(512));
                if client.input(text).await.is_err() {
                    break;
                }
            }
        })
    };
    // Let the pipe and the input queue fill up.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !spammer.is_finished(),
        "input should be blocked on backpressure"
    );
    tokio::time::timeout(Duration::from_secs(5), client.close())
        .await
        .expect("close must not wait behind a blocked input")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), client.poll_event())
        .await
        .expect("poll_event must not wait behind a blocked input")
        .ok();
    spammer.abort();
}
