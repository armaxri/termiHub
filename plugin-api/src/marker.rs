//! The **ABI marker**: the plugin's ABI version embedded as plain bytes in its
//! dynamic library, so a packaging tool can read it **without loading the
//! library** (#3372).
//!
//! The authoritative version is what `termihub_plugin_abi_version` returns (see
//! [`crate::version`]), but reading that means `dlopen`ing the library — running
//! its initializers — and only works for a library built for the packaging
//! machine's own platform. The marker is the same number written into a
//! `#[no_mangle]` static as [`ABI_MARKER_MAGIC`] followed by the version, so it
//! survives into every object format (ELF, Mach-O — including universal
//! binaries — and PE) as a byte string the packer (`termihub-plugin-pack`) can
//! scan for, for any target, from any host.
//!
//! A plugin gets both the entry point and the marker, guaranteed to agree, from
//! one macro:
//!
//! ```ignore
//! termihub_plugin_api::export_plugin_abi_version!();
//! ```
//!
//! A plugin that must hand-write `termihub_plugin_abi_version` (for example to
//! compute it at run time) embeds just the marker with
//! [`embed_plugin_abi_marker!`](crate::embed_plugin_abi_marker) and is
//! responsible for keeping the two equal.
//!
//! The marker is **packaging metadata, not part of the ABI**: the host never
//! reads it and never requires it, so it adds no symbol to the frozen 1.x
//! contract. A library without one still loads; the packer only warns that it
//! could not verify the manifest's `apiVersion`.

use crate::version::AbiVersion;

/// The bytes that introduce an embedded ABI marker. Chosen to be long and
/// specific enough never to occur by accident in a compiled library.
///
/// The scanner lives in the packer, not here: this crate is linked into every
/// plugin, and a runtime copy of the magic in a plugin would be a second,
/// spurious match.
pub const ABI_MARKER_MAGIC: [u8; 32] = *b"termihub-plugin-abi-marker/v1:\0\0";

/// Total size of an embedded marker: [`ABI_MARKER_MAGIC`], then the major and
/// the minor as big-endian `u16`s (big-endian so the bytes are the same for
/// every target).
pub const ABI_MARKER_LEN: usize = ABI_MARKER_MAGIC.len() + 4;

/// Encode `version` as the marker bytes a plugin embeds (see the
/// [module docs](self)). Used by the export macros at compile time.
#[must_use]
pub const fn abi_marker(version: AbiVersion) -> [u8; ABI_MARKER_LEN] {
    let mut out = [0u8; ABI_MARKER_LEN];
    let mut i = 0;
    while i < ABI_MARKER_MAGIC.len() {
        out[i] = ABI_MARKER_MAGIC[i];
        i += 1;
    }
    let major = version.major.to_be_bytes();
    let minor = version.minor.to_be_bytes();
    out[ABI_MARKER_MAGIC.len()] = major[0];
    out[ABI_MARKER_MAGIC.len() + 1] = major[1];
    out[ABI_MARKER_MAGIC.len() + 2] = minor[0];
    out[ABI_MARKER_MAGIC.len() + 3] = minor[1];
    out
}

/// Export `termihub_plugin_abi_version` **and** the matching ABI marker.
///
/// With no argument the plugin reports [`CURRENT_PLUGIN_ABI_VERSION`](crate::CURRENT_PLUGIN_ABI_VERSION),
/// the version of this crate it was built against — the usual choice. An
/// explicit [`AbiVersion`] expression is accepted for plugins that deliberately
/// target an older minor. Invoke it once, at the crate root of the `cdylib`:
///
/// ```ignore
/// termihub_plugin_api::export_plugin_abi_version!();
/// ```
#[macro_export]
macro_rules! export_plugin_abi_version {
    () => {
        $crate::export_plugin_abi_version!($crate::CURRENT_PLUGIN_ABI_VERSION);
    };
    ($version:expr) => {
        $crate::embed_plugin_abi_marker!($version);

        /// The plugin's ABI version, packed as `major << 16 | minor`.
        #[unsafe(no_mangle)]
        pub extern "C" fn termihub_plugin_abi_version() -> u32 {
            const VERSION: $crate::AbiVersion = $version;
            VERSION.to_packed()
        }
    };
}

/// Embed only the ABI marker for `version` (an [`AbiVersion`] constant
/// expression), for a plugin that hand-writes `termihub_plugin_abi_version`.
/// It must be the value that function returns; prefer
/// [`export_plugin_abi_version!`](crate::export_plugin_abi_version), which
/// guarantees it.
///
/// The marker is an exported, `#[used]` static, so neither the compiler nor the
/// linker may drop it from the `cdylib`.
#[macro_export]
macro_rules! embed_plugin_abi_marker {
    ($version:expr) => {
        /// Packaging-time copy of the plugin's ABI version (never read by the host).
        #[unsafe(no_mangle)]
        #[used]
        pub static TERMIHUB_PLUGIN_ABI_MARKER: [u8; $crate::ABI_MARKER_LEN] =
            $crate::abi_marker($version);
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_encoding_is_magic_then_big_endian_version() {
        let m = abi_marker(AbiVersion::new(0x0102, 0x0304));
        assert_eq!(&m[..ABI_MARKER_MAGIC.len()], &ABI_MARKER_MAGIC[..]);
        assert_eq!(&m[ABI_MARKER_MAGIC.len()..], &[1, 2, 3, 4]);
    }

    // The macros expand in this crate's test build, proving they compile and
    // that the exported function and the marker agree.
    mod exported {
        crate::export_plugin_abi_version!(crate::AbiVersion::new(1, 0));
    }

    #[test]
    fn export_macro_keeps_function_and_marker_in_step() {
        assert_eq!(
            exported::termihub_plugin_abi_version(),
            AbiVersion::new(1, 0).to_packed()
        );
        assert_eq!(
            exported::TERMIHUB_PLUGIN_ABI_MARKER,
            abi_marker(AbiVersion::new(1, 0))
        );
    }
}
