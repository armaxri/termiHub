//! The one naming scheme for published agent release assets (#4302).
//!
//! The desktop deploys the agent to a remote host by downloading (or finding
//! cached / bundled) `termihub-agent-<suffix>[.exe]`, and the agent's own
//! self-updater resolves the same asset from a GitHub release. Both used to
//! build that file name independently and drifted apart: the desktop asked for
//! `termihub-agent-windows-x64` while `release.yml` publishes
//! `termihub-agent-windows-x64.exe`, so every Windows deploy hit a 404 (audit
//! findings PKG2-002 / DUP2-009).
//!
//! Every producer and consumer of an agent asset name goes through this
//! module:
//!
//! - [`agent_asset_suffix`] maps an OS / architecture pair — in either the
//!   `std::env::consts` spelling (`linux` / `x86_64`) or the `uname -s` /
//!   `uname -m` / `%OS%` / `%PROCESSOR_ARCHITECTURE%` spelling (`Linux`,
//!   `Darwin`, `MINGW64_NT-10.0`, `Windows_NT` / `AMD64`) — to the platform
//!   suffix (`linux-x64`, `windows-arm64`, ...);
//! - [`agent_release_asset_name`] turns a suffix into the published file name
//!   (Windows binaries carry `.exe`);
//! - [`agent_checksum_asset_name`] / [`agent_signature_asset_name`] name the
//!   `.sha256` and `.sig` sidecars published next to it (#1350, #3213).
//!
//! The release and dev-build workflows publish exactly
//! [`agent_release_asset_names`]; `core/tests/agent_release_asset_contract.rs`
//! pins the workflow YAML to it.

/// Base name every agent release asset starts with.
pub const AGENT_ASSET_BASE: &str = "termihub-agent";

/// File-name extension of the SHA-256 checksum sidecar (`<asset>.sha256`).
pub const AGENT_CHECKSUM_EXT: &str = "sha256";

/// File-name extension of the Ed25519 signature sidecar (`<asset>.sig`).
///
/// Mirrors `agent_update_signature::SIGNATURE_EXT`, which is only compiled
/// behind the `agent-update-signing` feature.
pub const AGENT_SIGNATURE_EXT: &str = "sig";

/// Every platform suffix an agent binary is published for, in release order.
pub const AGENT_ASSET_SUFFIXES: &[&str] = &[
    "linux-x64",
    "linux-arm64",
    "linux-armv7",
    "macos-arm64",
    "macos-x64",
    "windows-x64",
    "windows-arm64",
];

/// Returns `true` if an OS string identifies a Windows host.
///
/// Recognizes `std::env::consts::OS` (`"windows"`), the `%OS%` value
/// (`"Windows_NT"`) reported by `cmd.exe` / PowerShell probing, and the
/// `uname -s` output of MinGW/MSYS/Cygwin shells (e.g. `"MINGW64_NT-10.0"`).
pub fn is_windows_os(os: &str) -> bool {
    let upper = os.to_ascii_uppercase();
    upper.starts_with("MINGW")
        || upper.starts_with("MSYS")
        || upper.starts_with("CYGWIN")
        || upper.starts_with("WINDOWS")
}

/// Map an OS / architecture pair to the published agent asset suffix.
///
/// Accepts both the `std::env::consts` spelling (`"linux"`, `"macos"`,
/// `"windows"` / `"x86_64"`, `"aarch64"`, `"arm"`) and the remote-probe
/// spelling (`uname -s` → `"Linux"`, `"Darwin"`, `"MINGW64_NT-10.0"`; `%OS%` →
/// `"Windows_NT"`; `uname -m` → `"x86_64"`, `"amd64"`, `"arm64"`, `"armv7l"`,
/// `"armhf"`; `%PROCESSOR_ARCHITECTURE%` → `"AMD64"`, `"ARM64"`). Matching is
/// case-insensitive.
///
/// Returns `None` for any OS or architecture no agent binary is published for
/// (e.g. FreeBSD, MIPS, 32-bit ARM on macOS / Windows).
pub fn agent_asset_suffix(os: &str, arch: &str) -> Option<&'static str> {
    let arch = arch.to_ascii_lowercase();
    let arch = arch.as_str();
    // Windows first: a MinGW/MSYS `uname -s` must never fall through.
    if is_windows_os(os) {
        return match arch {
            "x86_64" | "amd64" => Some("windows-x64"),
            "aarch64" | "arm64" => Some("windows-arm64"),
            _ => None,
        };
    }
    match os.to_ascii_lowercase().as_str() {
        "darwin" | "macos" => match arch {
            "x86_64" | "amd64" => Some("macos-x64"),
            "aarch64" | "arm64" => Some("macos-arm64"),
            _ => None,
        },
        "linux" => match arch {
            "x86_64" | "amd64" => Some("linux-x64"),
            "aarch64" | "arm64" => Some("linux-arm64"),
            // `uname -m` reports armv7l / armhf; `std::env::consts::ARCH`
            // reports plain "arm" for 32-bit ARM (armv7).
            "armv7l" | "armhf" | "arm" => Some("linux-armv7"),
            _ => None,
        },
        _ => None,
    }
}

/// Returns `true` if a platform suffix names a Windows agent binary.
pub fn is_windows_suffix(suffix: &str) -> bool {
    suffix.starts_with("windows-")
}

/// The published file name of the agent binary for a platform suffix.
///
/// `"linux-x64"` → `"termihub-agent-linux-x64"`;
/// `"windows-x64"` → `"termihub-agent-windows-x64.exe"`.
pub fn agent_release_asset_name(suffix: &str) -> String {
    if is_windows_suffix(suffix) {
        format!("{AGENT_ASSET_BASE}-{suffix}.exe")
    } else {
        format!("{AGENT_ASSET_BASE}-{suffix}")
    }
}

/// The published file name of the `.sha256` checksum sidecar for a suffix.
pub fn agent_checksum_asset_name(suffix: &str) -> String {
    format!("{}.{AGENT_CHECKSUM_EXT}", agent_release_asset_name(suffix))
}

/// The published file name of the `.sig` signature sidecar for a suffix.
pub fn agent_signature_asset_name(suffix: &str) -> String {
    format!("{}.{AGENT_SIGNATURE_EXT}", agent_release_asset_name(suffix))
}

/// The binary asset names a full release publishes, in [`AGENT_ASSET_SUFFIXES`]
/// order.
pub fn agent_release_asset_names() -> Vec<String> {
    AGENT_ASSET_SUFFIXES
        .iter()
        .map(|s| agent_release_asset_name(s))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_from_std_env_consts_spelling() {
        assert_eq!(agent_asset_suffix("linux", "x86_64"), Some("linux-x64"));
        assert_eq!(agent_asset_suffix("linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(agent_asset_suffix("linux", "arm"), Some("linux-armv7"));
        assert_eq!(agent_asset_suffix("macos", "x86_64"), Some("macos-x64"));
        assert_eq!(agent_asset_suffix("macos", "aarch64"), Some("macos-arm64"));
        assert_eq!(agent_asset_suffix("windows", "x86_64"), Some("windows-x64"));
        assert_eq!(
            agent_asset_suffix("windows", "aarch64"),
            Some("windows-arm64")
        );
    }

    #[test]
    fn suffix_from_uname_spelling() {
        assert_eq!(agent_asset_suffix("Linux", "x86_64"), Some("linux-x64"));
        assert_eq!(agent_asset_suffix("Linux", "amd64"), Some("linux-x64"));
        assert_eq!(agent_asset_suffix("Linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(agent_asset_suffix("Linux", "arm64"), Some("linux-arm64"));
        assert_eq!(agent_asset_suffix("Linux", "armv7l"), Some("linux-armv7"));
        assert_eq!(agent_asset_suffix("Linux", "armhf"), Some("linux-armv7"));
        assert_eq!(agent_asset_suffix("Darwin", "x86_64"), Some("macos-x64"));
        assert_eq!(agent_asset_suffix("Darwin", "arm64"), Some("macos-arm64"));
    }

    #[test]
    fn suffix_from_windows_probe_spelling() {
        for os in [
            "Windows_NT",
            "MINGW64_NT-10.0",
            "MSYS_NT-10.0",
            "CYGWIN_NT-10.0",
        ] {
            assert_eq!(agent_asset_suffix(os, "AMD64"), Some("windows-x64"), "{os}");
            assert_eq!(
                agent_asset_suffix(os, "x86_64"),
                Some("windows-x64"),
                "{os}"
            );
            assert_eq!(
                agent_asset_suffix(os, "ARM64"),
                Some("windows-arm64"),
                "{os}"
            );
            assert_eq!(
                agent_asset_suffix(os, "aarch64"),
                Some("windows-arm64"),
                "{os}"
            );
        }
    }

    #[test]
    fn suffix_rejects_unpublished_platforms() {
        assert_eq!(agent_asset_suffix("FreeBSD", "x86_64"), None);
        assert_eq!(agent_asset_suffix("", "x86_64"), None);
        assert_eq!(agent_asset_suffix("Linux", "mips"), None);
        assert_eq!(agent_asset_suffix("Linux", ""), None);
        assert_eq!(agent_asset_suffix("Darwin", "armv7l"), None);
        assert_eq!(agent_asset_suffix("Windows_NT", "x86"), None);
        assert_eq!(agent_asset_suffix("Windows_NT", "arm"), None);
    }

    #[test]
    fn every_published_suffix_is_reachable() {
        let reachable = [
            agent_asset_suffix("linux", "x86_64"),
            agent_asset_suffix("linux", "aarch64"),
            agent_asset_suffix("linux", "arm"),
            agent_asset_suffix("macos", "aarch64"),
            agent_asset_suffix("macos", "x86_64"),
            agent_asset_suffix("windows", "x86_64"),
            agent_asset_suffix("windows", "aarch64"),
        ];
        let reachable: Vec<&str> = reachable.into_iter().flatten().collect();
        assert_eq!(reachable, AGENT_ASSET_SUFFIXES);
    }

    #[test]
    fn is_windows_os_recognizes_markers_and_rejects_posix() {
        for os in [
            "windows",
            "Windows_NT",
            "MINGW64_NT-10.0",
            "msys_nt",
            "CYGWIN_NT-6.1",
        ] {
            assert!(is_windows_os(os), "{os}");
        }
        for os in ["Linux", "linux", "Darwin", "macos", "FreeBSD", ""] {
            assert!(!is_windows_os(os), "{os}");
        }
    }

    #[test]
    fn windows_assets_carry_exe_and_others_do_not() {
        assert_eq!(
            agent_release_asset_name("windows-x64"),
            "termihub-agent-windows-x64.exe"
        );
        assert_eq!(
            agent_release_asset_name("windows-arm64"),
            "termihub-agent-windows-arm64.exe"
        );
        assert_eq!(
            agent_release_asset_name("linux-x64"),
            "termihub-agent-linux-x64"
        );
        assert_eq!(
            agent_release_asset_name("macos-arm64"),
            "termihub-agent-macos-arm64"
        );
    }

    #[test]
    fn sidecar_names_follow_the_binary_name() {
        assert_eq!(
            agent_checksum_asset_name("windows-x64"),
            "termihub-agent-windows-x64.exe.sha256"
        );
        assert_eq!(
            agent_signature_asset_name("windows-arm64"),
            "termihub-agent-windows-arm64.exe.sig"
        );
        assert_eq!(
            agent_checksum_asset_name("linux-armv7"),
            "termihub-agent-linux-armv7.sha256"
        );
        assert_eq!(
            agent_signature_asset_name("macos-x64"),
            "termihub-agent-macos-x64.sig"
        );
    }

    #[test]
    fn release_asset_names_cover_every_suffix() {
        assert_eq!(
            agent_release_asset_names(),
            vec![
                "termihub-agent-linux-x64",
                "termihub-agent-linux-arm64",
                "termihub-agent-linux-armv7",
                "termihub-agent-macos-arm64",
                "termihub-agent-macos-x64",
                "termihub-agent-windows-x64.exe",
                "termihub-agent-windows-arm64.exe",
            ]
        );
    }

    #[cfg(feature = "agent-update-signing")]
    #[test]
    fn signature_ext_matches_the_signature_module() {
        assert_eq!(
            AGENT_SIGNATURE_EXT,
            crate::agent_update_signature::SIGNATURE_EXT
        );
    }
}
