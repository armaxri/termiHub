//! Multi-platform ("fat") plugin packages (PLG-011): target triples and the
//! host-side selection of a native backend library.
//!
//! A `.termihub-plugin` may carry its native backend for **several platforms**
//! at once. Each library lives under `backend/<target-triple>/` and the manifest
//! maps every supported Rust target triple to its in-package path:
//!
//! ```json
//! "terminalBackend": {
//!   "connectionType": "echo",
//!   "displayName": "Echo",
//!   "configSchema": {},
//!   "libraries": {
//!     "x86_64-unknown-linux-gnu": "backend/x86_64-unknown-linux-gnu/libecho_backend.so",
//!     "aarch64-apple-darwin": "backend/aarch64-apple-darwin/libecho_backend.dylib",
//!     "x86_64-pc-windows-msvc": "backend/x86_64-pc-windows-msvc/echo_backend.dll"
//!   }
//! }
//! ```
//!
//! The host selects the entry for **its own** target triple
//! ([`host_target_triple`]) and nothing else: the trust acknowledgment hash and
//! the signed-digest re-check are both computed over that selected library. A
//! package without an entry for the host triple is refused as "not available
//! for this platform". A package without a `libraries` map is a **legacy
//! single-platform** package (the library sits flat in `backend/`) and is
//! resolved exactly as before, by the platform's dynamic-library extension.

use std::path::{Component, Path};

/// The Rust target triple this host was compiled for (e.g.
/// `x86_64-unknown-linux-gnu`), forwarded from cargo's `TARGET` by
/// `core/build.rs`.
pub const HOST_TARGET_TRIPLE: &str = env!("TERMIHUB_TARGET_TRIPLE");

/// Maximum length of a target-triple key in a manifest `libraries` map.
pub const MAX_TARGET_TRIPLE_LEN: usize = 64;

/// Maximum length of an in-package library path in a manifest `libraries` map.
pub const MAX_LIBRARY_PATH_LEN: usize = 255;

/// The package subtree native libraries live in.
pub const BACKEND_DIR: &str = "backend";

/// The Rust target triple this host selects plugin libraries for.
#[must_use]
pub fn host_target_triple() -> &'static str {
    HOST_TARGET_TRIPLE
}

/// Whether `triple` is an acceptable target-triple key: 1..=64 characters of
/// `[a-z0-9_.-]`, containing at least one `-`, and not starting with `.` or `-`.
///
/// This is deliberately a *shape* check, not a list of known targets: a plugin
/// may ship for a target this host has never heard of (it is simply never
/// selected). The shape keeps the key safe to use as a directory name.
#[must_use]
pub fn is_valid_target_triple(triple: &str) -> bool {
    !triple.is_empty()
        && triple.len() <= MAX_TARGET_TRIPLE_LEN
        && triple.contains('-')
        && !triple.starts_with(['.', '-'])
        && triple.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

/// Whether `path` is an acceptable in-package library path: a `/`-separated,
/// purely relative path of normal components under `backend/`, with at least one
/// component below it, no `\`, no `.`/`..`, no empty segments and no dotfiles.
#[must_use]
pub fn is_valid_library_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_LIBRARY_PATH_LEN || path.contains('\\') {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 || segments[0] != BACKEND_DIR {
        return false;
    }
    let normal = segments.iter().all(|s| {
        !s.is_empty()
            && !s.starts_with('.')
            && Path::new(s)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
    });
    normal && !Path::new(path).is_absolute()
}

/// The dynamic-library file name cargo produces for a `cdylib` whose `[lib]`
/// name is `lib_base` when built for `triple`: `<base>.dll` on Windows,
/// `lib<base>.dylib` on Apple targets, `lib<base>.so` everywhere else.
///
/// Mirrors the naming in `scripts/package-plugin.{sh,cmd}`.
#[must_use]
pub fn library_file_name_for_triple(lib_base: &str, triple: &str) -> String {
    if triple.contains("windows") {
        format!("{lib_base}.dll")
    } else if triple.contains("apple") || triple.contains("darwin") {
        format!("lib{lib_base}.dylib")
    } else {
        format!("lib{lib_base}.so")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_triple_is_a_valid_triple() {
        assert!(
            is_valid_target_triple(host_target_triple()),
            "build.rs must forward a well-formed triple, got `{}`",
            host_target_triple()
        );
    }

    #[test]
    fn host_triple_matches_the_compile_target() {
        let t = host_target_triple();
        assert!(t.contains(std::env::consts::ARCH) || t.starts_with("arm"));
        let os_hint = match std::env::consts::OS {
            "macos" => "apple",
            other => other,
        };
        assert!(t.contains(os_hint), "`{t}` should name the OS `{os_hint}`");
    }

    #[test]
    fn triple_shape_is_enforced() {
        for ok in [
            "x86_64-unknown-linux-gnu",
            "aarch64-apple-darwin",
            "x86_64-pc-windows-msvc",
            "armv7-unknown-linux-gnueabihf",
            "thumbv7em-none-eabi",
        ] {
            assert!(is_valid_target_triple(ok), "{ok}");
        }
        for bad in [
            "",
            "linux",
            "X86_64-unknown-linux-gnu",
            "../etc",
            "a/b-c",
            "-x86",
            ".x-y",
            "x86_64 linux-gnu",
            &"a-".repeat(40),
        ] {
            assert!(!is_valid_target_triple(bad), "{bad}");
        }
    }

    #[test]
    fn library_path_shape_is_enforced() {
        assert!(is_valid_library_path(
            "backend/x86_64-unknown-linux-gnu/libecho.so"
        ));
        assert!(is_valid_library_path("backend/libecho.so"));
        for bad in [
            "",
            "backend",
            "backend/",
            "frontend/x.so",
            "/backend/x.so",
            "backend/../x.so",
            "backend/./x.so",
            "backend//x.so",
            "backend\\x.so",
            "backend/.hidden/x.so",
        ] {
            assert!(!is_valid_library_path(bad), "{bad}");
        }
    }

    #[test]
    fn library_names_follow_each_platform_convention() {
        assert_eq!(
            library_file_name_for_triple("echo_backend", "x86_64-pc-windows-msvc"),
            "echo_backend.dll"
        );
        assert_eq!(
            library_file_name_for_triple("echo_backend", "aarch64-apple-darwin"),
            "libecho_backend.dylib"
        );
        assert_eq!(
            library_file_name_for_triple("echo_backend", "x86_64-unknown-linux-gnu"),
            "libecho_backend.so"
        );
    }
}
