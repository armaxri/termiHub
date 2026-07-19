//! CLIPRDR (MS-RDPECLIP) clipboard bridging for the RDP sidecar (#1756).
//!
//! IronRDP's clipboard channel ([`ironrdp::cliprdr::Cliprdr`]) is a static
//! virtual channel driven by a [`CliprdrBackend`] the integrator supplies. The
//! backend's methods are called **synchronously** from inside
//! [`ActiveStage::process`](ironrdp::session::ActiveStage) while a server
//! CLIPRDR PDU is being decoded — at which point the [`Cliprdr`] channel is
//! mutably borrowed, so the backend cannot call back into it (initiate a paste,
//! submit data). Instead the backend records what needs to happen as a
//! [`ClipboardEvent`] on a channel; the driver loop drains those events *after*
//! `process` returns, when it again owns `&mut ActiveStage`, and performs the
//! matching [`Cliprdr`] call (see `rdp.rs`).
//!
//! Scope is **text, both ways** (the issue's "text both ways"): CF_UNICODETEXT
//! preferred, CF_TEXT as a fallback. File-transfer and locking callbacks are
//! implemented as no-ops — we never advertise file formats or negotiate the
//! locking capability, so the server never exercises them.
//!
//! [`Cliprdr`]: ironrdp::cliprdr::Cliprdr
//! [`CliprdrBackend`]: ironrdp::cliprdr::backend::CliprdrBackend

use std::sync::mpsc::Sender;

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
};
use tracing::{debug, trace, warn};

/// An action the CLIPRDR backend needs the driver loop to perform on the
/// [`Cliprdr`](ironrdp::cliprdr::Cliprdr) channel once it owns `&mut ActiveStage`
/// again (the backend is called while that channel is borrowed and cannot call
/// back into it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardEvent {
    /// The channel finished initializing (or the remote asked us to re-advertise):
    /// send our local clipboard's format list to the server.
    AdvertiseLocal,
    /// The remote copied something; fetch its data in this (text) format so it can
    /// be mirrored to the host clipboard.
    InitiatePaste(ClipboardFormatId),
    /// Text received from the remote clipboard, ready to hand to the host over IPC.
    RemoteText(String),
    /// The remote wants our local clipboard data in this format; respond with a
    /// `FormatDataResponse` built from the host-provided text.
    ProvideData(ClipboardFormatId),
}

/// Pick the best text format the remote advertised: prefer Unicode, fall back to
/// ANSI. Returns `None` when the remote offered no text format (e.g. a bitmap or
/// file copy), which this text-only bridge ignores.
pub fn preferred_text_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    if formats.iter().any(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT) {
        Some(ClipboardFormatId::CF_UNICODETEXT)
    } else if formats.iter().any(|f| f.id() == ClipboardFormatId::CF_TEXT) {
        Some(ClipboardFormatId::CF_TEXT)
    } else {
        None
    }
}

/// The text formats we advertise for a non-empty local clipboard. An empty local
/// clipboard advertises nothing (an empty format list), which still completes the
/// CLIPRDR initialization handshake so the remote→local direction works.
pub fn local_text_formats(local: Option<&str>) -> Vec<ClipboardFormat> {
    match local {
        Some(text) if !text.is_empty() => vec![
            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
            ClipboardFormat::new(ClipboardFormatId::CF_TEXT),
        ],
        _ => Vec::new(),
    }
}

/// Build the response to a server `FormatDataRequest` for our local clipboard.
/// Encodes the host text as Unicode or ANSI per the requested format; a request
/// for a non-text format, or with no local text available, yields an error
/// response (`is_error`), which the spec allows.
pub fn build_format_data_response(
    format: ClipboardFormatId,
    local: Option<&str>,
) -> FormatDataResponse<'static> {
    match (format, local) {
        (ClipboardFormatId::CF_UNICODETEXT, Some(text)) => {
            FormatDataResponse::new_unicode_string(text)
        }
        (ClipboardFormatId::CF_TEXT, Some(text)) => FormatDataResponse::new_string(text),
        _ => FormatDataResponse::new_error(),
    }
}

/// Decode remote clipboard text from a `FormatDataResponse`, given the format we
/// requested. Returns `None` for an error response or a non-text format.
pub fn decode_clipboard_text(
    format: ClipboardFormatId,
    response: &FormatDataResponse<'_>,
) -> Option<String> {
    if response.is_error() {
        return None;
    }
    match format {
        ClipboardFormatId::CF_UNICODETEXT => response.to_unicode_string().ok(),
        ClipboardFormatId::CF_TEXT => response.to_string().ok(),
        _ => None,
    }
}

/// The sidecar's [`CliprdrBackend`]: it owns no OS clipboard (there is none in a
/// headless sidecar); it just translates CLIPRDR callbacks into
/// [`ClipboardEvent`]s the driver forwards over IPC to the host's real clipboard.
#[derive(Debug)]
pub struct SidecarClipboardBackend {
    /// Events flow to the driver loop over this channel.
    tx: Sender<ClipboardEvent>,
    /// A temporary directory path advertised to the server (required by the
    /// protocol even though this text-only bridge never transfers files).
    temp_dir: String,
    /// The format of the most recent paste we initiated, so the eventual
    /// `on_format_data_response` knows how to decode the bytes.
    pending_paste_format: Option<ClipboardFormatId>,
}

impl SidecarClipboardBackend {
    /// Create the backend and the receiver the driver drains. The backend is
    /// handed to [`Cliprdr::new`](ironrdp::cliprdr::Cliprdr::new); the receiver
    /// stays with the driver loop.
    pub fn new() -> (Self, std::sync::mpsc::Receiver<ClipboardEvent>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
        (
            Self {
                tx,
                temp_dir,
                pending_paste_format: None,
            },
            rx,
        )
    }

    fn emit(&self, event: ClipboardEvent) {
        if self.tx.send(event).is_err() {
            debug!("clipboard event receiver dropped; sidecar shutting down");
        }
    }
}

impl CliprdrBackend for SidecarClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        // Text-only: we use the standard short format IDs (CF_UNICODETEXT /
        // CF_TEXT) and negotiate neither long format names nor file/lock
        // capabilities, so no flags are required.
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {
        debug!("cliprdr channel ready");
    }

    fn on_request_format_list(&mut self) {
        // The initialization sequence needs us to send a format list; the driver
        // advertises whatever the host clipboard currently holds (possibly empty).
        self.emit(ClipboardEvent::AdvertiseLocal);
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        trace!(?capabilities, "cliprdr negotiated capabilities");
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        match preferred_text_format(available_formats) {
            Some(format) => {
                self.pending_paste_format = Some(format);
                self.emit(ClipboardEvent::InitiatePaste(format));
            }
            None => trace!("remote clipboard offered no text format; ignoring"),
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        self.emit(ClipboardEvent::ProvideData(request.format));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        let Some(format) = self.pending_paste_format.take() else {
            trace!("format data response with no pending paste; ignoring");
            return;
        };
        match decode_clipboard_text(format, &response) {
            Some(text) => self.emit(ClipboardEvent::RemoteText(text)),
            None => debug!("remote clipboard text unavailable or undecodable"),
        }
    }

    // --- File transfer / locking: unused by this text-only bridge. ---
    // We advertise no file formats and negotiate no locking capability, so a
    // conforming server never drives these; keep them as safe no-ops.

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {
        warn!("cliprdr file contents request ignored (text-only bridge)");
    }

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {
        warn!("cliprdr file contents response ignored (text-only bridge)");
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(id: ClipboardFormatId) -> ClipboardFormat {
        ClipboardFormat::new(id)
    }

    #[test]
    fn prefers_unicode_over_ansi() {
        let formats = [
            text(ClipboardFormatId::CF_TEXT),
            text(ClipboardFormatId::CF_UNICODETEXT),
        ];
        assert_eq!(
            preferred_text_format(&formats),
            Some(ClipboardFormatId::CF_UNICODETEXT)
        );
    }

    #[test]
    fn falls_back_to_ansi_text() {
        let formats = [text(ClipboardFormatId::CF_TEXT)];
        assert_eq!(
            preferred_text_format(&formats),
            Some(ClipboardFormatId::CF_TEXT)
        );
    }

    #[test]
    fn ignores_non_text_formats() {
        // CF_BITMAP (2) and a random custom id — neither is text.
        let formats = [text(ClipboardFormatId(2)), text(ClipboardFormatId(0xC001))];
        assert_eq!(preferred_text_format(&formats), None);
    }

    #[test]
    fn empty_local_clipboard_advertises_nothing() {
        assert!(local_text_formats(None).is_empty());
        assert!(local_text_formats(Some("")).is_empty());
    }

    #[test]
    fn non_empty_local_clipboard_advertises_both_text_formats() {
        let formats = local_text_formats(Some("hello"));
        let ids: Vec<_> = formats.iter().map(|f| f.id()).collect();
        assert_eq!(
            ids,
            vec![
                ClipboardFormatId::CF_UNICODETEXT,
                ClipboardFormatId::CF_TEXT
            ]
        );
    }

    #[test]
    fn unicode_text_round_trips_through_response() {
        // Build the response we'd send to the server, then decode it the way the
        // remote→local path would — the two text codecs must agree. Non-ASCII
        // exercises the UTF-16 path.
        let original = "héllo wörld ☺";
        let response = build_format_data_response(
            ClipboardFormatId::CF_UNICODETEXT,
            Some(original),
        );
        let decoded =
            decode_clipboard_text(ClipboardFormatId::CF_UNICODETEXT, &response).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn ansi_text_round_trips_through_response() {
        let original = "plain ascii";
        let response =
            build_format_data_response(ClipboardFormatId::CF_TEXT, Some(original));
        let decoded = decode_clipboard_text(ClipboardFormatId::CF_TEXT, &response).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn missing_local_text_yields_error_response() {
        let response =
            build_format_data_response(ClipboardFormatId::CF_UNICODETEXT, None);
        assert!(response.is_error());
        assert_eq!(
            decode_clipboard_text(ClipboardFormatId::CF_UNICODETEXT, &response),
            None
        );
    }

    #[test]
    fn error_response_decodes_to_none() {
        let response = FormatDataResponse::new_error();
        assert_eq!(
            decode_clipboard_text(ClipboardFormatId::CF_UNICODETEXT, &response),
            None
        );
    }

    #[test]
    fn backend_emits_paste_on_remote_text_copy() {
        let (mut backend, rx) = SidecarClipboardBackend::new();
        backend.on_remote_copy(&[text(ClipboardFormatId::CF_UNICODETEXT)]);
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::InitiatePaste(ClipboardFormatId::CF_UNICODETEXT))
        );
    }

    #[test]
    fn backend_decodes_response_using_pending_format() {
        let (mut backend, rx) = SidecarClipboardBackend::new();
        // Simulate the full remote→local sequence: remote copy → paste → data.
        backend.on_remote_copy(&[text(ClipboardFormatId::CF_UNICODETEXT)]);
        let _ = rx.try_recv(); // consume the InitiatePaste
        let response =
            build_format_data_response(ClipboardFormatId::CF_UNICODETEXT, Some("copied"));
        backend.on_format_data_response(response);
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::RemoteText("copied".to_string()))
        );
    }

    #[test]
    fn backend_requests_advertise_on_format_list_request() {
        let (mut backend, rx) = SidecarClipboardBackend::new();
        backend.on_request_format_list();
        assert_eq!(rx.try_recv(), Ok(ClipboardEvent::AdvertiseLocal));
    }

    #[test]
    fn backend_forwards_server_data_request() {
        let (mut backend, rx) = SidecarClipboardBackend::new();
        backend.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_UNICODETEXT,
        });
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::ProvideData(ClipboardFormatId::CF_UNICODETEXT))
        );
    }
}
