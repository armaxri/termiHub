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
//! Text bridging is **both ways** (#1756): CF_UNICODETEXT preferred, CF_TEXT as
//! a fallback.
//!
//! ## File transfer (#1765) — receiving, sandboxed
//!
//! When the user opts into clipboard file transfer, the backend advertises the
//! stream-file-clip capability and long format names so the server offers the
//! `FileGroupDescriptorW` format when the remote copies files. On a remote file
//! copy the backend fetches the file list and downloads each file's bytes into
//! the **one opted-in shared folder** ([`RdpConfig::clipboard_download_dir`]) —
//! the same folder drive redirection (#1757) already exposes read-write, so this
//! grants the remote no new local access. Every destination path is validated
//! through the shared [`crate::sandbox`] choke point; Windows device names are
//! rejected; oversized files are skipped.
//!
//! Because IronRDP's `CliprdrBackend` methods run while the [`Cliprdr`] channel
//! is borrowed, downloads are driven the same way as text: the backend records
//! the next channel action as a [`ClipboardEvent`], and the driver performs it
//! (`initiate_paste` / `request_file_contents`) once it owns the active stage.
//!
//! **Serving local files to the remote** (local→remote paste) and bridging the
//! host OS clipboard's native file list are deferred follow-ups; this bridge
//! only ever *receives* files, so a view-only session — which must never push
//! local data to the remote — is unaffected.
//!
//! [`Cliprdr`]: ironrdp::cliprdr::Cliprdr
//! [`CliprdrBackend`]: ironrdp::cliprdr::backend::CliprdrBackend
//! [`RdpConfig::clipboard_download_dir`]: termihub_core::backends::rdp_sidecar::config::RdpConfig::clipboard_download_dir

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::mpsc::Sender;

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::is_windows_device_name;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::AsAny;
use tracing::{debug, trace, warn};

/// Cap on a single clipboard-received file. A whole file is requested in one
/// range (position 0, size N), so this bounds the sidecar's memory for one
/// transfer; larger files are skipped (chunked streaming is a follow-up). 32 MiB
/// covers ordinary documents while refusing a hostile multi-gigabyte advertise.
const MAX_CLIPBOARD_FILE_BYTES: u64 = 32 * 1024 * 1024;

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
    /// Ask the server for a chunk (size or byte range) of a file the remote
    /// copied, as part of downloading it into the shared folder (#1765). The
    /// driver calls [`Cliprdr::request_file_contents`](ironrdp::cliprdr::Cliprdr::request_file_contents).
    RequestFileContents(FileContentsRequest),
}

/// Pick the best text format the remote advertised: prefer Unicode, fall back to
/// ANSI. Returns `None` when the remote offered no text format (e.g. a bitmap or
/// file copy), which this text-only bridge ignores.
pub fn preferred_text_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    if formats
        .iter()
        .any(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT)
    {
        Some(ClipboardFormatId::CF_UNICODETEXT)
    } else if formats.iter().any(|f| f.id() == ClipboardFormatId::CF_TEXT) {
        Some(ClipboardFormatId::CF_TEXT)
    } else {
        None
    }
}

/// Find the remote's `FileGroupDescriptorW` format (the file-list format) by its
/// long name, returning its (remote-assigned) format id. `None` when the remote
/// offered no file list — e.g. a text or image copy.
pub fn file_list_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    formats
        .iter()
        .find(|f| {
            f.name()
                .map(|n| n.value() == ClipboardFormatName::FILE_LIST.value())
                .unwrap_or(false)
        })
        .map(|f| f.id())
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

/// A file from the remote's copied file list still to be downloaded into the
/// shared folder, resolved to its sandboxed destination (#1765).
#[derive(Debug, Clone)]
struct PlannedDownload {
    /// Index of this file in the remote file list (what a `FileContentsRequest`
    /// references).
    index: i32,
    /// Sandboxed, deduplicated destination path inside the download folder.
    dest: PathBuf,
    /// File size from the descriptor, when the remote advertised it.
    size: Option<u64>,
}

/// Which chunk of a file the in-flight [`FileContentsRequest`] is fetching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadPhase {
    /// A `SIZE` request (the descriptor omitted the size); the response carries
    /// the file's length so we can then request its bytes.
    Size,
    /// A `RANGE` request for the file's bytes; the response is written to disk.
    Range,
}

/// The single in-flight file download, keyed by the stream id we assigned.
#[derive(Debug, Clone)]
struct ActiveDownload {
    stream_id: u32,
    index: i32,
    dest: PathBuf,
    phase: DownloadPhase,
}

/// The sidecar's [`CliprdrBackend`]: it owns no OS clipboard (there is none in a
/// headless sidecar); it translates CLIPRDR callbacks into [`ClipboardEvent`]s
/// the driver forwards over IPC (text) or acts on (file downloads).
#[derive(Debug)]
pub struct SidecarClipboardBackend {
    /// Events flow to the driver loop over this channel.
    tx: Sender<ClipboardEvent>,
    /// A temporary directory path advertised to the server (required by the
    /// protocol).
    temp_dir: String,
    /// The format of the most recent *text* paste we initiated, so the eventual
    /// `on_format_data_response` knows how to decode the bytes.
    pending_paste_format: Option<ClipboardFormatId>,
    /// Destination folder for files received over CLIPRDR file transfer, or
    /// `None` when the feature is disabled. Enabling it flips the advertised
    /// capabilities to include stream-file-clip + long format names (#1765).
    download_dir: Option<PathBuf>,
    /// Files from the current remote copy still awaiting download.
    download_queue: VecDeque<PlannedDownload>,
    /// The single download currently in flight (one at a time keeps the memory
    /// bound and the stream-id bookkeeping trivial).
    active_download: Option<ActiveDownload>,
    /// Monotonic stream-id allocator for file-contents requests.
    next_stream_id: u32,
}

impl SidecarClipboardBackend {
    /// Create the backend and the receiver the driver drains. `download_dir` is
    /// the (already sandboxed, canonical) folder received files land in, or
    /// `None` to keep the bridge text-only. The backend is handed to
    /// [`Cliprdr::new`](ironrdp::cliprdr::Cliprdr::new); the receiver stays with
    /// the driver loop.
    pub fn new(download_dir: Option<PathBuf>) -> (Self, std::sync::mpsc::Receiver<ClipboardEvent>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let temp_dir = std::env::temp_dir().to_string_lossy().into_owned();
        (
            Self {
                tx,
                temp_dir,
                pending_paste_format: None,
                download_dir,
                download_queue: VecDeque::new(),
                active_download: None,
                next_stream_id: 0,
            },
            rx,
        )
    }

    fn emit(&self, event: ClipboardEvent) {
        if self.tx.send(event).is_err() {
            debug!("clipboard event receiver dropped; sidecar shutting down");
        }
    }

    /// Allocate the next non-zero stream id for a file-contents request.
    fn allocate_stream_id(&mut self) -> u32 {
        self.next_stream_id = self.next_stream_id.wrapping_add(1);
        if self.next_stream_id == 0 {
            self.next_stream_id = 1;
        }
        self.next_stream_id
    }

    /// Plan the download of a remote file list into the download folder: skip
    /// directories, empty/rejected names and Windows device names; flatten to
    /// basenames within the one folder, deduplicating collisions. Returns the
    /// queue of files to fetch.
    fn plan_downloads(&self, files: &[FileDescriptor]) -> VecDeque<PlannedDownload> {
        let Some(dir) = self.download_dir.as_ref() else {
            return VecDeque::new();
        };
        let mut used: HashSet<String> = HashSet::new();
        let mut queue = VecDeque::new();
        for (index, file) in files.iter().enumerate() {
            if file
                .attributes
                .map(|a| a.contains(ClipboardFileAttributes::DIRECTORY))
                .unwrap_or(false)
            {
                // Directories carry no bytes to request; flattening drops the
                // tree structure (a follow-up preserves it).
                continue;
            }
            // IronRDP already sanitised the name to a basename, but re-derive it
            // defensively and reject anything unsafe to write.
            let base = file.name.rsplit(['\\', '/']).next().unwrap_or(&file.name);
            if base.is_empty() || base == "." || base == ".." {
                warn!(name = %file.name, "skipping clipboard file with unusable name");
                continue;
            }
            if is_windows_device_name(base) {
                warn!(name = %base, "skipping clipboard file with a reserved device name");
                continue;
            }
            let unique = unique_name(&mut used, base);
            let Some(dest) = crate::sandbox::resolve_in_root(dir, &unique) else {
                warn!(name = %unique, "clipboard file rejected by sandbox");
                continue;
            };
            queue.push_back(PlannedDownload {
                index: index as i32,
                dest,
                size: file.file_size,
            });
        }
        queue
    }

    /// Pop the next planned file and either fetch it (emitting a
    /// [`ClipboardEvent::RequestFileContents`]) or, for a known-empty file,
    /// create it immediately and move on. Files larger than
    /// [`MAX_CLIPBOARD_FILE_BYTES`] are skipped.
    fn start_next_download(&mut self) {
        self.active_download = None;
        while let Some(planned) = self.download_queue.pop_front() {
            match planned.size {
                Some(0) => {
                    // Empty file: no range to request (a zero-length RANGE is
                    // rejected by the protocol), so just create it.
                    if let Err(e) = std::fs::write(&planned.dest, []) {
                        warn!(error = %e, path = %planned.dest.display(), "failed to create empty clipboard file");
                    } else {
                        debug!(path = %planned.dest.display(), "received empty clipboard file");
                    }
                    continue;
                }
                Some(size) if size > MAX_CLIPBOARD_FILE_BYTES => {
                    warn!(
                        size,
                        max = MAX_CLIPBOARD_FILE_BYTES,
                        name = %planned.dest.display(),
                        "skipping oversized clipboard file"
                    );
                    continue;
                }
                Some(size) => {
                    // Size known: fetch the whole file in one range.
                    let stream_id = self.allocate_stream_id();
                    self.active_download = Some(ActiveDownload {
                        stream_id,
                        index: planned.index,
                        dest: planned.dest,
                        phase: DownloadPhase::Range,
                    });
                    self.emit(ClipboardEvent::RequestFileContents(range_request(
                        stream_id,
                        planned.index,
                        size,
                    )));
                    return;
                }
                None => {
                    // Size unknown: ask for it first, then the bytes.
                    let stream_id = self.allocate_stream_id();
                    self.active_download = Some(ActiveDownload {
                        stream_id,
                        index: planned.index,
                        dest: planned.dest,
                        phase: DownloadPhase::Size,
                    });
                    self.emit(ClipboardEvent::RequestFileContents(size_request(
                        stream_id,
                        planned.index,
                    )));
                    return;
                }
            }
        }
    }
}

/// Build a deduplicated basename: `file.txt`, then `file (1).txt`, … keeping the
/// extension. Records the chosen name in `used`.
fn unique_name(used: &mut HashSet<String>, base: &str) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (base, None),
    };
    for n in 1.. {
        let candidate = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("the counter is unbounded")
}

/// A `SIZE` file-contents request (per MS-RDPECLIP 2.2.5.3: position 0,
/// requested_size 8).
fn size_request(stream_id: u32, index: i32) -> FileContentsRequest {
    FileContentsRequest {
        stream_id,
        index,
        flags: FileContentsFlags::SIZE,
        position: 0,
        requested_size: 8,
        data_id: None,
    }
}

/// A `RANGE` request for the whole file `[0, size)` (size is `<= MAX_CLIPBOARD_FILE_BYTES`,
/// so it fits in the `u32` `requested_size`).
fn range_request(stream_id: u32, index: i32, size: u64) -> FileContentsRequest {
    FileContentsRequest {
        stream_id,
        index,
        flags: FileContentsFlags::RANGE,
        position: 0,
        requested_size: size as u32,
        data_id: None,
    }
}

impl AsAny for SidecarClipboardBackend {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl CliprdrBackend for SidecarClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        if self.download_dir.is_some() {
            // File receiving is on: negotiate stream-file-clip so the server
            // offers file formats and services our file-contents requests, and
            // long format names so the `FileGroupDescriptorW` format's name is
            // exchanged (it is a named format, not a standard short id).
            ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
                | ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
        } else {
            // Text-only: standard short ids (CF_UNICODETEXT / CF_TEXT) need no
            // capability flags.
            ClipboardGeneralCapabilityFlags::empty()
        }
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
        // A remote file copy takes precedence over text when file receiving is
        // enabled: initiate a paste for the file list, which the channel routes
        // to `on_remote_file_list` (not `on_format_data_response`).
        if self.download_dir.is_some() {
            if let Some(format) = file_list_format(available_formats) {
                // Reset any leftover download state from a previous copy.
                self.download_queue.clear();
                self.active_download = None;
                self.emit(ClipboardEvent::InitiatePaste(format));
                return;
            }
        }
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

    fn on_remote_file_list(&mut self, files: &[FileDescriptor], _clip_data_id: Option<u32>) {
        if self.download_dir.is_none() {
            return;
        }
        self.download_queue = self.plan_downloads(files);
        debug!(
            count = self.download_queue.len(),
            "planned clipboard file download(s) into the shared folder"
        );
        self.start_next_download();
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        // Serving local files to the remote is a deferred follow-up: we never
        // advertise a local file list, so a conforming server never asks. If one
        // does, the channel already sent an error for an unknown list; nothing to
        // do here.
        trace!(
            stream_id = request.stream_id,
            "ignoring file-contents request (receive-only bridge)"
        );
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let Some(active) = self.active_download.as_ref() else {
            trace!("file-contents response with no active download; ignoring");
            return;
        };
        if active.stream_id != response.stream_id() {
            warn!(
                expected = active.stream_id,
                got = response.stream_id(),
                "file-contents response stream id mismatch; ignoring"
            );
            return;
        }
        let active = active.clone();

        if response.is_error() {
            warn!(path = %active.dest.display(), "remote returned an error for a clipboard file; skipping");
            self.start_next_download();
            return;
        }

        match active.phase {
            DownloadPhase::Size => match response.data_as_size() {
                Ok(0) => {
                    if let Err(e) = std::fs::write(&active.dest, []) {
                        warn!(error = %e, path = %active.dest.display(), "failed to create empty clipboard file");
                    }
                    self.start_next_download();
                }
                Ok(size) if size > MAX_CLIPBOARD_FILE_BYTES => {
                    warn!(
                        size,
                        max = MAX_CLIPBOARD_FILE_BYTES,
                        "skipping oversized clipboard file"
                    );
                    self.start_next_download();
                }
                Ok(size) => {
                    // Size resolved: request the bytes on the same file.
                    let stream_id = self.allocate_stream_id();
                    self.active_download = Some(ActiveDownload {
                        stream_id,
                        index: active.index,
                        dest: active.dest,
                        phase: DownloadPhase::Range,
                    });
                    self.emit(ClipboardEvent::RequestFileContents(range_request(
                        stream_id,
                        active.index,
                        size,
                    )));
                }
                Err(e) => {
                    warn!(error = %e, "malformed file size response; skipping file");
                    self.start_next_download();
                }
            },
            DownloadPhase::Range => {
                match std::fs::write(&active.dest, response.data()) {
                    Ok(()) => debug!(
                        path = %active.dest.display(),
                        bytes = response.data().len(),
                        "saved clipboard file into the shared folder"
                    ),
                    Err(e) => {
                        warn!(error = %e, path = %active.dest.display(), "failed to write clipboard file")
                    }
                }
                self.start_next_download();
            }
        }
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
        let response =
            build_format_data_response(ClipboardFormatId::CF_UNICODETEXT, Some(original));
        let decoded = decode_clipboard_text(ClipboardFormatId::CF_UNICODETEXT, &response).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn ansi_text_round_trips_through_response() {
        let original = "plain ascii";
        let response = build_format_data_response(ClipboardFormatId::CF_TEXT, Some(original));
        let decoded = decode_clipboard_text(ClipboardFormatId::CF_TEXT, &response).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn missing_local_text_yields_error_response() {
        let response = build_format_data_response(ClipboardFormatId::CF_UNICODETEXT, None);
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None);
        backend.on_remote_copy(&[text(ClipboardFormatId::CF_UNICODETEXT)]);
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::InitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT
            ))
        );
    }

    #[test]
    fn backend_decodes_response_using_pending_format() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None);
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None);
        backend.on_request_format_list();
        assert_eq!(rx.try_recv(), Ok(ClipboardEvent::AdvertiseLocal));
    }

    #[test]
    fn backend_forwards_server_data_request() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None);
        backend.on_format_data_request(FormatDataRequest {
            format: ClipboardFormatId::CF_UNICODETEXT,
        });
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::ProvideData(
                ClipboardFormatId::CF_UNICODETEXT
            ))
        );
    }

    // --- File transfer (#1765) ---

    use std::sync::mpsc::Receiver;

    /// A file-list clipboard format (`FileGroupDescriptorW`) with the given id.
    fn file_format(id: u32) -> ClipboardFormat {
        ClipboardFormat::new(ClipboardFormatId::new(id)).with_name(ClipboardFormatName::FILE_LIST)
    }

    /// A backend whose received files land in a fresh temp dir.
    fn backend_with_download() -> (
        SidecarClipboardBackend,
        Receiver<ClipboardEvent>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let (backend, rx) = SidecarClipboardBackend::new(Some(root));
        (backend, rx, dir)
    }

    /// Drain the next queued `RequestFileContents` event, failing otherwise.
    fn next_request(rx: &Receiver<ClipboardEvent>) -> FileContentsRequest {
        match rx.try_recv() {
            Ok(ClipboardEvent::RequestFileContents(req)) => req,
            other => panic!("expected RequestFileContents, got {other:?}"),
        }
    }

    #[test]
    fn detects_file_list_format_by_name() {
        assert_eq!(
            file_list_format(&[text(ClipboardFormatId::CF_UNICODETEXT), file_format(0xC0FE)]),
            Some(ClipboardFormatId::new(0xC0FE))
        );
        assert_eq!(file_list_format(&[text(ClipboardFormatId::CF_TEXT)]), None);
    }

    #[test]
    fn capabilities_gate_on_download_enabled() {
        let (text_only, _rx) = SidecarClipboardBackend::new(None);
        assert!(text_only.client_capabilities().is_empty());

        let (files, _rx, _dir) = backend_with_download();
        let caps = files.client_capabilities();
        assert!(caps.contains(ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED));
        assert!(caps.contains(ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES));
    }

    #[test]
    fn remote_file_copy_initiates_a_file_paste_when_enabled() {
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_copy(&[file_format(0xC0FE)]);
        assert_eq!(
            rx.try_recv(),
            Ok(ClipboardEvent::InitiatePaste(ClipboardFormatId::new(
                0xC0FE
            )))
        );
        // A file copy must not be mistaken for a text paste.
        assert!(backend.pending_paste_format.is_none());
    }

    #[test]
    fn remote_file_copy_ignored_when_download_disabled() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None);
        // Only a file format offered; text-only bridge has nothing to fetch.
        backend.on_remote_copy(&[file_format(0xC0FE)]);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn downloads_a_known_size_file_into_the_shared_folder() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("hello.txt").with_file_size(5)], None);

        // Size is known, so a single RANGE request for the whole file is emitted.
        let req = next_request(&rx);
        assert_eq!(req.index, 0);
        assert!(req.flags.contains(FileContentsFlags::RANGE));
        assert_eq!(req.requested_size, 5);

        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            req.stream_id,
            b"hello".to_vec(),
        ));
        assert_eq!(
            std::fs::read(dir.path().join("hello.txt")).unwrap(),
            b"hello"
        );
        // Only one file → no further request.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn unknown_size_file_asks_for_size_then_bytes() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("data.bin")], None);

        // No size in the descriptor → a SIZE request first.
        let size_req = next_request(&rx);
        assert!(size_req.flags.contains(FileContentsFlags::SIZE));
        assert_eq!(size_req.requested_size, 8);

        backend.on_file_contents_response(FileContentsResponse::new_size_response(
            size_req.stream_id,
            3,
        ));
        // Now a RANGE request for the resolved size.
        let range_req = next_request(&rx);
        assert!(range_req.flags.contains(FileContentsFlags::RANGE));
        assert_eq!(range_req.requested_size, 3);

        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            range_req.stream_id,
            b"abc".to_vec(),
        ));
        assert_eq!(std::fs::read(dir.path().join("data.bin")).unwrap(), b"abc");
    }

    #[test]
    fn empty_file_is_created_without_a_request() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("empty.txt").with_file_size(0)], None);
        // No request for a zero-length file; it is created directly.
        assert!(rx.try_recv().is_err());
        assert!(dir.path().join("empty.txt").exists());
        assert_eq!(std::fs::read(dir.path().join("empty.txt")).unwrap(), b"");
    }

    #[test]
    fn oversized_file_is_skipped() {
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_file_list(
            &[FileDescriptor::new("huge.iso").with_file_size(MAX_CLIPBOARD_FILE_BYTES + 1)],
            None,
        );
        // Too big → no request emitted, file skipped.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn directories_are_skipped() {
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_file_list(
            &[FileDescriptor::new("folder").with_attributes(ClipboardFileAttributes::DIRECTORY)],
            None,
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn reserved_device_names_are_rejected() {
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("CON").with_file_size(4)], None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn colliding_names_are_deduplicated() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(
            &[
                FileDescriptor::new("dup.txt").with_file_size(1),
                FileDescriptor::new("dup.txt").with_file_size(1),
            ],
            None,
        );
        // First file.
        let r1 = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r1.stream_id,
            vec![b'a'],
        ));
        // Second file's request now follows.
        let r2 = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r2.stream_id,
            vec![b'b'],
        ));

        assert_eq!(std::fs::read(dir.path().join("dup.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(dir.path().join("dup (1).txt")).unwrap(), b"b");
    }

    #[test]
    fn error_response_skips_to_the_next_file() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(
            &[
                FileDescriptor::new("bad.txt").with_file_size(2),
                FileDescriptor::new("good.txt").with_file_size(2),
            ],
            None,
        );
        let r1 = next_request(&rx);
        // Remote fails the first file.
        backend.on_file_contents_response(FileContentsResponse::new_error(r1.stream_id));
        // Download proceeds to the second file.
        let r2 = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r2.stream_id,
            b"ok".to_vec(),
        ));
        assert!(!dir.path().join("bad.txt").exists());
        assert_eq!(std::fs::read(dir.path().join("good.txt")).unwrap(), b"ok");
    }

    #[test]
    fn response_with_wrong_stream_id_is_ignored() {
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("f.txt").with_file_size(2)], None);
        let req = next_request(&rx);
        // A stray response for a different stream id must not write anything.
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            req.stream_id.wrapping_add(99),
            b"xx".to_vec(),
        ));
        assert!(!dir.path().join("f.txt").exists());
        // The real response still completes the download.
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            req.stream_id,
            b"xx".to_vec(),
        ));
        assert_eq!(std::fs::read(dir.path().join("f.txt")).unwrap(), b"xx");
    }
}
