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
//! rejected. A copied **directory tree** is recreated under the shared folder
//! (each descriptor's `relative_path` is honoured and its subdirectories are
//! created, sandbox-validated per entry); **large files** stream in bounded
//! chunks (`CLIPBOARD_CHUNK_BYTES` per range) so the sidecar never buffers a
//! whole file, however large (#1780).
//!
//! Because IronRDP's `CliprdrBackend` methods run while the [`Cliprdr`] channel
//! is borrowed, downloads are driven the same way as text: the backend records
//! the next channel action as a [`ClipboardEvent`], and the driver performs it
//! (`initiate_paste` / `request_file_contents`) once it owns the active stage.
//!
//! ## Serving local files (#1778) — local→remote paste, sandboxed
//!
//! The reverse direction advertises the **contents of the same one shared
//! folder** to the remote so files placed there can be pasted into the remote
//! session. When file transfer is enabled and the session is **not** view-only,
//! [`on_request_format_list`](SidecarClipboardBackend::on_request_format_list)
//! offers the folder's **recursive** contents as a `FileGroupDescriptorW` list —
//! directory entries plus files carrying their `\`-separated relative paths so
//! the remote recreates the tree (#1780) — and the driver calls
//! [`Cliprdr::initiate_file_copy`]; on a remote paste the server asks for each
//! file's size/bytes and [`on_file_contents_request`](SidecarClipboardBackend::on_file_contents_request)
//! serves them, reading **only** through the shared [`crate::sandbox`] resolver,
//! at most `CLIPBOARD_CHUNK_BYTES` per range response so a large file streams
//! without being buffered whole.
//! Because a FormatList wholly replaces the previous, a text copy and a file
//! offer are mutually exclusive — the most recent local action wins, matching a
//! native clipboard. A view-only session never advertises or serves local
//! files, so no local data is pushed to the remote.
//!
//! ## Host-clipboard files (#1779) — paste any local file, sandboxed to the copy
//!
//! Beyond the shared folder, the backend can offer the files the user actually
//! copied in their host file manager: the sidecar reads the **host OS clipboard's**
//! native file list ([`crate::host_clipboard`]) and, when it holds files, offers
//! **those real paths** to the remote in preference to the shared folder — most
//! recent local action wins, matching a native client. It serves them from their
//! real absolute paths (the [`crate::sandbox`] root does not apply — these are the
//! user's own explicit copy, not remote-supplied paths), read-only. A copied
//! **directory** is walked recursively into dir + file descriptors carrying their
//! relative paths (#1780), symlinks skipped to stay inside the copy. The remote
//! only ever supplies an *index* into the list the
//! backend advertised, so it can never coax the sidecar into serving a file the
//! user did not copy. The same opt-in and view-only gate as #1778 applies, so a
//! view-only session still pushes nothing. Host-clipboard *reading* is macOS-only
//! for now (Windows `CF_HDROP` / Linux `text/uri-list` are sequenced follow-ups);
//! other platforms fall back to the shared-folder offer.
//!
//! [`Cliprdr`]: ironrdp::cliprdr::Cliprdr
//! [`CliprdrBackend`]: ironrdp::cliprdr::backend::CliprdrBackend
//! [`RdpConfig::clipboard_download_dir`]: termihub_core::backends::rdp_sidecar::config::RdpConfig::clipboard_download_dir

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::is_windows_device_name;
use ironrdp::cliprdr::pdu::{
    ClipboardFileAttributes, ClipboardFormat, ClipboardFormatId, ClipboardFormatName,
    ClipboardGeneralCapabilityFlags, FileContentsFlags, FileContentsRequest, FileContentsResponse,
    FileDescriptor, FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp::core::AsAny;
use termihub_core::connection::RemoteClipboardFile;
use tracing::{debug, trace, warn};

use crate::host_clipboard::read_host_clipboard_files;

/// Memory bound for a single in-flight clipboard file-contents transfer. A large
/// file is **streamed** in chunks of this size — received files are requested one
/// range at a time and written incrementally, and served files return at most
/// this many bytes per RANGE response — so the sidecar never buffers a whole file
/// regardless of its size (#1780). 8 MiB keeps the footprint small while still
/// filling the wire efficiently.
const CLIPBOARD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

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
    /// Advertise a local file list (the sandboxed shared folder's contents) so
    /// the remote can paste our files (#1778). The driver calls
    /// [`Cliprdr::initiate_file_copy`](ironrdp::cliprdr::Cliprdr::initiate_file_copy).
    AdvertiseFiles(Vec<FileDescriptor>),
    /// Serve a size or byte range of a locally offered file the remote requested
    /// while pasting (#1778). The driver calls
    /// [`Cliprdr::submit_file_contents`](ironrdp::cliprdr::Cliprdr::submit_file_contents).
    ProvideFileContents(FileContentsResponse<'static>),
    /// The remote copied files and delayed rendering is on: surface the sanitized
    /// file **list** to the host (over IPC) so it can offer them for a local paste
    /// without fetching any bytes yet (#1793). The driver forwards it as
    /// [`SidecarMessage::RemoteClipboardFiles`](termihub_core::backends::rdp_sidecar::protocol::SidecarMessage::RemoteClipboardFiles).
    SurfaceRemoteFiles(Vec<RemoteClipboardFile>),
    /// One streamed chunk of a remote-clipboard file the host asked for by index
    /// (#1793): the driver forwards it as
    /// [`SidecarMessage::ClipboardFileChunk`](termihub_core::backends::rdp_sidecar::protocol::SidecarMessage::ClipboardFileChunk).
    ProvideRemoteFileChunk {
        /// Correlates to the host's `FetchClipboardFile` request.
        request_id: u64,
        /// Byte offset of this chunk within the file.
        position: u64,
        /// The chunk's bytes (empty only for an empty final chunk).
        data: Vec<u8>,
        /// Whether this is the final chunk.
        last: bool,
    },
    /// A host file-fetch failed; the driver forwards it as
    /// [`SidecarMessage::ClipboardFileError`](termihub_core::backends::rdp_sidecar::protocol::SidecarMessage::ClipboardFileError) (#1793).
    RemoteFileError {
        /// Correlates to the host's `FetchClipboardFile` request.
        request_id: u64,
        /// Human-readable reason.
        message: String,
    },
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

/// Where an in-flight file transfer's bytes go: eagerly onto disk in the shared
/// folder (#1765), or streamed back to the host for a delayed-render paste
/// (#1793). The two never interleave — an eager download runs only when delayed
/// rendering is off, and a host fetch only when it is on — so a single in-flight
/// slot serves both.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TransferDest {
    /// Eager download: write each chunk into this sandboxed shared-folder path.
    Disk(PathBuf),
    /// Delayed render: forward each chunk to the host for this fetch request.
    Host { request_id: u64 },
}

/// The single in-flight file transfer, keyed by the stream id we assigned. A
/// large file is fetched over several `RANGE` requests; `position`/`total` track
/// how far the streaming transfer has progressed so each chunk lands at the right
/// offset and it stops at EOF (#1780). `dest` decides whether a chunk is written
/// to disk or streamed to the host (#1793).
#[derive(Debug, Clone)]
struct ActiveDownload {
    stream_id: u32,
    index: i32,
    dest: TransferDest,
    phase: DownloadPhase,
    /// Byte offset the next `RANGE` chunk is written at (0 during a `SIZE` phase).
    position: u64,
    /// Total file length once known (0 during a `SIZE` phase, before it resolves).
    total: u64,
}

/// The sidecar's [`CliprdrBackend`]: it holds no clipboard *state* of its own; it
/// translates CLIPRDR callbacks into [`ClipboardEvent`]s the driver forwards over
/// IPC (text) or acts on (file downloads), and reads the **host** OS clipboard's
/// file list on demand to offer the user's copied files (#1779).
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
    /// View-only sessions never push local data to the remote, so they neither
    /// advertise nor serve local files (#1778).
    view_only: bool,
    /// Files last advertised to the remote, indexed by advertise order — a
    /// `FileContentsRequest`'s `index` selects one to serve (#1778/#1779). Holds
    /// either the sandboxed shared folder's files or the host clipboard's real
    /// files, whichever was offered. Empty until an offer is advertised.
    offered_files: Vec<OfferedFile>,
    /// Reads the host OS clipboard's native file list (#1779). A field (not a
    /// direct call) so tests can inject a deterministic list instead of touching
    /// the real clipboard; production wires [`read_host_clipboard_files`].
    host_clip_reader: Box<dyn Fn() -> Vec<PathBuf> + Send>,
    /// Chunk size for streaming a received file's bytes (#1780). Defaults to
    /// [`CLIPBOARD_CHUNK_BYTES`]; a field so tests can shrink it to exercise the
    /// multi-chunk path without multi-megabyte fixtures.
    chunk_bytes: u64,
    /// When `true`, a remote file copy is **surfaced** to the host as a file list
    /// (delayed rendering, #1793) instead of eagerly downloaded into the shared
    /// folder (#1765). Set from [`RdpConfig::clipboard_delayed_render_enabled`].
    delayed_render: bool,
    /// The sanitized file list last surfaced to the host in delayed-render mode
    /// (#1793). A [`Self::fetch_remote_file`] may only name an `index` present
    /// here, so the remote can never coax a fetch of a file it did not advertise.
    /// Empty until a remote copy is surfaced; carries each entry's advertised size
    /// and directory flag.
    remote_offer: Vec<RemoteClipboardFile>,
}

impl std::fmt::Debug for SidecarClipboardBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The host-clipboard reader is a closure with no useful Debug; elide it.
        f.debug_struct("SidecarClipboardBackend")
            .field("temp_dir", &self.temp_dir)
            .field("pending_paste_format", &self.pending_paste_format)
            .field("download_dir", &self.download_dir)
            .field("download_queue", &self.download_queue)
            .field("active_download", &self.active_download)
            .field("next_stream_id", &self.next_stream_id)
            .field("view_only", &self.view_only)
            .field("offered_files", &self.offered_files)
            .field("chunk_bytes", &self.chunk_bytes)
            .field("delayed_render", &self.delayed_render)
            .field("remote_offer", &self.remote_offer)
            .finish_non_exhaustive()
    }
}

/// A local entry offered to the remote over CLIPRDR (#1778/#1779/#1780). Its
/// position in the advertised list is the `index` a [`FileContentsRequest`]
/// references. An entry is either a regular file (bytes served on request) or a
/// **directory** (`is_dir`), which carries no bytes but tells the remote to
/// recreate the folder so a copied tree keeps its structure (#1780).
#[derive(Debug, Clone, PartialEq, Eq)]
struct OfferedFile {
    /// Basename advertised to the remote.
    name: String,
    /// Directory portion of this entry's path within the copied collection,
    /// `\`-separated, or `None` for a top-level entry (#1780). Advertised as the
    /// descriptor's `relative_path` so the remote rebuilds the tree.
    relative_path: Option<String>,
    /// Path the bytes are served from: either a sandboxed, canonical path inside
    /// the shared folder (from [`crate::sandbox::resolve_in_root`], #1778) or the
    /// real absolute path of a file the user copied to the host clipboard (#1779).
    /// The remote never supplies this — it only selects an advertised index — so a
    /// real path here is exactly one the user copied. Unused for a directory entry.
    path: PathBuf,
    /// File size at advertise time (a `SIZE` request re-stats for the current
    /// value, falling back to this). 0 for a directory entry.
    size: u64,
    /// Whether this entry is a directory (no bytes to serve) rather than a file.
    is_dir: bool,
}

impl SidecarClipboardBackend {
    /// Create the backend and the receiver the driver drains. `download_dir` is
    /// the (already sandboxed, canonical) shared folder received files land in
    /// and local files are served from, or `None` to keep the bridge text-only.
    /// `view_only` suppresses advertising/serving local files (#1778). The
    /// backend is handed to [`Cliprdr::new`](ironrdp::cliprdr::Cliprdr::new); the
    /// receiver stays with the driver loop.
    pub fn new(
        download_dir: Option<PathBuf>,
        view_only: bool,
    ) -> (Self, std::sync::mpsc::Receiver<ClipboardEvent>) {
        Self::with_host_clip_reader(download_dir, view_only, read_host_clipboard_files)
    }

    /// Like [`Self::new`] but with an injected host-clipboard reader. The real
    /// reader touches the OS clipboard, which is neither deterministic nor
    /// available in a unit test, so tests build the backend with a stub returning
    /// a fixed file list (or none).
    pub fn with_host_clip_reader(
        download_dir: Option<PathBuf>,
        view_only: bool,
        host_clip_reader: impl Fn() -> Vec<PathBuf> + Send + 'static,
    ) -> (Self, std::sync::mpsc::Receiver<ClipboardEvent>) {
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
                view_only,
                offered_files: Vec::new(),
                host_clip_reader: Box::new(host_clip_reader),
                chunk_bytes: CLIPBOARD_CHUNK_BYTES,
                delayed_render: false,
                remote_offer: Vec::new(),
            },
            rx,
        )
    }

    /// Enable (or disable) remote→host delayed rendering (#1793). When on, a
    /// remote file copy surfaces its file list to the host rather than eagerly
    /// downloading it into the shared folder; the host then fetches a file's
    /// bytes on demand via [`Self::fetch_remote_file`]. Set from
    /// [`RdpConfig::clipboard_delayed_render_enabled`] at connect time.
    pub fn set_delayed_render(&mut self, enabled: bool) {
        self.delayed_render = enabled;
    }

    /// Shrink the streaming chunk size (tests only) so the multi-chunk download
    /// path can be exercised with tiny fixtures instead of multi-megabyte files.
    #[cfg(test)]
    fn set_chunk_bytes(&mut self, chunk_bytes: u64) {
        self.chunk_bytes = chunk_bytes;
    }

    /// Whether this session serves local files to the remote: file transfer is
    /// enabled (a shared folder exists) and the session is not view-only (#1778).
    fn serves_local_files(&self) -> bool {
        self.download_dir.is_some() && !self.view_only
    }

    /// Build the local file offer, recording the index→path map used to serve
    /// later requests. Prefers the **host OS clipboard's** file list (#1779) —
    /// the files the user actually copied — and falls back to the sandboxed
    /// **shared folder** (#1778) when the clipboard holds no files. Returns the
    /// descriptors to advertise, or `None` when serving is off or neither source
    /// offers a file (in which case the caller advertises text).
    fn build_local_file_offer(&mut self) -> Option<Vec<FileDescriptor>> {
        if !self.serves_local_files() {
            return None;
        }
        // Host OS clipboard first: the files the user just copied, served from
        // their real paths. Most-recent local action wins, like a native client.
        let host_files = (self.host_clip_reader)();
        if let Some((descriptors, offered)) = build_host_file_offer(&host_files) {
            debug!(
                count = offered.len(),
                "offering host-clipboard files to the remote"
            );
            self.offered_files = offered;
            return Some(descriptors);
        }
        // Otherwise fall back to the sandboxed shared folder's contents (#1778),
        // recursed into a directory + file tree (#1780).
        let root = self.download_dir.as_ref()?;
        let offered = collect_offerable_files(root);
        if offered.is_empty() {
            self.offered_files.clear();
            return None;
        }
        let descriptors = offered.iter().map(offered_descriptor).collect();
        self.offered_files = offered;
        Some(descriptors)
    }

    /// Re-advertise the local file offer after the shared folder's contents
    /// changed while the session is connected (#1788). Reuses the exact
    /// [`Self::build_local_file_offer`] pipeline as [`Self::on_request_format_list`],
    /// so the refreshed [`Self::offered_files`] index map stays consistent with
    /// what a later `FileContentsRequest` serves, and the re-enumeration stays
    /// inside the sandbox root via [`collect_offerable_files`] exactly as the
    /// initial offer does. The same opt-in + view-only gate applies: a view-only
    /// or text-only session never offered local files, so a folder change emits
    /// nothing here. When the folder — and the host clipboard — went empty, a text
    /// advertisement replaces the stale file list (a `FormatList` wholly replaces
    /// the previous one) so the remote stops offering files that are gone.
    pub fn readvertise_local_files(&mut self) {
        if !self.serves_local_files() {
            return;
        }
        match self.build_local_file_offer() {
            Some(files) => self.emit(ClipboardEvent::AdvertiseFiles(files)),
            None => self.emit(ClipboardEvent::AdvertiseLocal),
        }
    }

    fn emit(&self, event: ClipboardEvent) {
        if self.tx.send(event).is_err() {
            debug!("clipboard event receiver dropped; sidecar shutting down");
        }
    }

    /// Terminate an in-flight host fetch (#1793): clear the in-flight slot and
    /// tell the host the fetch failed, so its paste never hangs on a request the
    /// remote refused or could not answer.
    fn finish_host_fetch(&mut self, request_id: u64, result: Result<(), String>) {
        self.active_download = None;
        if let Err(message) = result {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message,
            });
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

    /// Plan the download of a remote file list into the download folder,
    /// preserving the copied directory structure (#1780): recreate each directory
    /// descriptor's folder and honour every file descriptor's `relative_path` so
    /// the tree lands intact under the shared folder. Empty/`.`/`..` leaves,
    /// Windows device names (on any component) and paths the [`crate::sandbox`]
    /// resolver rejects are skipped; a genuinely colliding destination is
    /// deduplicated. Returns the queue of files whose bytes still need fetching.
    fn plan_downloads(&self, files: &[FileDescriptor]) -> VecDeque<PlannedDownload> {
        let Some(dir) = self.download_dir.as_ref() else {
            return VecDeque::new();
        };
        let mut used: HashSet<PathBuf> = HashSet::new();
        let mut queue = VecDeque::new();
        for (index, file) in files.iter().enumerate() {
            // Reconstruct the path relative to the copied-collection root from the
            // descriptor's directory portion (`relative_path`) and basename.
            let Some(rel) = descriptor_rel_path(file) else {
                warn!(name = %file.name, "skipping clipboard entry with an unusable name");
                continue;
            };
            // Reject a reserved device name on ANY component, not just the leaf.
            if rel
                .split(['\\', '/'])
                .any(|c| !c.is_empty() && is_windows_device_name(c))
            {
                warn!(path = %rel, "skipping clipboard entry with a reserved device name");
                continue;
            }
            // Sandbox every entry — file or directory — per component: rejects
            // `..`, drive letters, NUL and (for existing components) symlink
            // escapes. `..` was already rejected lexically, so a fresh nested path
            // cannot escape even before its parents exist.
            let Some(dest) = crate::sandbox::resolve_in_root(dir, &rel) else {
                warn!(path = %rel, "clipboard entry rejected by sandbox");
                continue;
            };
            if descriptor_is_dir(file) {
                // A directory carries no bytes: recreate it now so a file that
                // arrives before its parent descriptor still has somewhere to land.
                if let Err(e) = std::fs::create_dir_all(&dest) {
                    warn!(error = %e, path = %dest.display(), "failed to create clipboard directory");
                } else {
                    used.insert(dest);
                }
                continue;
            }
            // Ensure the file's parent directory exists (a file may precede its
            // directory descriptor, or carry a deeper relative path with no
            // explicit descriptor for the intermediate folders).
            if let Some(parent) = dest.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    warn!(error = %e, path = %parent.display(), "failed to create clipboard parent directory; skipping file");
                    continue;
                }
            }
            let dest = unique_dest(&mut used, dest);
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
    /// create it immediately and move on. A large file is streamed in
    /// [`Self::chunk_bytes`]-sized ranges rather than skipped (#1780).
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
                Some(size) => {
                    // Size known: stream it, starting with the first chunk.
                    self.begin_range_download(
                        planned.index,
                        TransferDest::Disk(planned.dest),
                        size,
                    );
                    return;
                }
                None => {
                    // Size unknown: ask for it first, then the bytes.
                    let stream_id = self.allocate_stream_id();
                    self.active_download = Some(ActiveDownload {
                        stream_id,
                        index: planned.index,
                        dest: TransferDest::Disk(planned.dest),
                        phase: DownloadPhase::Size,
                        position: 0,
                        total: 0,
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

    /// Begin (or, from [`Self::start_next_download`], restart) a chunked byte
    /// transfer of a known-size file: request the first [`Self::chunk_bytes`]
    /// range and record the transfer so [`Self::on_file_contents_response`]
    /// continues it chunk by chunk until EOF (#1780). `dest` routes each chunk to
    /// disk (eager download) or the host (delayed render, #1793).
    fn begin_range_download(&mut self, index: i32, dest: TransferDest, total: u64) {
        let stream_id = self.allocate_stream_id();
        let want = total.min(self.chunk_bytes);
        self.active_download = Some(ActiveDownload {
            stream_id,
            index,
            dest,
            phase: DownloadPhase::Range,
            position: 0,
            total,
        });
        self.emit(ClipboardEvent::RequestFileContents(range_request(
            stream_id, index, 0, want,
        )));
    }

    /// Fetch one remote-clipboard file's bytes on demand — the paste gesture of
    /// the delayed-render path (#1793). Validates `index` against the sanitized
    /// [`Self::remote_offer`] the host was shown (so the remote can only ever
    /// serve a file it advertised), then drives the same chunked CLIPRDR
    /// `FileContentsRequest` machinery as an eager download, but streams each
    /// chunk back to the host instead of writing it to disk. Any failure emits a
    /// [`ClipboardEvent::RemoteFileError`] so the host's fetch always terminates.
    ///
    /// Serves one fetch at a time: a request arriving while another is in flight
    /// is rejected (the host paces its fetches), which keeps the single-in-flight
    /// memory bound and stream-id bookkeeping trivial.
    pub fn fetch_remote_file(&mut self, request_id: u64, index: u32) {
        if !self.delayed_render || self.download_dir.is_none() {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message: "remote clipboard file transfer is not enabled".to_string(),
            });
            return;
        }
        let Some(meta) = self.remote_offer.iter().find(|f| f.index == index) else {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message: format!("unknown clipboard file index {index}"),
            });
            return;
        };
        if meta.is_dir {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message: format!("clipboard entry {index} is a directory"),
            });
            return;
        }
        if self.active_download.is_some() {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message: "another clipboard fetch is already in progress".to_string(),
            });
            return;
        }
        let size = meta.size;
        // The advertised list index is the CLIPRDR file-list index the server
        // keys a `FileContentsRequest` on.
        let Ok(idx) = i32::try_from(index) else {
            self.emit(ClipboardEvent::RemoteFileError {
                request_id,
                message: format!("clipboard file index {index} out of range"),
            });
            return;
        };
        let dest = TransferDest::Host { request_id };
        match size {
            Some(0) => {
                // Known-empty file: no range to request; hand the host an empty
                // final chunk so its fetch completes.
                self.emit(ClipboardEvent::ProvideRemoteFileChunk {
                    request_id,
                    position: 0,
                    data: Vec::new(),
                    last: true,
                });
            }
            Some(total) => self.begin_range_download(idx, dest, total),
            None => {
                // Size unknown: ask for it first, then the bytes.
                let stream_id = self.allocate_stream_id();
                self.active_download = Some(ActiveDownload {
                    stream_id,
                    index: idx,
                    dest,
                    phase: DownloadPhase::Size,
                    position: 0,
                    total: 0,
                });
                self.emit(ClipboardEvent::RequestFileContents(size_request(
                    stream_id, idx,
                )));
            }
        }
    }
}

/// Sanitize one remote file descriptor into the metadata surfaced to the host
/// (#1793), or `None` when its path is unusable/hostile. The descriptor's
/// `relative_path\name` is split into components, each of which must be a plain
/// name — no `.`/`..`, no drive letter or `:`/NUL, no reserved Windows device
/// name — so nothing that reaches the host clipboard or a host temp path can
/// escape a directory or name a device. The returned `index` is the descriptor's
/// position in the remote file list, which a later `FileContentsRequest` keys on.
fn sanitize_descriptor(file: &FileDescriptor, index: usize) -> Option<RemoteClipboardFile> {
    let rel = descriptor_rel_path(file)?;
    let mut parts: Vec<String> = Vec::new();
    for component in rel.split(['\\', '/']) {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            return None;
        }
        if component.contains('\0') || component.contains(':') {
            return None;
        }
        if is_windows_device_name(component) {
            return None;
        }
        parts.push(component.to_string());
    }
    let name = parts.pop()?;
    let relative_path = (!parts.is_empty()).then(|| parts.join("/"));
    let index = u32::try_from(index).ok()?;
    Some(RemoteClipboardFile {
        name,
        relative_path,
        size: file.file_size,
        is_dir: descriptor_is_dir(file),
        index,
    })
}

/// Build a deduplicated basename: `file.txt`, then `file (1).txt`, … keeping the
/// extension. Records the chosen name in `used`.
fn unique_name(used: &mut HashSet<String>, base: &str) -> String {
    if used.insert(base.to_string()) {
        return base.to_string();
    }
    let (stem, ext) = split_stem_ext(base);
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

/// Split a basename into `(stem, extension)`, keeping `None` for a name with no
/// extension (or a leading-dot name like `.env`, whose whole self is the stem).
fn split_stem_ext(base: &str) -> (&str, Option<&str>) {
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (base, None),
    }
}

/// Ensure `dest` is unique among the destinations planned so far, disambiguating
/// a genuine collision with a ` (n)` suffix on the basename (extension kept) in
/// the same directory — so a duplicated path never silently overwrites an earlier
/// file. Preserving the tree means two files with the same basename in *different*
/// directories no longer collide (#1780). Records the chosen path in `used`.
fn unique_dest(used: &mut HashSet<PathBuf>, dest: PathBuf) -> PathBuf {
    if used.insert(dest.clone()) {
        return dest;
    }
    let parent = dest.parent().map(Path::to_path_buf).unwrap_or_default();
    let base = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let (stem, ext) = split_stem_ext(&base);
    for n in 1.. {
        let candidate = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let path = parent.join(candidate);
        if used.insert(path.clone()) {
            return path;
        }
    }
    unreachable!("the counter is unbounded")
}

/// Whether a descriptor names a directory (which carries no bytes to fetch).
fn descriptor_is_dir(file: &FileDescriptor) -> bool {
    file.attributes
        .map(|a| a.contains(ClipboardFileAttributes::DIRECTORY))
        .unwrap_or(false)
}

/// Reconstruct a descriptor's path relative to the copied-collection root:
/// `relative_path\name` when the descriptor carries a directory portion, else the
/// bare `name` (#1780). Per-component sanitisation is left to the sandbox
/// resolver — this only rejects a descriptor whose leaf is empty, `.` or `..`.
fn descriptor_rel_path(file: &FileDescriptor) -> Option<String> {
    let rel = match &file.relative_path {
        Some(path) if !path.is_empty() => {
            format!("{}\\{}", path.trim_end_matches(['\\', '/']), file.name)
        }
        _ => file.name.clone(),
    };
    let leaf = rel.rsplit(['\\', '/']).find(|c| !c.is_empty())?;
    if leaf == "." || leaf == ".." {
        return None;
    }
    Some(rel)
}

/// Build the `FileDescriptor` advertised for a local entry (#1780): a directory
/// entry carries the `DIRECTORY` attribute and no size; a file carries its size.
/// Both carry the `relative_path` so the remote rebuilds the tree.
fn offered_descriptor(offered: &OfferedFile) -> FileDescriptor {
    let mut descriptor = FileDescriptor::new(offered.name.clone());
    if let Some(rel) = &offered.relative_path {
        if !rel.is_empty() {
            descriptor = descriptor.with_relative_path(rel.clone());
        }
    }
    if offered.is_dir {
        descriptor.with_attributes(ClipboardFileAttributes::DIRECTORY)
    } else {
        descriptor.with_file_size(offered.size)
    }
}

/// Write one received chunk at `position`, truncating the file on the first chunk
/// so a re-used name keeps no stale tail. Only one chunk is buffered at a time, so
/// memory stays bounded regardless of the file's size (#1780).
fn write_chunk(path: &Path, position: u64, data: &[u8]) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(position == 0)
        .open(path)?;
    file.seek(SeekFrom::Start(position))?;
    file.write_all(data)?;
    Ok(())
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

/// A `RANGE` request for `len` bytes starting at `position` (#1780). `len` is a
/// single chunk (`<= CLIPBOARD_CHUNK_BYTES`), so it always fits the `u32`
/// `requested_size`; large files are fetched over successive chunks.
fn range_request(stream_id: u32, index: i32, position: u64, len: u64) -> FileContentsRequest {
    FileContentsRequest {
        stream_id,
        index,
        flags: FileContentsFlags::RANGE,
        position,
        requested_size: len as u32,
        data_id: None,
    }
}

/// Enumerate the shared folder **recursively** as offerable entries (#1780):
/// directory entries (so the remote recreates the tree) and regular files, each
/// carrying its `\`-separated `relative_path`. Deterministic (name-sorted per
/// level, directories walked depth-first right after they are listed) so an
/// advertised index stays stable for the matching serve. Symlinks and reserved
/// device names are skipped, and every path is re-validated through the
/// [`crate::sandbox`] resolver (#1778) so nothing escapes the folder.
fn collect_offerable_files(root: &Path) -> Vec<OfferedFile> {
    let mut entries = Vec::new();
    collect_offerable_dir(root, None, &mut entries);
    entries
}

/// Recurse one directory (relative path `rel`, `None` at the root) of the shared
/// folder, appending its directory and file entries to `out` in name-sorted
/// order, each validated through the sandbox resolver.
fn collect_offerable_dir(root: &Path, rel: Option<&str>, out: &mut Vec<OfferedFile>) {
    let dir = match rel {
        Some(rel) => match crate::sandbox::resolve_in_root(root, rel) {
            Some(path) => path,
            None => return,
        },
        None => root.to_path_buf(),
    };
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!(error = %e, path = %dir.display(), "cannot read shared folder to offer files");
            return;
        }
    };
    let mut names: Vec<String> = Vec::new();
    for entry in read_dir.flatten() {
        // `file_type` does not follow symlinks, so a symlinked directory is not
        // recursed into (avoiding both escapes and cycles); the sandbox resolver
        // below is the second line of defence on the resolved path.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." || is_windows_device_name(&name) {
            continue;
        }
        names.push(name);
    }
    names.sort();
    for name in names {
        let child_rel = match rel {
            Some(rel) => format!("{rel}\\{name}"),
            None => name.clone(),
        };
        let Some(path) = crate::sandbox::resolve_in_root(root, &child_rel) else {
            warn!(name = %child_rel, "local entry rejected by sandbox; not offering");
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            out.push(OfferedFile {
                name,
                relative_path: rel.map(str::to_string),
                path,
                size: 0,
                is_dir: true,
            });
            collect_offerable_dir(root, Some(&child_rel), out);
        } else if meta.is_file() {
            out.push(OfferedFile {
                name,
                relative_path: rel.map(str::to_string),
                path,
                size: meta.len(),
                is_dir: false,
            });
        }
    }
}

/// Build a file offer from the host OS clipboard's file list (#1779): the real
/// paths the user copied in their file manager. A copied **directory** is walked
/// recursively into directory + file entries carrying their relative paths so the
/// remote rebuilds the tree (#1780); regular files are offered directly. Symlinks
/// are skipped to stay inside the copy (and avoid cycles); the clipboard order is
/// preserved so an advertised index maps to the copy order, and colliding
/// top-level basenames (same name from different folders) are deduplicated.
/// Returns the descriptors to advertise paired with the index→entry map to serve
/// from, or `None` when nothing offerable remains (the caller then falls back to
/// the shared folder). Paths are served **as-is** — they are the user's own
/// explicit copy, not remote-supplied, and the remote only ever selects an
/// advertised index.
fn build_host_file_offer(paths: &[PathBuf]) -> Option<(Vec<FileDescriptor>, Vec<OfferedFile>)> {
    let mut used: HashSet<String> = HashSet::new();
    let mut offered: Vec<OfferedFile> = Vec::new();
    for path in paths {
        let ft = match std::fs::symlink_metadata(path) {
            Ok(m) => m.file_type(),
            Err(e) => {
                warn!(error = %e, path = %path.display(), "cannot stat host-clipboard entry; not offering");
                continue;
            }
        };
        if ft.is_symlink() {
            continue;
        }
        let base = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if base.is_empty() {
            continue;
        }
        let name = unique_name(&mut used, &base);
        if ft.is_dir() {
            // Recurse the copied folder, rooted so descendants' relative paths
            // carry the (deduplicated) top-level `name`.
            offered.push(OfferedFile {
                name: name.clone(),
                relative_path: None,
                path: path.clone(),
                size: 0,
                is_dir: true,
            });
            collect_host_dir(path, &name, &mut offered);
        } else if ft.is_file() {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            offered.push(OfferedFile {
                name,
                relative_path: None,
                path: path.clone(),
                size,
                is_dir: false,
            });
        }
    }
    if offered.is_empty() {
        return None;
    }
    let descriptors = offered.iter().map(offered_descriptor).collect();
    Some((descriptors, offered))
}

/// Recurse a copied host-clipboard directory `dir` whose relative path within the
/// offer is `rel`, appending its directory and file entries (name-sorted per
/// level) to `out`. Symlinks are skipped; there is no sandbox root — these are the
/// user's own explicit copy (#1780).
fn collect_host_dir(dir: &Path, rel: &str, out: &mut Vec<OfferedFile>) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!(error = %e, path = %dir.display(), "cannot read copied host directory; skipping");
            return;
        }
    };
    let mut entries: Vec<(String, PathBuf, std::fs::FileType)> = Vec::new();
    for entry in read_dir.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        entries.push((name, entry.path(), ft));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path, ft) in entries {
        let child_rel = format!("{rel}\\{name}");
        if ft.is_dir() {
            out.push(OfferedFile {
                name,
                relative_path: Some(rel.to_string()),
                path: path.clone(),
                size: 0,
                is_dir: true,
            });
            collect_host_dir(&path, &child_rel, out);
        } else if ft.is_file() {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(OfferedFile {
                name,
                relative_path: Some(rel.to_string()),
                path,
                size,
                is_dir: false,
            });
        }
    }
}

/// Build the response to a server `FileContentsRequest` against the entries we
/// advertised: a `SIZE` request yields the file's current length; a `RANGE`
/// request yields the requested bytes (capped at [`CLIPBOARD_CHUNK_BYTES`] per
/// response, truncated at EOF, so a large file streams over successive ranges).
/// An unknown index, a directory index, a missing flag or any read failure yields
/// an error response, which the spec allows (#1778/#1780).
fn serve_file_contents(
    offered: &[OfferedFile],
    request: &FileContentsRequest,
) -> FileContentsResponse<'static> {
    let stream_id = request.stream_id;
    let Some(file) = usize::try_from(request.index)
        .ok()
        .and_then(|i| offered.get(i))
    else {
        warn!(
            index = request.index,
            "file-contents request for an unknown file index"
        );
        return FileContentsResponse::new_error(stream_id);
    };

    if file.is_dir {
        // A directory entry carries no byte stream; a conforming remote only asks
        // for file indices, so a request here is malformed.
        warn!(
            index = request.index,
            "file-contents request for a directory entry"
        );
        return FileContentsResponse::new_error(stream_id);
    }

    if request.flags.contains(FileContentsFlags::SIZE) {
        // Re-stat for the current size; fall back to the advertised value.
        let size = std::fs::metadata(&file.path)
            .map(|m| m.len())
            .unwrap_or(file.size);
        return FileContentsResponse::new_size_response(stream_id, size);
    }

    if request.flags.contains(FileContentsFlags::RANGE) {
        match read_file_range(&file.path, request.position, request.requested_size) {
            Ok(bytes) => FileContentsResponse::new_data_response(stream_id, bytes),
            Err(e) => {
                warn!(error = %e, path = %file.path.display(), "failed to serve clipboard file range");
                FileContentsResponse::new_error(stream_id)
            }
        }
    } else {
        warn!(flags = ?request.flags, "file-contents request with neither SIZE nor RANGE");
        FileContentsResponse::new_error(stream_id)
    }
}

/// Read up to `requested_size` bytes (capped at [`CLIPBOARD_CHUNK_BYTES`] so one
/// response never buffers more than a chunk) from `path` starting at `position`,
/// returning fewer bytes at EOF.
fn read_file_range(path: &Path, position: u64, requested_size: u32) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let cap = u64::from(requested_size).min(CLIPBOARD_CHUNK_BYTES);
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut buf = Vec::new();
    file.take(cap).read_to_end(&mut buf)?;
    Ok(buf)
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
        // The initialization sequence needs us to send a format list. When
        // serving is enabled and the shared folder holds files, offer them so
        // the remote can paste them (#1778); otherwise fall back to the host
        // text clipboard (#1756). A FormatList wholly replaces the previous, so
        // the two offers are mutually exclusive — most recent action wins.
        match self.build_local_file_offer() {
            Some(files) => self.emit(ClipboardEvent::AdvertiseFiles(files)),
            None => self.emit(ClipboardEvent::AdvertiseLocal),
        }
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
        if self.delayed_render {
            // Delayed rendering: surface the sanitized list to the host and fetch
            // bytes only when it later pastes (#1793) — do not download eagerly.
            self.download_queue.clear();
            self.active_download = None;
            let offer: Vec<RemoteClipboardFile> = files
                .iter()
                .enumerate()
                .filter_map(|(i, f)| sanitize_descriptor(f, i))
                .collect();
            debug!(
                count = offer.len(),
                "surfacing remote clipboard file list to host (delayed render)"
            );
            self.remote_offer = offer.clone();
            self.emit(ClipboardEvent::SurfaceRemoteFiles(offer));
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
        if !self.serves_local_files() {
            // We never advertised a local file list, so a conforming server does
            // not ask; ignore a stray request.
            trace!(
                stream_id = request.stream_id,
                "ignoring file-contents request (not serving local files)"
            );
            return;
        }
        // Serve the size/bytes of the requested file from the shared folder; the
        // driver submits the response on the channel (#1778).
        let response = serve_file_contents(&self.offered_files, &request);
        self.emit(ClipboardEvent::ProvideFileContents(response));
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
            match &active.dest {
                TransferDest::Disk(dest) => {
                    warn!(path = %dest.display(), "remote returned an error for a clipboard file; skipping");
                    self.start_next_download();
                }
                TransferDest::Host { request_id } => {
                    warn!(
                        request_id,
                        "remote returned an error for a fetched clipboard file"
                    );
                    self.finish_host_fetch(*request_id, Err("remote refused the file".to_string()));
                }
            }
            return;
        }

        match active.phase {
            DownloadPhase::Size => match response.data_as_size() {
                Ok(0) => match &active.dest {
                    TransferDest::Disk(dest) => {
                        if let Err(e) = std::fs::write(dest, []) {
                            warn!(error = %e, path = %dest.display(), "failed to create empty clipboard file");
                        }
                        self.start_next_download();
                    }
                    TransferDest::Host { request_id } => {
                        let request_id = *request_id;
                        self.active_download = None;
                        self.emit(ClipboardEvent::ProvideRemoteFileChunk {
                            request_id,
                            position: 0,
                            data: Vec::new(),
                            last: true,
                        });
                    }
                },
                Ok(size) => {
                    // Size resolved: stream the bytes, chunked, to the same dest.
                    self.begin_range_download(active.index, active.dest, size);
                }
                Err(e) => match &active.dest {
                    TransferDest::Disk(_) => {
                        warn!(error = %e, "malformed file size response; skipping file");
                        self.start_next_download();
                    }
                    TransferDest::Host { request_id } => {
                        warn!(error = %e, "malformed file size response for a host fetch");
                        self.finish_host_fetch(
                            *request_id,
                            Err("malformed file size response".to_string()),
                        );
                    }
                },
            },
            DownloadPhase::Range => {
                let chunk = response.data();
                let written = active.position + chunk.len() as u64;
                // Stop at EOF: either we reached the advertised total, or the
                // remote returned a short/empty chunk (all it had left).
                let last = chunk.is_empty() || written >= active.total;
                match &active.dest {
                    TransferDest::Disk(dest) => {
                        if let Err(e) = write_chunk(dest, active.position, chunk) {
                            warn!(error = %e, path = %dest.display(), "failed to write clipboard file chunk; skipping file");
                            self.start_next_download();
                            return;
                        }
                    }
                    TransferDest::Host { request_id } => {
                        // Stream the chunk to the host; it never buffers whole.
                        self.emit(ClipboardEvent::ProvideRemoteFileChunk {
                            request_id: *request_id,
                            position: active.position,
                            data: chunk.to_vec(),
                            last,
                        });
                    }
                }
                if last {
                    match &active.dest {
                        TransferDest::Disk(dest) => {
                            if written < active.total {
                                warn!(
                                    got = written,
                                    expected = active.total,
                                    path = %dest.display(),
                                    "clipboard file ended before its advertised size; wrote a partial file"
                                );
                            } else {
                                debug!(path = %dest.display(), bytes = written, "saved clipboard file into the shared folder");
                            }
                            self.start_next_download();
                        }
                        TransferDest::Host { request_id } => {
                            debug!(
                                request_id,
                                bytes = written,
                                "streamed fetched clipboard file to host"
                            );
                            self.active_download = None;
                        }
                    }
                } else {
                    // More to fetch: request the next chunk from where we stopped.
                    let stream_id = self.allocate_stream_id();
                    let want = (active.total - written).min(self.chunk_bytes);
                    self.active_download = Some(ActiveDownload {
                        stream_id,
                        index: active.index,
                        dest: active.dest,
                        phase: DownloadPhase::Range,
                        position: written,
                        total: active.total,
                    });
                    self.emit(ClipboardEvent::RequestFileContents(range_request(
                        stream_id,
                        active.index,
                        written,
                        want,
                    )));
                }
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
        backend.on_request_format_list();
        assert_eq!(rx.try_recv(), Ok(ClipboardEvent::AdvertiseLocal));
    }

    #[test]
    fn backend_forwards_server_data_request() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
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
        // Empty host-clipboard reader: these tests exercise the shared-folder
        // path, so the host clipboard must offer nothing (and never touch the
        // real OS clipboard).
        let (backend, rx) =
            SidecarClipboardBackend::with_host_clip_reader(Some(root), false, Vec::new);
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
        let (text_only, _rx) = SidecarClipboardBackend::new(None, false);
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
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
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
    fn large_file_is_streamed_in_chunks() {
        // A file larger than one chunk is fetched over successive RANGE requests
        // and written incrementally, never buffered whole (#1780).
        let (mut backend, rx, dir) = backend_with_download();
        backend.set_chunk_bytes(4);
        backend.on_remote_file_list(&[FileDescriptor::new("big.bin").with_file_size(10)], None);

        // Chunk 1: [0, 4).
        let r1 = next_request(&rx);
        assert_eq!(r1.position, 0);
        assert_eq!(r1.requested_size, 4);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r1.stream_id,
            b"aaaa".to_vec(),
        ));
        // Chunk 2: [4, 8).
        let r2 = next_request(&rx);
        assert_eq!(r2.position, 4);
        assert_eq!(r2.requested_size, 4);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r2.stream_id,
            b"bbbb".to_vec(),
        ));
        // Chunk 3: [8, 10) — only the remaining 2 bytes are asked for.
        let r3 = next_request(&rx);
        assert_eq!(r3.position, 8);
        assert_eq!(r3.requested_size, 2);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r3.stream_id,
            b"cc".to_vec(),
        ));

        // No further request; the streamed bytes are reassembled in order.
        assert!(rx.try_recv().is_err());
        assert_eq!(
            std::fs::read(dir.path().join("big.bin")).unwrap(),
            b"aaaabbbbcc"
        );
    }

    #[test]
    fn a_short_chunk_continues_but_an_empty_chunk_ends_the_transfer() {
        // A shorter-than-requested (but non-empty) chunk just advances by the
        // bytes received and asks for the rest — robust to a server that chunks
        // its responses. An empty chunk means the server has nothing more, so we
        // stop (with a partial file) rather than loop forever (#1780).
        let (mut backend, rx, dir) = backend_with_download();
        backend.set_chunk_bytes(4);
        backend.on_remote_file_list(&[FileDescriptor::new("short.bin").with_file_size(10)], None);

        let r1 = next_request(&rx);
        assert_eq!(r1.position, 0);
        // Server returns only 2 of the requested 4 bytes — not EOF.
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r1.stream_id,
            b"aa".to_vec(),
        ));
        // We advance to position 2 and request the remainder.
        let r2 = next_request(&rx);
        assert_eq!(r2.position, 2);
        // Now the server returns nothing → EOF, stop with what we have.
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r2.stream_id,
            Vec::new(),
        ));
        assert!(rx.try_recv().is_err());
        assert_eq!(std::fs::read(dir.path().join("short.bin")).unwrap(), b"aa");
    }

    #[test]
    fn directory_structure_is_recreated() {
        // A copied folder (with a nested file) keeps its tree under the shared
        // folder instead of being flattened (#1780).
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(
            &[
                FileDescriptor::new("folder").with_attributes(ClipboardFileAttributes::DIRECTORY),
                FileDescriptor::new("nested.txt")
                    .with_relative_path("folder")
                    .with_file_size(3),
            ],
            None,
        );
        // The directory is created immediately (no request); the nested file is
        // fetched into it.
        assert!(dir.path().join("folder").is_dir());
        let req = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            req.stream_id,
            b"abc".to_vec(),
        ));
        assert_eq!(
            std::fs::read(dir.path().join("folder").join("nested.txt")).unwrap(),
            b"abc"
        );
    }

    #[test]
    fn deep_relative_path_creates_missing_parents() {
        // A file whose relative path has no explicit directory descriptors still
        // lands: the intermediate folders are created on demand (#1780).
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(
            &[FileDescriptor::new("leaf.txt")
                .with_relative_path("a\\b\\c")
                .with_file_size(2)],
            None,
        );
        let req = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            req.stream_id,
            b"hi".to_vec(),
        ));
        assert_eq!(
            std::fs::read(dir.path().join("a").join("b").join("c").join("leaf.txt")).unwrap(),
            b"hi"
        );
    }

    #[test]
    fn a_traversal_relative_path_is_rejected_per_entry() {
        // Sandbox validation is per entry, not just the collection root: a
        // descriptor trying to escape via `..` is dropped, not written (#1780).
        let (mut backend, rx, dir) = backend_with_download();
        backend.on_remote_file_list(
            &[FileDescriptor::new("evil.txt")
                .with_relative_path("..")
                .with_file_size(4)],
            None,
        );
        // Rejected → no request, nothing created outside the sandbox.
        assert!(rx.try_recv().is_err());
        assert!(!dir.path().parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn a_device_name_in_a_subdirectory_is_rejected() {
        // A reserved device name on any component (not just the leaf) is refused.
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_file_list(
            &[FileDescriptor::new("ok.txt")
                .with_relative_path("CON")
                .with_file_size(4)],
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

    // --- Serving local files (#1778) ---

    /// A backend that serves the shared folder to the remote, over a fresh temp
    /// dir. `view_only` gates advertising/serving local files.
    fn backend_serving(
        view_only: bool,
    ) -> (
        SidecarClipboardBackend,
        Receiver<ClipboardEvent>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // Empty host-clipboard reader keeps these #1778 tests deterministic; the
        // #1779 tests below inject their own reader.
        let (backend, rx) =
            SidecarClipboardBackend::with_host_clip_reader(Some(root), view_only, Vec::new);
        (backend, rx, dir)
    }

    /// Drain the next queued event, failing otherwise.
    fn next_event(rx: &Receiver<ClipboardEvent>) -> ClipboardEvent {
        rx.try_recv().expect("expected a queued clipboard event")
    }

    #[test]
    fn collects_offerable_files_sorted_skipping_device_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("b.txt"), b"bbb").unwrap();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::create_dir(root.join("subdir")).unwrap();

        let offered = collect_offerable_files(&root);
        // Files come back name-sorted; the (empty) directory is offered too (its
        // structure is preserved) but carries no size (#1780).
        let names: Vec<_> = offered.iter().map(|f| f.name.clone()).collect();
        assert_eq!(
            names,
            vec![
                "a.txt".to_string(),
                "b.txt".to_string(),
                "subdir".to_string()
            ]
        );
        assert_eq!(offered[0].size, 1);
        assert_eq!(offered[1].size, 3);
        assert!(offered[2].is_dir);
        // Every path stays inside the sandbox root.
        assert!(offered.iter().all(|f| f.path.starts_with(&root)));
    }

    #[test]
    fn recursive_directory_is_offered_with_relative_paths() {
        // A nested share is advertised as a directory entry plus its files, each
        // carrying its `\`-separated relative path so the remote rebuilds the tree.
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("inner.txt"), b"hi").unwrap();
        std::fs::write(root.join("top.txt"), b"t").unwrap();

        let offered = collect_offerable_files(&root);
        // Depth-first: "sub" (dir), then "sub/inner.txt", then "top.txt".
        assert_eq!(offered[0].name, "sub");
        assert!(offered[0].is_dir);
        assert_eq!(offered[0].relative_path, None);
        assert_eq!(offered[1].name, "inner.txt");
        assert_eq!(offered[1].relative_path.as_deref(), Some("sub"));
        assert_eq!(offered[2].name, "top.txt");
        assert_eq!(offered[2].relative_path, None);

        // The descriptor for the nested file advertises the directory portion.
        let descriptor = offered_descriptor(&offered[1]);
        assert_eq!(descriptor.relative_path.as_deref(), Some("sub"));
        // And the directory descriptor is flagged as such.
        let dir_descriptor = offered_descriptor(&offered[0]);
        assert!(dir_descriptor
            .attributes
            .unwrap()
            .contains(ClipboardFileAttributes::DIRECTORY));
    }

    #[test]
    fn large_local_file_is_offered_and_served_bounded() {
        // Large files are no longer skipped from the offer (#1780); a RANGE serve
        // never returns more than one chunk, keeping serve memory bounded.
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("ok.txt"), b"ok").unwrap();
        let big = root.join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(CLIPBOARD_CHUNK_BYTES + 1)
            .unwrap();

        let offered = collect_offerable_files(&root);
        let names: Vec<_> = offered.iter().map(|f| f.name.clone()).collect();
        assert_eq!(names, vec!["big.bin".to_string(), "ok.txt".to_string()]);
        // A single RANGE response over the whole advertised size is truncated to
        // one chunk, never the whole large file.
        let bytes = read_file_range(
            &big,
            0,
            u32::try_from(CLIPBOARD_CHUNK_BYTES + 1).unwrap_or(u32::MAX),
        )
        .unwrap();
        assert_eq!(bytes.len() as u64, CLIPBOARD_CHUNK_BYTES);
    }

    #[test]
    fn advertises_local_files_when_serving_and_share_non_empty() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("doc.txt"), b"hello").unwrap();

        backend.on_request_format_list();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].name, "doc.txt");
                assert_eq!(files[0].file_size, Some(5));
            }
            other => panic!("expected AdvertiseFiles, got {other:?}"),
        }
    }

    #[test]
    fn advertises_text_when_share_is_empty() {
        let (mut backend, rx, _dir) = backend_serving(false);
        backend.on_request_format_list();
        // No files to offer → fall back to the text advertisement.
        assert_eq!(next_event(&rx), ClipboardEvent::AdvertiseLocal);
    }

    #[test]
    fn view_only_never_advertises_local_files() {
        let (mut backend, rx, dir) = backend_serving(true);
        std::fs::write(dir.path().join("secret.txt"), b"nope").unwrap();
        backend.on_request_format_list();
        // View-only must never push local files; it falls back to text (empty).
        assert_eq!(next_event(&rx), ClipboardEvent::AdvertiseLocal);
    }

    // --- Re-advertise on shared-folder change (#1788) ---

    #[test]
    fn readvertise_offers_a_file_added_after_connect() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("first.txt"), b"1").unwrap();
        // Initial offer at connect.
        backend.on_request_format_list();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => assert_eq!(files.len(), 1),
            other => panic!("expected AdvertiseFiles, got {other:?}"),
        }
        // A file dropped in *after* connecting is picked up on the next
        // re-advertise, so the remote sees it without reconnecting (#1788).
        std::fs::write(dir.path().join("second.txt"), b"2").unwrap();
        backend.readvertise_local_files();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => {
                let names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
                assert_eq!(
                    names,
                    vec!["first.txt".to_string(), "second.txt".to_string()]
                );
            }
            other => panic!("expected AdvertiseFiles, got {other:?}"),
        }
    }

    #[test]
    fn readvertise_falls_back_to_text_when_the_share_empties() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("gone.txt"), b"x").unwrap();
        backend.on_request_format_list();
        let _ = next_event(&rx); // consume the initial AdvertiseFiles
        std::fs::remove_file(dir.path().join("gone.txt")).unwrap();
        backend.readvertise_local_files();
        // The stale file list is replaced by a (text) advertisement so the remote
        // no longer offers the removed file.
        assert_eq!(next_event(&rx), ClipboardEvent::AdvertiseLocal);
    }

    #[test]
    fn view_only_never_readvertises_local_files() {
        let (mut backend, rx, dir) = backend_serving(true);
        std::fs::write(dir.path().join("secret.txt"), b"nope").unwrap();
        backend.readvertise_local_files();
        // View-only offered nothing to begin with, so a change emits nothing at
        // all — not even a text advertisement.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn text_only_bridge_never_readvertises() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
        backend.readvertise_local_files();
        assert!(rx.try_recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn readvertise_skips_a_symlink_escaping_the_sandbox() {
        let (mut backend, rx, dir) = backend_serving(false);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"s").unwrap();
        // A symlink inside the share pointing outside the sandbox must never be
        // offered on re-enumeration.
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();
        std::fs::write(dir.path().join("real.txt"), b"r").unwrap();
        backend.readvertise_local_files();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => {
                let names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
                assert_eq!(names, vec!["real.txt".to_string()]);
            }
            other => panic!("expected AdvertiseFiles, got {other:?}"),
        }
    }

    #[test]
    fn serves_size_then_range_for_an_offered_file() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("data.txt"), b"abcdef").unwrap();
        backend.on_request_format_list();
        let _ = next_event(&rx); // consume AdvertiseFiles

        // Server asks for the size while pasting.
        backend.on_file_contents_request(size_request(7, 0));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert_eq!(resp.stream_id(), 7);
                assert_eq!(resp.data_as_size().unwrap(), 6);
            }
            other => panic!("expected ProvideFileContents (size), got {other:?}"),
        }

        // Then the bytes.
        backend.on_file_contents_request(range_request(8, 0, 0, 6));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert_eq!(resp.stream_id(), 8);
                assert!(!resp.is_error());
                assert_eq!(resp.data(), b"abcdef");
            }
            other => panic!("expected ProvideFileContents (range), got {other:?}"),
        }
    }

    #[test]
    fn serves_a_partial_range_from_the_middle() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("data.txt"), b"abcdef").unwrap();
        backend.on_request_format_list();
        let _ = next_event(&rx);

        // Bytes [2, 5): "cde".
        let req = FileContentsRequest {
            stream_id: 3,
            index: 0,
            flags: FileContentsFlags::RANGE,
            position: 2,
            requested_size: 3,
            data_id: None,
        };
        backend.on_file_contents_request(req);
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => assert_eq!(resp.data(), b"cde"),
            other => panic!("expected ProvideFileContents, got {other:?}"),
        }
    }

    #[test]
    fn range_past_eof_is_truncated() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("data.txt"), b"abc").unwrap();
        backend.on_request_format_list();
        let _ = next_event(&rx);

        // Ask for more than the file holds → returns only what exists.
        backend.on_file_contents_request(range_request(1, 0, 0, 999));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert!(!resp.is_error());
                assert_eq!(resp.data(), b"abc");
            }
            other => panic!("expected ProvideFileContents, got {other:?}"),
        }
    }

    #[test]
    fn unknown_index_yields_an_error_response() {
        let (mut backend, rx, dir) = backend_serving(false);
        std::fs::write(dir.path().join("only.txt"), b"x").unwrap();
        backend.on_request_format_list();
        let _ = next_event(&rx);

        // Index 5 was never offered.
        backend.on_file_contents_request(size_request(9, 5));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert!(resp.is_error());
                assert_eq!(resp.stream_id(), 9);
            }
            other => panic!("expected an error ProvideFileContents, got {other:?}"),
        }
    }

    #[test]
    fn view_only_ignores_a_file_contents_request() {
        let (mut backend, rx, dir) = backend_serving(true);
        std::fs::write(dir.path().join("secret.txt"), b"nope").unwrap();
        // Even a stray request serves nothing in a view-only session.
        backend.on_file_contents_request(range_request(1, 0, 0, 4));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn text_only_bridge_ignores_a_file_contents_request() {
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
        backend.on_file_contents_request(range_request(1, 0, 0, 4));
        assert!(rx.try_recv().is_err());
    }

    // --- Host-clipboard files (#1779) ---

    /// A serving backend whose host-clipboard reader is stubbed to return
    /// `paths`. The shared folder (`dir`) is separate, so tests can prove the
    /// host clipboard wins over — or falls back to — the folder.
    fn backend_serving_with_host(
        view_only: bool,
        paths: Vec<PathBuf>,
    ) -> (
        SidecarClipboardBackend,
        Receiver<ClipboardEvent>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let (backend, rx) =
            SidecarClipboardBackend::with_host_clip_reader(Some(root), view_only, move || {
                paths.clone()
            });
        (backend, rx, dir)
    }

    #[test]
    fn build_host_file_offer_keeps_regular_files_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let z = dir.path().join("z.bin");
        std::fs::write(&a, b"aaa").unwrap();
        std::fs::write(&z, b"zzzzz").unwrap();

        // Clipboard order is z, a — preserved (not sorted).
        let (descriptors, offered) =
            build_host_file_offer(&[z.clone(), a.clone()]).expect("two regular files remain");
        let names: Vec<_> = offered.iter().map(|f| f.name.clone()).collect();
        assert_eq!(names, vec!["z.bin".to_string(), "a.txt".to_string()]);
        assert_eq!(offered[0].path, z);
        assert_eq!(offered[1].path, a);
        assert_eq!(descriptors[0].file_size, Some(5));
        assert_eq!(descriptors[1].file_size, Some(3));
    }

    #[test]
    fn build_host_file_offer_recurses_a_copied_directory() {
        // Copying a folder in the file manager advertises the folder and its
        // contents, each carrying a relative path rooted at the folder name (#1780).
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(folder.join("src")).unwrap();
        std::fs::write(folder.join("src").join("main.rs"), b"fn main(){}").unwrap();
        std::fs::write(folder.join("readme.md"), b"hi").unwrap();

        let (_descriptors, offered) =
            build_host_file_offer(std::slice::from_ref(&folder)).expect("the folder is offered");
        // Top-level folder first, then its name-sorted contents depth-first.
        assert_eq!(offered[0].name, "project");
        assert!(offered[0].is_dir);
        assert_eq!(offered[0].relative_path, None);
        assert_eq!(offered[1].name, "readme.md");
        assert_eq!(offered[1].relative_path.as_deref(), Some("project"));
        assert!(!offered[1].is_dir);
        assert_eq!(offered[2].name, "src");
        assert!(offered[2].is_dir);
        assert_eq!(offered[2].relative_path.as_deref(), Some("project"));
        assert_eq!(offered[3].name, "main.rs");
        assert_eq!(offered[3].relative_path.as_deref(), Some("project\\src"));
        // The nested file is served from its real path.
        assert_eq!(offered[3].path, folder.join("src").join("main.rs"));
    }

    #[test]
    fn build_host_file_offer_dedupes_basenames_from_different_dirs() {
        let d1 = tempfile::tempdir().unwrap();
        let d2 = tempfile::tempdir().unwrap();
        let p1 = d1.path().join("report.pdf");
        let p2 = d2.path().join("report.pdf");
        std::fs::write(&p1, b"1").unwrap();
        std::fs::write(&p2, b"2").unwrap();

        let (_descriptors, offered) = build_host_file_offer(&[p1, p2]).expect("both files offered");
        // Same basename from two folders → the second is disambiguated.
        assert_eq!(offered[0].name, "report.pdf");
        assert_eq!(offered[1].name, "report (1).pdf");
    }

    #[test]
    fn build_host_file_offer_offers_large_files_and_skips_missing() {
        // Large files are offered now that serving streams them (#1780); a missing
        // path is still skipped.
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("ok.txt");
        std::fs::write(&ok, b"ok").unwrap();
        let big = dir.path().join("big.bin");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(CLIPBOARD_CHUNK_BYTES + 1)
            .unwrap();
        let missing = dir.path().join("gone.txt");

        let (_d, offered) = build_host_file_offer(&[big, missing, ok.clone()])
            .expect("the large and small files survive");
        let names: Vec<_> = offered.iter().map(|f| f.name.clone()).collect();
        assert_eq!(names, vec!["big.bin".to_string(), "ok.txt".to_string()]);
        assert_eq!(offered[0].size, CLIPBOARD_CHUNK_BYTES + 1);
    }

    #[test]
    fn build_host_file_offer_none_when_nothing_offerable() {
        // A missing path alone, and an empty list, offer nothing.
        let dir = tempfile::tempdir().unwrap();
        assert!(build_host_file_offer(&[dir.path().join("gone.txt")]).is_none());
        assert!(build_host_file_offer(&[]).is_none());
    }

    #[test]
    fn host_clipboard_files_win_over_the_shared_folder() {
        let host_dir = tempfile::tempdir().unwrap();
        let hosted = host_dir.path().join("copied.txt");
        std::fs::write(&hosted, b"copied bytes").unwrap();

        let (mut backend, rx, dir) = backend_serving_with_host(false, vec![hosted]);
        // The shared folder also has a file, but the host clipboard takes
        // precedence (most-recent local action wins).
        std::fs::write(dir.path().join("folder-file.txt"), b"in folder").unwrap();

        backend.on_request_format_list();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].name, "copied.txt");
                assert_eq!(files[0].file_size, Some(12));
            }
            other => panic!("expected AdvertiseFiles from the host clipboard, got {other:?}"),
        }
    }

    #[test]
    fn serves_a_host_clipboard_file_from_its_real_path() {
        let host_dir = tempfile::tempdir().unwrap();
        let hosted = host_dir.path().join("doc.txt");
        std::fs::write(&hosted, b"abcdef").unwrap();

        let (mut backend, rx, _dir) = backend_serving_with_host(false, vec![hosted]);
        backend.on_request_format_list();
        let _ = next_event(&rx); // consume AdvertiseFiles

        // Size, then the bytes — served from the real host-clipboard path.
        backend.on_file_contents_request(size_request(7, 0));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert_eq!(resp.stream_id(), 7);
                assert_eq!(resp.data_as_size().unwrap(), 6);
            }
            other => panic!("expected ProvideFileContents (size), got {other:?}"),
        }
        backend.on_file_contents_request(range_request(8, 0, 0, 6));
        match next_event(&rx) {
            ClipboardEvent::ProvideFileContents(resp) => {
                assert!(!resp.is_error());
                assert_eq!(resp.data(), b"abcdef");
            }
            other => panic!("expected ProvideFileContents (range), got {other:?}"),
        }
    }

    #[test]
    fn view_only_never_advertises_host_clipboard_files() {
        let host_dir = tempfile::tempdir().unwrap();
        let hosted = host_dir.path().join("secret.txt");
        std::fs::write(&hosted, b"nope").unwrap();

        let (mut backend, rx, _dir) = backend_serving_with_host(true, vec![hosted]);
        backend.on_request_format_list();
        // View-only pushes nothing local, host clipboard included → text fallback.
        assert_eq!(next_event(&rx), ClipboardEvent::AdvertiseLocal);
    }

    #[test]
    fn empty_host_clipboard_falls_back_to_the_shared_folder() {
        let (mut backend, rx, dir) = backend_serving_with_host(false, Vec::new());
        std::fs::write(dir.path().join("folder-file.txt"), b"in folder").unwrap();

        backend.on_request_format_list();
        match next_event(&rx) {
            ClipboardEvent::AdvertiseFiles(files) => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].name, "folder-file.txt");
            }
            other => panic!("expected the shared-folder offer, got {other:?}"),
        }
    }

    // --- Remote→host delayed rendering (#1793) ---

    /// A file-transfer backend with delayed rendering enabled.
    fn backend_delayed() -> (
        SidecarClipboardBackend,
        Receiver<ClipboardEvent>,
        tempfile::TempDir,
    ) {
        let (mut backend, rx, dir) = backend_with_download();
        backend.set_delayed_render(true);
        (backend, rx, dir)
    }

    #[test]
    fn sanitize_descriptor_keeps_safe_paths_and_rejects_escapes() {
        // A plain file keeps its name/size and top-level (no relative path).
        let m = sanitize_descriptor(&FileDescriptor::new("a.txt").with_file_size(3), 0).unwrap();
        assert_eq!(m.name, "a.txt");
        assert_eq!(m.relative_path, None);
        assert_eq!(m.size, Some(3));
        assert!(!m.is_dir);
        assert_eq!(m.index, 0);

        // A nested file's `\`-relative path becomes a `/`-separated one; the
        // descriptor index is preserved as the fetch token.
        let nested = FileDescriptor::new("leaf.bin")
            .with_relative_path("dir\\sub")
            .with_file_size(1);
        let m = sanitize_descriptor(&nested, 5).unwrap();
        assert_eq!(m.name, "leaf.bin");
        assert_eq!(m.relative_path.as_deref(), Some("dir/sub"));
        assert_eq!(m.index, 5);

        // A directory descriptor is surfaced as a directory (no bytes).
        let d = FileDescriptor::new("folder").with_attributes(ClipboardFileAttributes::DIRECTORY);
        assert!(sanitize_descriptor(&d, 0).unwrap().is_dir);

        // Hostile paths are dropped: `..`, traversal in the relative path, a drive
        // letter / colon, and a reserved device name on any component.
        assert!(sanitize_descriptor(&FileDescriptor::new("..").with_file_size(1), 0).is_none());
        assert!(sanitize_descriptor(
            &FileDescriptor::new("evil").with_relative_path("..\\..\\etc"),
            0
        )
        .is_none());
        assert!(sanitize_descriptor(&FileDescriptor::new("C:").with_file_size(1), 0).is_none());
        assert!(sanitize_descriptor(
            &FileDescriptor::new("x").with_relative_path("C:\\Windows"),
            0
        )
        .is_none());
        assert!(sanitize_descriptor(&FileDescriptor::new("CON").with_file_size(1), 0).is_none());
    }

    #[test]
    fn delayed_render_surfaces_a_sanitized_list_without_downloading() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(
            &[
                FileDescriptor::new("doc.txt").with_file_size(5),
                // Hostile entry — dropped from the surfaced list.
                FileDescriptor::new("..").with_file_size(9),
                FileDescriptor::new("nested.bin")
                    .with_relative_path("d")
                    .with_file_size(2),
            ],
            None,
        );
        match next_event(&rx) {
            ClipboardEvent::SurfaceRemoteFiles(files) => {
                assert_eq!(files.len(), 2);
                assert_eq!(files[0].name, "doc.txt");
                assert_eq!(files[0].index, 0);
                assert_eq!(files[1].name, "nested.bin");
                assert_eq!(files[1].relative_path.as_deref(), Some("d"));
                // The original descriptor index (2) survives the dropped entry, so
                // it still keys the right file for a fetch.
                assert_eq!(files[1].index, 2);
            }
            other => panic!("expected SurfaceRemoteFiles, got {other:?}"),
        }
        // Delayed rendering never eagerly downloads: no file-contents request.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn eager_download_stays_the_default_without_delayed_render() {
        let (mut backend, rx, _dir) = backend_with_download();
        backend.on_remote_file_list(&[FileDescriptor::new("f.txt").with_file_size(3)], None);
        // The eager path issues a file-contents request, not a surface event.
        let req = next_request(&rx);
        assert!(req.flags.contains(FileContentsFlags::RANGE));
    }

    #[test]
    fn delayed_render_without_opt_in_surfaces_nothing() {
        // Delayed rendering is meaningless without the file-transfer opt-in (no
        // shared folder), so a remote copy surfaces nothing.
        let (mut backend, rx) = SidecarClipboardBackend::new(None, false);
        backend.set_delayed_render(true);
        backend.on_remote_file_list(&[FileDescriptor::new("a.txt").with_file_size(1)], None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn fetch_streams_a_file_to_the_host_in_bounded_chunks() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.set_chunk_bytes(4);
        backend.on_remote_file_list(&[FileDescriptor::new("big.bin").with_file_size(10)], None);
        let _ = next_event(&rx); // SurfaceRemoteFiles

        backend.fetch_remote_file(42, 0);

        // Chunk 1: a RANGE request bounded to the chunk size, streamed to the host.
        let r1 = next_request(&rx);
        assert_eq!(r1.position, 0);
        assert_eq!(r1.requested_size, 4);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r1.stream_id,
            b"aaaa".to_vec(),
        ));
        match next_event(&rx) {
            ClipboardEvent::ProvideRemoteFileChunk {
                request_id,
                position,
                data,
                last,
            } => {
                assert_eq!(request_id, 42);
                assert_eq!(position, 0);
                assert_eq!(data, b"aaaa");
                // Never more than one chunk in memory.
                assert!(data.len() as u64 <= 4);
                assert!(!last);
            }
            other => panic!("expected a streamed chunk, got {other:?}"),
        }

        // Chunk 2: [4, 8).
        let r2 = next_request(&rx);
        assert_eq!(r2.position, 4);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r2.stream_id,
            b"bbbb".to_vec(),
        ));
        let _ = next_event(&rx);

        // Chunk 3: [8, 10) — only the remaining 2 bytes, marked last.
        let r3 = next_request(&rx);
        assert_eq!(r3.position, 8);
        assert_eq!(r3.requested_size, 2);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            r3.stream_id,
            b"cc".to_vec(),
        ));
        match next_event(&rx) {
            ClipboardEvent::ProvideRemoteFileChunk {
                position,
                data,
                last,
                ..
            } => {
                assert_eq!(position, 8);
                assert_eq!(data, b"cc");
                assert!(last);
            }
            other => panic!("expected the final chunk, got {other:?}"),
        }
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn fetch_resolves_an_unknown_size_then_streams() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(&[FileDescriptor::new("data.bin")], None);
        let _ = next_event(&rx); // surface (no advertised size)

        backend.fetch_remote_file(7, 0);
        let size_req = next_request(&rx);
        assert!(size_req.flags.contains(FileContentsFlags::SIZE));
        backend.on_file_contents_response(FileContentsResponse::new_size_response(
            size_req.stream_id,
            3,
        ));
        let range_req = next_request(&rx);
        assert!(range_req.flags.contains(FileContentsFlags::RANGE));
        assert_eq!(range_req.requested_size, 3);
        backend.on_file_contents_response(FileContentsResponse::new_data_response(
            range_req.stream_id,
            b"abc".to_vec(),
        ));
        match next_event(&rx) {
            ClipboardEvent::ProvideRemoteFileChunk {
                request_id,
                data,
                last,
                ..
            } => {
                assert_eq!(request_id, 7);
                assert_eq!(data, b"abc");
                assert!(last);
            }
            other => panic!("expected the streamed chunk, got {other:?}"),
        }
    }

    #[test]
    fn fetch_of_an_empty_file_yields_an_empty_final_chunk() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(&[FileDescriptor::new("empty.txt").with_file_size(0)], None);
        let _ = next_event(&rx); // surface

        backend.fetch_remote_file(1, 0);
        match next_event(&rx) {
            ClipboardEvent::ProvideRemoteFileChunk {
                position,
                data,
                last,
                ..
            } => {
                assert_eq!(position, 0);
                assert!(data.is_empty());
                assert!(last);
            }
            other => panic!("expected an empty final chunk, got {other:?}"),
        }
        // An empty file needs no byte-range request.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn fetch_rejects_unknown_directory_and_not_enabled() {
        // An index the remote never advertised is refused.
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(&[FileDescriptor::new("a.txt").with_file_size(1)], None);
        let _ = next_event(&rx);
        backend.fetch_remote_file(1, 99);
        assert!(matches!(
            next_event(&rx),
            ClipboardEvent::RemoteFileError { request_id: 1, .. }
        ));

        // A directory index carries no bytes.
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(
            &[FileDescriptor::new("dir").with_attributes(ClipboardFileAttributes::DIRECTORY)],
            None,
        );
        let _ = next_event(&rx);
        backend.fetch_remote_file(2, 0);
        assert!(matches!(
            next_event(&rx),
            ClipboardEvent::RemoteFileError { request_id: 2, .. }
        ));

        // A backend that is not in delayed-render mode has surfaced nothing.
        let (mut backend, rx, _dir) = backend_with_download();
        backend.fetch_remote_file(3, 0);
        assert!(matches!(
            next_event(&rx),
            ClipboardEvent::RemoteFileError { request_id: 3, .. }
        ));
    }

    #[test]
    fn a_second_fetch_while_one_is_in_flight_is_rejected() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(
            &[
                FileDescriptor::new("a.bin").with_file_size(4),
                FileDescriptor::new("b.bin").with_file_size(4),
            ],
            None,
        );
        let _ = next_event(&rx);
        backend.fetch_remote_file(1, 0);
        let _ = next_request(&rx); // first fetch now in flight
        backend.fetch_remote_file(2, 1);
        assert!(matches!(
            next_event(&rx),
            ClipboardEvent::RemoteFileError { request_id: 2, .. }
        ));
    }

    #[test]
    fn a_remote_error_mid_fetch_terminates_and_frees_the_slot() {
        let (mut backend, rx, _dir) = backend_delayed();
        backend.on_remote_file_list(&[FileDescriptor::new("a.bin").with_file_size(4)], None);
        let _ = next_event(&rx);
        backend.fetch_remote_file(5, 0);
        let req = next_request(&rx);
        backend.on_file_contents_response(FileContentsResponse::new_error(req.stream_id));
        assert!(matches!(
            next_event(&rx),
            ClipboardEvent::RemoteFileError { request_id: 5, .. }
        ));
        // The in-flight slot was freed, so a fresh fetch can proceed.
        backend.fetch_remote_file(6, 0);
        let req2 = next_request(&rx);
        assert!(req2.flags.contains(FileContentsFlags::RANGE));
    }
}
