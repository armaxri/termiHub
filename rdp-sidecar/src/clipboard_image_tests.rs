//! Image-clipboard tests for the CLIPRDR backend (PROD-021).

use super::*;
use std::sync::mpsc::Receiver;

fn fmt(id: ClipboardFormatId) -> ClipboardFormat {
    ClipboardFormat::new(id)
}

fn backend() -> (SidecarClipboardBackend, Receiver<ClipboardEvent>) {
    SidecarClipboardBackend::with_host_clip_reader(None, false, Vec::new)
}

fn sample_image() -> ClipboardImage {
    ClipboardImage::new(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 255]).unwrap()
}

fn dib_response(image: &ClipboardImage) -> FormatDataResponse<'static> {
    FormatDataResponse::new_data(image_to_dib(image))
}

#[test]
fn prefers_cf_dib_over_dibv5_and_ignores_text() {
    assert_eq!(
        preferred_image_format(&[
            fmt(ClipboardFormatId::CF_DIBV5),
            fmt(ClipboardFormatId::CF_DIB)
        ]),
        Some(ClipboardFormatId::CF_DIB)
    );
    assert_eq!(
        preferred_image_format(&[fmt(ClipboardFormatId::CF_DIBV5)]),
        Some(ClipboardFormatId::CF_DIBV5)
    );
    assert_eq!(
        preferred_image_format(&[fmt(ClipboardFormatId::CF_UNICODETEXT)]),
        None
    );
}

#[test]
fn remote_image_copy_is_pasted_and_surfaced_as_rgba() {
    let (mut backend, rx) = backend();
    backend.on_remote_copy(&[
        fmt(ClipboardFormatId::CF_BITMAP),
        fmt(ClipboardFormatId::CF_DIB),
    ]);
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::InitiatePaste(ClipboardFormatId::CF_DIB))
    );
    backend.on_format_data_response(dib_response(&sample_image()));
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::RemoteImage(sample_image()))
    );
    assert!(rx.try_recv().is_err());
}

#[test]
fn text_and_image_copy_fetches_text_then_image() {
    let (mut backend, rx) = backend();
    backend.on_remote_copy(&[
        fmt(ClipboardFormatId::CF_UNICODETEXT),
        fmt(ClipboardFormatId::CF_DIB),
    ]);
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::InitiatePaste(
            ClipboardFormatId::CF_UNICODETEXT
        ))
    );
    backend.on_format_data_response(FormatDataResponse::new_unicode_string("caption"));
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::RemoteText("caption".to_string()))
    );
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::InitiatePaste(ClipboardFormatId::CF_DIB))
    );
    backend.on_format_data_response(dib_response(&sample_image()));
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::RemoteImage(sample_image()))
    );
}

#[test]
fn a_newer_copy_cancels_a_queued_image_paste() {
    let (mut backend, rx) = backend();
    backend.on_remote_copy(&[
        fmt(ClipboardFormatId::CF_UNICODETEXT),
        fmt(ClipboardFormatId::CF_DIB),
    ]);
    let _ = rx.try_recv();
    // Before the text arrives, the remote copies plain text again.
    backend.on_remote_copy(&[fmt(ClipboardFormatId::CF_UNICODETEXT)]);
    let _ = rx.try_recv();
    backend.on_format_data_response(FormatDataResponse::new_unicode_string("newer"));
    assert_eq!(
        rx.try_recv(),
        Ok(ClipboardEvent::RemoteText("newer".to_string()))
    );
    assert!(rx.try_recv().is_err(), "no stale image paste may follow");
}

#[test]
fn an_oversize_remote_image_is_rejected_without_an_event() {
    let (mut backend, rx) = backend();
    backend.on_remote_copy(&[fmt(ClipboardFormatId::CF_DIB)]);
    let _ = rx.try_recv();
    // A header claiming 8192×8192 (256 MiB of RGBA) — over the byte cap.
    let mut dib = Vec::new();
    dib.extend_from_slice(&40u32.to_le_bytes());
    dib.extend_from_slice(&8192i32.to_le_bytes());
    dib.extend_from_slice(&8192i32.to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&[0; 24]);
    backend.on_format_data_response(FormatDataResponse::new_data(dib));
    assert!(rx.try_recv().is_err());
    assert!(backend.pending_image_format.is_none());
}

#[test]
fn an_error_response_for_an_image_yields_nothing() {
    let (mut backend, rx) = backend();
    backend.on_remote_copy(&[fmt(ClipboardFormatId::CF_DIB)]);
    let _ = rx.try_recv();
    backend.on_format_data_response(FormatDataResponse::new_error());
    assert!(rx.try_recv().is_err());
}

#[test]
fn local_image_advertises_and_serves_cf_dib_only() {
    let local = LocalClipboard::image(&sample_image());
    let ids: Vec<_> = local.formats().iter().map(|f| f.id()).collect();
    assert_eq!(ids, vec![ClipboardFormatId::CF_DIB]);
    let served = local.response(ClipboardFormatId::CF_DIB);
    assert!(!served.is_error());
    assert_eq!(dib_to_image(served.data()).unwrap(), sample_image());
    assert!(local.response(ClipboardFormatId::CF_UNICODETEXT).is_error());
}

#[test]
fn local_text_and_empty_clipboard_keep_the_text_behavior() {
    assert!(LocalClipboard::Empty.formats().is_empty());
    assert!(LocalClipboard::Empty
        .response(ClipboardFormatId::CF_UNICODETEXT)
        .is_error());
    let text = LocalClipboard::Text("hi".to_string());
    assert_eq!(text.formats().len(), 2);
    assert!(text.response(ClipboardFormatId::CF_DIB).is_error());
    assert_eq!(
        text.response(ClipboardFormatId::CF_UNICODETEXT)
            .to_unicode_string()
            .unwrap(),
        "hi"
    );
}
