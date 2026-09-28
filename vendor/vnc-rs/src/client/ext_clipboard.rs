//! RFB Extended Clipboard pseudo-encoding (termiHub fork, #3472 / PROD-021).
//!
//! The standard `ServerCutText` / `ClientCutText` messages carry Latin-1 text
//! only. A client that lists pseudo-encoding `0xC0A1E5CE` in `SetEncodings`
//! tells the server it understands the *extended* form: the same message types
//! with a **negative** length, whose `|length|` bytes start with a `U32` flags
//! word. Its low 16 bits name clipboard formats, its top 8 bits one action:
//!
//! | Bit | Format | Bit | Action    | Payload after the flags                     |
//! |-----|--------|-----|-----------|---------------------------------------------|
//! | 0   | text   | 24  | `caps`    | one `U32` max size per format bit set       |
//! | 1   | rtf    | 25  | `request` | none — "provide these formats"              |
//! | 2   | html   | 26  | `peek`    | none — "notify me what you have"            |
//! | 3   | dib    | 27  | `notify`  | none — "I now have these formats"           |
//! | 4   | files  | 28  | `provide` | zlib: per format bit, `U32` size + data     |
//!
//! `text` is UTF-8 with CRLF line endings and a terminating NUL; `dib` is a
//! Microsoft device-independent bitmap (a `BITMAPINFO` + pixels, no file
//! header). Each `provide` payload is its own complete zlib stream.
//!
//! ## Opt-in
//!
//! Nothing here runs unless the consumer adds
//! [`VncEncoding::ExtendedClipboardPseudo`](crate::VncEncoding) to its encodings.
//! Without it a negative length is never interpreted (the legacy path treats it
//! as an oversize `u32` and skips it), and even with it the extended form is only
//! *sent* once the server has announced its own capabilities — a server that does
//! not implement the extension never does, so the client stays on the #3469
//! Latin-1 path.
//!
//! ## Bounds (same philosophy as the frame bounds guard)
//!
//! Every length is server-chosen and untrusted:
//!
//! - the wire payload is capped at [`MAX_EXT_CLIPBOARD_WIRE_BYTES`]; a larger one
//!   is skipped in bounded chunks without being buffered;
//! - each format's announced *decompressed* size is checked against its cap
//!   ([`MAX_EXT_CLIPBOARD_TEXT_BYTES`], [`MAX_CLIPBOARD_DIB_BYTES`]) **before** a
//!   byte of it is buffered, and the buffer grows only with data that actually
//!   decompressed;
//! - all formats together may decompress at most
//!   [`MAX_EXT_CLIPBOARD_DECOMPRESSED_BYTES`], including formats this client
//!   skips (rtf, html, files), so a zlib bomb costs bounded CPU as well as memory.
//!
//! A malformed or over-cap message is fully consumed from the socket (the stream
//! stays in sync) and dropped with a warning; it does not end the session.
//!
//! ## The `files` format
//!
//! Evaluated for #3472 and **not implemented**. The community RFB specification
//! reserves bit 4 for files but defines no payload layout for it (no file list,
//! no names, no chunking or delayed transfer), and neither TigerVNC nor
//! libvncserver sends or accepts it, so there is nothing interoperable to parse
//! or emit. Implementing a guessed layout would mean accepting server-chosen
//! file names and sizes with no specification to validate them against. The
//! client neither advertises nor requests `files`; a `provide` that carries it
//! is skipped within the decompression budget.

use std::io::Read;

use crate::{ClipboardCapabilities, VncEncoding, VncError, VncEvent};

/// Wire value of the Extended Clipboard pseudo-encoding (`-1063131698`).
pub(crate) const ENCODING_EXTENDED_CLIPBOARD: i32 = 0xC0A1_E5CE_u32 as i32;

/// Plain UTF-8 text (CRLF line endings, NUL-terminated).
pub(crate) const FORMAT_TEXT: u32 = 1 << 0;
/// Rich Text Format — never requested; skipped if provided.
#[cfg_attr(not(test), allow(dead_code))] // named for the tests and docs
pub(crate) const FORMAT_RTF: u32 = 1 << 1;
/// HTML clipboard fragment — never requested; skipped if provided.
#[cfg_attr(not(test), allow(dead_code))] // named for the tests and docs
pub(crate) const FORMAT_HTML: u32 = 1 << 2;
/// Microsoft device-independent bitmap.
pub(crate) const FORMAT_DIB: u32 = 1 << 3;
/// Reserved by the specification without a defined layout; see the module docs.
#[cfg_attr(not(test), allow(dead_code))] // named for the tests and docs
pub(crate) const FORMAT_FILES: u32 = 1 << 4;
/// All 16 format bits.
pub(crate) const FORMAT_MASK: u32 = 0x0000_FFFF;

/// Capability announcement.
pub(crate) const ACTION_CAPS: u32 = 1 << 24;
/// Ask the peer to `provide` the listed formats.
pub(crate) const ACTION_REQUEST: u32 = 1 << 25;
/// Ask the peer to `notify` what it currently has.
pub(crate) const ACTION_PEEK: u32 = 1 << 26;
/// Announce the formats now on the sender's clipboard.
pub(crate) const ACTION_NOTIFY: u32 = 1 << 27;
/// Carry clipboard data (zlib-compressed).
pub(crate) const ACTION_PROVIDE: u32 = 1 << 28;
/// The action byte.
pub(crate) const ACTION_MASK: u32 = 0xFF00_0000;

/// The actions this client implements, announced in its `caps` reply.
const CLIENT_ACTIONS: u32 = ACTION_REQUEST | ACTION_PEEK | ACTION_NOTIFY | ACTION_PROVIDE;

/// Largest extended-clipboard payload read off the wire (compressed). Larger
/// messages are skipped unbuffered. Sized for an incompressible maximum-size
/// DIB plus a text payload.
pub(crate) const MAX_EXT_CLIPBOARD_WIRE_BYTES: u32 = 64 * 1024 * 1024;

/// Largest decompressed `text` accepted — the legacy `ServerCutText` cap.
pub(crate) const MAX_EXT_CLIPBOARD_TEXT_BYTES: u32 = super::messages::MAX_SERVER_CUT_TEXT_BYTES;

/// Largest decompressed `dib` accepted: 32 MiB of pixels (a 4K screenshot) plus
/// room for the largest header, masks and a colour table. Equal to termiHub
/// core's `MAX_DIB_BYTES`, which re-checks it when converting to RGBA.
pub const MAX_CLIPBOARD_DIB_BYTES: u32 = 32 * 1024 * 1024 + 64 * 1024;

/// Total bytes one `provide` may decompress, across every format it carries.
pub(crate) const MAX_EXT_CLIPBOARD_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

/// A server capability announcement: the formats and actions it supports, and
/// per format the largest payload it accepts unsolicited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Caps {
    /// Format bits the sender handles.
    pub formats: u32,
    /// Action bits the sender implements.
    pub actions: u32,
    /// Max unsolicited size per format bit (index = bit number); 0 when unset.
    pub sizes: [u32; 16],
}

impl Caps {
    fn size_of(&self, format: u32) -> u32 {
        self.sizes[format.trailing_zeros() as usize & 15]
    }
}

/// Decoded data of a `provide`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Provide {
    /// `(format bit, data)` in format-bit order.
    pub items: Vec<(u32, Vec<u8>)>,
    /// Formats the message carried that were skipped: unwanted is not listed,
    /// only wanted ones over their cap or past the decompression budget.
    pub dropped: u32,
}

/// One extended-clipboard message (either direction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExtMsg {
    Caps(Caps),
    Request(u32),
    Peek,
    Notify(u32),
    Provide(Provide),
}

/// Why an extended-clipboard message was dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExtClipboardError {
    /// The payload ended before its flags / sizes / data did.
    Truncated,
    /// The zlib stream is corrupt.
    Zlib(String),
    /// No, or more than one, action bit — or an action this client does not know.
    UnknownAction(u32),
    /// The payload exceeded [`MAX_EXT_CLIPBOARD_WIRE_BYTES`].
    TooLarge(u32),
}

impl std::fmt::Display for ExtClipboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => f.write_str("truncated extended clipboard message"),
            Self::Zlib(e) => write!(f, "corrupt extended clipboard zlib stream: {e}"),
            Self::UnknownAction(a) => write!(f, "unknown extended clipboard action {a:#010x}"),
            Self::TooLarge(n) => write!(
                f,
                "extended clipboard payload of {n} bytes exceeds the \
                 {MAX_EXT_CLIPBOARD_WIRE_BYTES}-byte cap"
            ),
        }
    }
}

/// The format bits this client handles when `encodings` opts into the
/// extension, or `None` when it does not.
pub(crate) fn advertised_formats(encodings: &[VncEncoding]) -> Option<u32> {
    encodings.iter().find_map(|e| match e {
        VncEncoding::ExtendedClipboardPseudo { images } => {
            Some(FORMAT_TEXT | if *images { FORMAT_DIB } else { 0 })
        }
        _ => None,
    })
}

/// The decompressed-size cap for `format` if this client wants it.
fn format_cap(format: u32, wanted: u32) -> Option<u32> {
    if wanted & format == 0 {
        return None;
    }
    match format {
        FORMAT_TEXT => Some(MAX_EXT_CLIPBOARD_TEXT_BYTES),
        FORMAT_DIB => Some(MAX_CLIPBOARD_DIB_BYTES),
        _ => None,
    }
}

fn be_u32(bytes: &[u8], at: usize) -> Result<u32, ExtClipboardError> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or(ExtClipboardError::Truncated)
}

fn zlib_err(e: std::io::Error) -> ExtClipboardError {
    if e.kind() == std::io::ErrorKind::UnexpectedEof {
        ExtClipboardError::Truncated
    } else {
        ExtClipboardError::Zlib(e.to_string())
    }
}

/// Parse the `|length|` payload of an extended `ServerCutText`. `wanted` is the
/// format set this client handles; other formats in a `provide` are skipped.
pub(crate) fn parse(payload: &[u8], wanted: u32) -> Result<ExtMsg, ExtClipboardError> {
    let flags = be_u32(payload, 0)?;
    let formats = flags & FORMAT_MASK;
    let actions = flags & ACTION_MASK;
    let body = &payload[4..];
    if actions & ACTION_CAPS != 0 {
        let mut sizes = [0u32; 16];
        let mut at = 0;
        for (bit, size) in sizes.iter_mut().enumerate() {
            if formats & (1 << bit) != 0 {
                *size = be_u32(body, at)?;
                at += 4;
            }
        }
        return Ok(ExtMsg::Caps(Caps {
            formats,
            actions,
            sizes,
        }));
    }
    match actions {
        ACTION_REQUEST => Ok(ExtMsg::Request(formats)),
        ACTION_PEEK => Ok(ExtMsg::Peek),
        ACTION_NOTIFY => Ok(ExtMsg::Notify(formats)),
        ACTION_PROVIDE => parse_provide(formats, body, wanted).map(ExtMsg::Provide),
        other => Err(ExtClipboardError::UnknownAction(other)),
    }
}

fn parse_provide(formats: u32, body: &[u8], wanted: u32) -> Result<Provide, ExtClipboardError> {
    let mut zlib = flate2::read::ZlibDecoder::new(body);
    let mut budget = MAX_EXT_CLIPBOARD_DECOMPRESSED_BYTES;
    let mut provide = Provide::default();
    for bit in 0..16 {
        let format = 1u32 << bit;
        if formats & format == 0 {
            continue;
        }
        let mut size = [0u8; 4];
        zlib.read_exact(&mut size).map_err(zlib_err)?;
        let size = u32::from_be_bytes(size);
        if u64::from(size) > budget {
            // Past the budget the rest cannot be reached without decompressing
            // it: drop this and every later wanted format.
            provide.dropped |= formats & wanted & !(format - 1);
            break;
        }
        budget -= u64::from(size);
        let mut chunk = (&mut zlib).take(u64::from(size));
        match format_cap(format, wanted) {
            Some(cap) if size <= cap => {
                // Checked against the cap first; the buffer then only grows with
                // bytes that actually decompressed.
                let mut data = Vec::new();
                chunk.read_to_end(&mut data).map_err(zlib_err)?;
                if data.len() as u64 != u64::from(size) {
                    return Err(ExtClipboardError::Truncated);
                }
                provide.items.push((format, data));
            }
            cap => {
                let skipped = std::io::copy(&mut chunk, &mut std::io::sink()).map_err(zlib_err)?;
                if skipped != u64::from(size) {
                    return Err(ExtClipboardError::Truncated);
                }
                if cap.is_some() {
                    provide.dropped |= format;
                }
            }
        }
    }
    Ok(provide)
}

/// Encode `msg` as a complete extended `ClientCutText` message (type 6, negative
/// length, flags, payload).
pub(crate) fn encode(msg: &ExtMsg) -> Result<Vec<u8>, VncError> {
    let (flags, body) = match msg {
        ExtMsg::Caps(caps) => {
            let formats = caps.formats & FORMAT_MASK;
            let mut body = Vec::new();
            for (bit, size) in caps.sizes.iter().enumerate() {
                if formats & (1 << bit) != 0 {
                    body.extend_from_slice(&size.to_be_bytes());
                }
            }
            (ACTION_CAPS | (caps.actions & ACTION_MASK) | formats, body)
        }
        ExtMsg::Request(formats) => (ACTION_REQUEST | (formats & FORMAT_MASK), Vec::new()),
        ExtMsg::Peek => (ACTION_PEEK, Vec::new()),
        ExtMsg::Notify(formats) => (ACTION_NOTIFY | (formats & FORMAT_MASK), Vec::new()),
        ExtMsg::Provide(provide) => {
            let mut items: Vec<&(u32, Vec<u8>)> = provide.items.iter().collect();
            items.sort_by_key(|(format, _)| *format);
            let mut formats = 0;
            let mut plain = Vec::new();
            for (format, data) in items {
                if !format.is_power_of_two() || format & FORMAT_MASK == 0 || formats & format != 0
                {
                    return Err(VncError::General(format!(
                        "invalid clipboard format {format:#x} in provide"
                    )));
                }
                formats |= format;
                let size = u32::try_from(data.len()).map_err(|_| too_large())?;
                plain.extend_from_slice(&size.to_be_bytes());
                plain.extend_from_slice(data);
            }
            (ACTION_PROVIDE | formats, zlib_compress(&plain)?)
        }
    };
    let len = i32::try_from(4 + body.len()).map_err(|_| too_large())?;
    let mut out = Vec::with_capacity(12 + body.len());
    out.extend_from_slice(&[6, 0, 0, 0]);
    out.extend_from_slice(&(-len).to_be_bytes());
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

fn too_large() -> VncError {
    VncError::General("clipboard payload too large for RFB".to_string())
}

fn zlib_compress(data: &[u8]) -> Result<Vec<u8>, VncError> {
    use std::io::Write;
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data)?;
    Ok(enc.finish()?)
}

/// Encode text for the `text` format: UTF-8, every line ending (`\n`, `\r`,
/// `\r\n`) as CRLF, NUL-terminated.
pub(crate) fn encode_text(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 1);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                out.extend_from_slice(b"\r\n");
            }
            '\n' => out.extend_from_slice(b"\r\n"),
            // An embedded NUL would end the text early on the other side.
            '\0' => {}
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(0);
    out
}

/// Decode `text`-format data: cut at the first NUL, CRLF to LF, UTF-8 (a
/// non-conforming non-UTF-8 payload falls back to Latin-1, as on the legacy
/// path).
pub(crate) fn decode_text(mut data: Vec<u8>) -> String {
    if let Some(nul) = data.iter().position(|&b| b == 0) {
        data.truncate(nul);
    }
    super::messages::decode_cut_text(data).replace("\r\n", "\n")
}

/// What the client must do in response to a server message.
#[derive(Debug, Default)]
pub(crate) struct Reaction {
    /// Messages to send back to the server.
    pub replies: Vec<ExtMsg>,
    /// Events for the consumer.
    pub events: Vec<VncEvent>,
    /// Wanted formats the server offered but that were dropped (over a cap).
    pub dropped: u32,
}

/// The client side of the extended-clipboard exchange: the server's announced
/// capabilities and the local clipboard content the server may still request.
#[derive(Debug)]
pub(crate) struct ExtClipboardState {
    /// Formats this client handles (`None`: the extension is not advertised).
    wanted: Option<u32>,
    /// The server's capabilities; `None` until it announced them, and forever
    /// for a server without the extension.
    server: Option<Caps>,
    /// The local clipboard (`format`, encoded data) the server may request.
    local: Option<(u32, Vec<u8>)>,
}

impl ExtClipboardState {
    pub(crate) fn new(wanted: Option<u32>) -> Self {
        Self {
            wanted,
            server: None,
            local: None,
        }
    }

    /// Formats the extension carries between this client and the server:
    /// wanted here and announced there. 0 before the server's caps.
    fn shared_formats(&self) -> u32 {
        match (&self.server, self.wanted) {
            (Some(caps), Some(wanted)) => caps.formats & wanted,
            _ => 0,
        }
    }

    /// This client's capability announcement.
    fn client_caps(wanted: u32) -> Caps {
        let mut sizes = [0u32; 16];
        sizes[FORMAT_TEXT.trailing_zeros() as usize] = MAX_EXT_CLIPBOARD_TEXT_BYTES;
        if wanted & FORMAT_DIB != 0 {
            sizes[FORMAT_DIB.trailing_zeros() as usize] = MAX_CLIPBOARD_DIB_BYTES;
        }
        Caps {
            formats: wanted,
            actions: CLIENT_ACTIONS,
            sizes,
        }
    }

    /// React to a server extended-clipboard message.
    pub(crate) fn on_server(&mut self, msg: ExtMsg) -> Reaction {
        let mut reaction = Reaction::default();
        let Some(wanted) = self.wanted else {
            return reaction;
        };
        match msg {
            ExtMsg::Caps(caps) => {
                reaction.events.push(VncEvent::ClipboardCapabilities(
                    ClipboardCapabilities {
                        text: caps.formats & FORMAT_TEXT != 0,
                        images: caps.formats & wanted & FORMAT_DIB != 0,
                    },
                ));
                self.server = Some(caps);
                reaction
                    .replies
                    .push(ExtMsg::Caps(Self::client_caps(wanted)));
            }
            ExtMsg::Request(formats) => {
                if let Some((format, data)) = &self.local {
                    if formats & format != 0 {
                        reaction.replies.push(ExtMsg::Provide(Provide {
                            items: vec![(*format, data.clone())],
                            dropped: 0,
                        }));
                    }
                }
            }
            ExtMsg::Peek => {
                let available = self.local.as_ref().map_or(0, |(format, _)| *format);
                reaction.replies.push(ExtMsg::Notify(available));
            }
            ExtMsg::Notify(formats) => {
                // The server's clipboard changed: ours is no longer current.
                self.local = None;
                let want = formats & wanted;
                let can_request = self
                    .server
                    .as_ref()
                    .is_none_or(|caps| caps.actions & ACTION_REQUEST != 0);
                if want != 0 && can_request {
                    reaction.replies.push(ExtMsg::Request(want));
                }
            }
            ExtMsg::Provide(provide) => {
                self.local = None;
                reaction.dropped = provide.dropped;
                for (format, data) in provide.items {
                    match format {
                        FORMAT_TEXT => reaction.events.push(VncEvent::Text(decode_text(data))),
                        FORMAT_DIB => reaction.events.push(VncEvent::ClipboardDib(data)),
                        _ => {}
                    }
                }
            }
        }
        reaction
    }

    /// Announce local `format` data; `None` when the server cannot take it
    /// through the extension. Mirrors TigerVNC: an unsolicited `provide` when
    /// the data fits the server's announced size, else `notify` (the server
    /// requests it when it wants it), else a `provide` to a server that cannot
    /// be notified.
    fn announce(&mut self, format: u32, data: Vec<u8>) -> Option<ExtMsg> {
        if self.shared_formats() & format == 0 {
            return None;
        }
        let caps = self.server.as_ref()?;
        let fits = data.len() as u64 <= u64::from(caps.size_of(format));
        let msg = if caps.actions & ACTION_PROVIDE != 0 && fits {
            ExtMsg::Provide(Provide {
                items: vec![(format, data.clone())],
                dropped: 0,
            })
        } else if caps.actions & ACTION_NOTIFY != 0 {
            ExtMsg::Notify(format)
        } else if caps.actions & ACTION_PROVIDE != 0 {
            ExtMsg::Provide(Provide {
                items: vec![(format, data.clone())],
                dropped: 0,
            })
        } else {
            return None;
        };
        self.local = Some((format, data));
        Some(msg)
    }

    /// Local text copied: the extended message to send, or `None` to fall back
    /// to a legacy `ClientCutText`.
    pub(crate) fn on_local_text(&mut self, text: &str) -> Option<ExtMsg> {
        let msg = self.announce(FORMAT_TEXT, encode_text(text));
        if msg.is_none() {
            self.local = None;
        }
        msg
    }

    /// Local image (a DIB) copied: the extended message to send. Errors when the
    /// server did not announce `dib` (there is no legacy image clipboard).
    pub(crate) fn on_local_dib(&mut self, dib: Vec<u8>) -> Result<ExtMsg, VncError> {
        if dib.len() as u64 > u64::from(MAX_CLIPBOARD_DIB_BYTES) {
            return Err(VncError::General(format!(
                "clipboard image of {} bytes exceeds the {MAX_CLIPBOARD_DIB_BYTES}-byte cap",
                dib.len()
            )));
        }
        self.announce(FORMAT_DIB, dib).ok_or_else(|| {
            VncError::General("the VNC server does not accept clipboard images".to_string())
        })
    }
}

#[cfg(test)]
#[path = "ext_clipboard_tests.rs"]
mod tests;
