//! A server that does not answer, or asks too early, does not hang or end the
//! session (#6030).

use std::time::Duration;

use super::tests::{test_active_stage, test_connector_config, TEST_IO_CHANNEL, TEST_USER_CHANNEL};
use super::*;
use ironrdp_cliprdr::pdu::ClipboardFormatId;

fn stage_with_clipboard() -> (
    ActiveStage,
    std::sync::mpsc::Receiver<ClipboardEvent>,
    std::sync::mpsc::Sender<ClipboardEvent>,
) {
    let (backend, rx) = SidecarClipboardBackend::new(None, false);
    let tx = backend.event_sender();
    let mut channels = ironrdp_svc::StaticChannelSet::new();
    channels.insert(CliprdrClient::new(Box::new(backend)));
    let stage = ActiveStageBuilder {
        static_channels: channels,
        user_channel_id: TEST_USER_CHANNEL,
        io_channel_id: TEST_IO_CHANNEL,
        message_channel_id: None,
        share_id: 0x0001_03EA,
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: true,
    }
    .build();
    (stage, rx, tx)
}

/// The server asks for clipboard data, or offers some, before the clipboard
/// channel has finished its start.
#[tokio::test]
async fn an_early_clipboard_request_does_not_end_the_session() {
    use tokio::io::AsyncReadExt;

    let (mut stage, rx, tx) = stage_with_clipboard();
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    let mut transport = TokioFramed::new(client);
    let (mut ipc_out, _host) = tokio::io::duplex(64 * 1024);
    for event in [
        ClipboardEvent::ProvideData(ClipboardFormatId::CF_UNICODETEXT),
        ClipboardEvent::InitiatePaste(ClipboardFormatId::CF_UNICODETEXT),
        ClipboardEvent::ProvideFileContents(ironrdp_cliprdr::pdu::FileContentsResponse::new_error(
            1,
        )),
    ] {
        tx.send(event).expect("queued");
    }
    let clipboard = LocalClipboard::Text("text".to_string());
    drain_clipboard_events(&rx, &mut stage, &mut transport, &mut ipc_out, &clipboard)
        .await
        .expect("the session goes on");

    // The data is provided once the channel is ready.
    let cliprdr = stage
        .get_svc_processor_mut::<CliprdrClient>()
        .expect("clipboard channel");
    let backend = cliprdr
        .downcast_backend_mut::<SidecarClipboardBackend>()
        .expect("backend");
    ironrdp_cliprdr::backend::CliprdrBackend::on_ready(backend);
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::ProvideData(
            ClipboardFormatId::CF_UNICODETEXT
        ))
    );
    assert!(rx.try_recv().is_err(), "asked once, answered once");

    drop(transport);
    let mut sent = Vec::new();
    server.read_to_end(&mut sent).await.expect("read");
    assert!(
        sent.is_empty(),
        "nothing goes out on a channel that is not ready"
    );
}

/// The server announces a new desktop size and then says nothing.
#[tokio::test]
async fn a_reactivation_the_server_never_finishes_ends() {
    let (client, _server) = tokio::io::duplex(64 * 1024);
    let mut stage = test_active_stage(0x0001_03EA);
    let mut image = DecodedImage::new(PixelFormat::RgbA32, 1280, 800);
    let reactivated = tokio::time::timeout(
        Duration::from_secs(10),
        reactivate_within(
            Duration::from_millis(100),
            TokioFramed::new(client),
            test_connector_config(),
            &mut stage,
            &mut image,
            TEST_IO_CHANNEL,
            TEST_USER_CHANNEL,
        ),
    )
    .await
    .expect("it ends by itself");
    let error = match reactivated {
        Ok(_) => panic!("nothing was answered"),
        Err(e) => format!("{e:#}"),
    };
    assert!(error.contains("did not finish"), "{error}");
}
