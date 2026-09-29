//! Local path → `file://` URI conversion shared by the Linux clipboard binding
//! (#1815) and the Linux native drag-out (#3492).
//!
//! Both hand a `text/uri-list` to a GTK/X11/Wayland file manager, which expects
//! RFC 8089 `file://` URIs with the path percent-encoded. An unencoded path
//! breaks on `#`/`?` (read as fragment/query), `%` (read as a bad escape),
//! spaces and non-ASCII names.

use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use percent_encoding::{percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// Percent-encoding set for a `file://` URI path: everything that is not an RFC
/// 3986 *unreserved* character (`ALPHA` / `DIGIT` / `-` / `.` / `_` / `~`) is
/// encoded, except `/`, which stays literal as the path separator. This matches
/// what file managers emit and what the clipboard sidecar's `parse_uri_list`
/// percent-decodes on the read side.
const PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Converts an absolute local `path` to a percent-encoded `file://` URI.
///
/// The raw path **bytes** are encoded (via [`std::os::unix::ffi::OsStrExt`]) so a
/// non-UTF-8 or non-ASCII filename survives losslessly as the UTF-8/byte sequence
/// its percent-encoding represents. An absolute path begins with `/`, so the
/// result is the empty-authority form `file:///abs/path`.
pub fn path_to_file_uri(path: &Path) -> String {
    let encoded = percent_encode(path.as_os_str().as_bytes(), PATH_ENCODE_SET);
    format!("file://{encoded}")
}
