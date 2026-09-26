//! The native plugin **ABI version**: `major.minor`, frozen at **1.0**.
//!
//! This is the **single authoritative** version of the plugin contract. A
//! plugin's `cdylib` exports it (via `termihub_plugin_abi_version`) and the host
//! gates the load on it; the manifest's `apiVersion` is a checked **mirror** of
//! the same number, never an independent one (PLG-002).
//!
//! # Compatibility rule
//!
//! A host running ABI `H.h` loads a plugin built for ABI `P.p` **iff**
//! `P == H` **and** `p <= h`:
//!
//! | Plugin vs host        | Outcome                                             |
//! | --------------------- | --------------------------------------------------- |
//! | same `major.minor`    | loads                                               |
//! | older minor (`p < h`) | loads — minors are append-only, so the host still   |
//! |                       | speaks everything the plugin knows                  |
//! | newer minor (`p > h`) | refused: "update termiHub"                          |
//! | different major       | refused: majors are deliberately incompatible        |
//!
//! # What a minor may and may not do (the append-only rule)
//!
//! A **minor** bump may only **add**; anything else needs a new **major**. The
//! rule is split by who owns the memory, because that decides who can safely see
//! a newer layout:
//!
//! * **Host-owned tables and out-parameters may grow by appending** — the
//!   capability-bridge vtable ([`PluginHostBridgeVTable`](crate::PluginHostBridgeVTable)),
//!   the mediated-stream vtable, [`PluginSessionConfig`](crate::PluginSessionConfig)
//!   (passed by pointer), and host-allocated out-parameters such as
//!   [`PluginInfo`](crate::PluginInfo). An older-minor plugin only ever reads
//!   (or writes) the prefix it was compiled against, which is unchanged. The
//!   host reads an appended out-parameter field only when
//!   [`AbiVersion::supports`] says the plugin's minor has it.
//! * **By-value structs and plugin-owned tables are frozen for all of 1.x** —
//!   [`PluginBackend`](crate::PluginBackend),
//!   [`PluginBackendVTable`](crate::PluginBackendVTable),
//!   [`PluginOutputSender`](crate::PluginOutputSender),
//!   [`PluginHostBridge`](crate::PluginHostBridge),
//!   [`PluginTcpStream`](crate::PluginTcpStream) and the `Ffi*` carriers. Their
//!   size is baked into an older plugin's calling convention or allocation, so
//!   growing them is breaking. New plugin-provided behavior arrives instead as a
//!   **new, optional exported symbol** that the host resolves only when the
//!   plugin's minor [`supports`](AbiVersion::supports) it.
//! * **Enums may gain variants**, but the host must never hand a plugin a
//!   variant newer than the plugin's minor — see
//!   [`PluginStatus::for_peer`](crate::PluginStatus::for_peer).
//! * Existing fields/variants/symbols are **never** reordered, removed, retyped
//!   or given a new meaning within a major.
//!
//! The rule is enforced by the layout-freeze test in `plugin-api/tests/abi_layout.rs`,
//! which pins every 1.0 field offset, every frozen struct's size, and every enum
//! discriminant.
//!
//! # Wire encoding
//!
//! Across the FFI boundary the version travels as a single `u32`,
//! [`packed`](AbiVersion::to_packed) as `major << 16 | minor`. A plain integer
//! return value is the most FFI-robust shape there is (no struct-return ABI
//! questions), and the encoding is unambiguous for both halves up to `u16::MAX`.
//! The pre-freeze exact-match counter values (`1`..=`4`) decode as `0.1`..`0.4`,
//! i.e. major `0`, so a stale pre-1.0 plugin is refused with a clear
//! "major 0 not supported" instead of being misread.

use core::fmt;

/// A native plugin ABI version, `major.minor`.
///
/// See the [module docs](self) for the compatibility rule and the append-only
/// discipline a minor bump must follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AbiVersion {
    /// Major version. Different majors are incompatible by definition.
    pub major: u16,
    /// Minor version. Minors within a major are append-only.
    pub minor: u16,
}

impl AbiVersion {
    /// Build a version from its components.
    #[must_use]
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }

    /// Encode as the `u32` wire value (`major << 16 | minor`) that crosses the
    /// FFI boundary — the return value of `termihub_plugin_abi_version` and
    /// [`PluginInfo::api_version`](crate::PluginInfo::api_version).
    #[must_use]
    pub const fn to_packed(self) -> u32 {
        ((self.major as u32) << 16) | self.minor as u32
    }

    /// Decode a `u32` wire value produced by [`to_packed`](Self::to_packed).
    /// Every `u32` decodes to *some* version; compatibility is decided
    /// separately by [`check_host_compatibility`](Self::check_host_compatibility).
    #[must_use]
    pub const fn from_packed(packed: u32) -> Self {
        Self {
            major: (packed >> 16) as u16,
            minor: (packed & 0xFFFF) as u16,
        }
    }

    /// Parse the canonical `"major.minor"` text form (as written in a plugin
    /// manifest's `apiVersion`). Both components are required and must be plain
    /// ASCII decimal digits; anything else (`"1"`, `"1.0.0"`, `"+1.0"`, `" 1.0"`)
    /// is rejected so the manifest mirror has exactly one spelling.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let (major, minor) = text.split_once('.')?;
        Some(Self::new(parse_component(major)?, parse_component(minor)?))
    }

    /// Whether a peer at this version includes an addition introduced in
    /// version `since` — i.e. same major and a minor at least `since`'s.
    ///
    /// This is the gate the host uses before touching anything a later minor
    /// appended (an out-parameter field, an optional exported symbol, an enum
    /// variant): `plugin_abi.supports(AbiVersion::new(1, 1))`.
    #[must_use]
    pub const fn supports(self, since: AbiVersion) -> bool {
        self.major == since.major && self.minor >= since.minor
    }

    /// Decide whether a plugin at `self` may be loaded by a host at `host`.
    ///
    /// Loads iff the majors match and the plugin's minor does not exceed the
    /// host's (see the [module docs](self)).
    pub fn check_host_compatibility(self, host: AbiVersion) -> Result<(), AbiIncompatibility> {
        if self.major != host.major {
            return Err(AbiIncompatibility::UnsupportedMajor { plugin: self, host });
        }
        if self.minor > host.minor {
            return Err(AbiIncompatibility::NewerMinor { plugin: self, host });
        }
        Ok(())
    }
}

impl fmt::Display for AbiVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// Parse one `u16` version component made only of ASCII digits.
fn parse_component(text: &str) -> Option<u16> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Why a plugin's ABI version cannot be loaded by this host. The `Display`
/// text is user-facing: it names both versions and what to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbiIncompatibility {
    /// The plugin targets a different **major** ABI. Majors are deliberately
    /// incompatible: the plugin must be rebuilt for this host's major (or, when
    /// the plugin's major is newer, termiHub updated).
    UnsupportedMajor {
        /// ABI the plugin was built for.
        plugin: AbiVersion,
        /// ABI this host supports.
        host: AbiVersion,
    },
    /// Same major, but the plugin needs a **newer minor** than this host
    /// provides — it may rely on additions this host does not have.
    NewerMinor {
        /// ABI the plugin was built for.
        plugin: AbiVersion,
        /// ABI this host supports.
        host: AbiVersion,
    },
}

impl fmt::Display for AbiIncompatibility {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Self::UnsupportedMajor { plugin, host } => {
                let fix = if plugin.major > host.major {
                    "update termiHub"
                } else {
                    "the plugin must be rebuilt for this termiHub"
                };
                write!(
                    f,
                    "plugin built for ABI {plugin}, this termiHub supports ABI {host}: \
                     major {} is not supported — {fix}",
                    plugin.major
                )
            }
            Self::NewerMinor { plugin, host } => write!(
                f,
                "plugin built for ABI {plugin}, this termiHub supports ABI {host} — update termiHub"
            ),
        }
    }
}

impl std::error::Error for AbiIncompatibility {}

impl AbiIncompatibility {
    /// The ABI version the plugin was built for.
    #[must_use]
    pub fn plugin(&self) -> AbiVersion {
        match *self {
            Self::UnsupportedMajor { plugin, .. } | Self::NewerMinor { plugin, .. } => plugin,
        }
    }

    /// The ABI version this host supports.
    #[must_use]
    pub fn host(&self) -> AbiVersion {
        match *self {
            Self::UnsupportedMajor { host, .. } | Self::NewerMinor { host, .. } => host,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: AbiVersion = AbiVersion::new(1, 2);

    #[test]
    fn packed_round_trips() {
        for v in [
            AbiVersion::new(1, 0),
            AbiVersion::new(1, 7),
            AbiVersion::new(2, 0),
            AbiVersion::new(u16::MAX, u16::MAX),
        ] {
            assert_eq!(AbiVersion::from_packed(v.to_packed()), v);
        }
        assert_eq!(AbiVersion::new(1, 0).to_packed(), 0x0001_0000);
    }

    #[test]
    fn pre_freeze_counter_values_decode_as_major_zero() {
        // The old exact-match `u32` counter (1..=4) must never be mistaken for a
        // 1.x plugin: it decodes to major 0 and is refused.
        for old in 1..=4u32 {
            let v = AbiVersion::from_packed(old);
            assert_eq!(v.major, 0);
            assert!(matches!(
                v.check_host_compatibility(crate::CURRENT_PLUGIN_ABI_VERSION),
                Err(AbiIncompatibility::UnsupportedMajor { .. })
            ));
        }
    }

    #[test]
    fn compatibility_matrix() {
        // Same version loads.
        assert_eq!(HOST.check_host_compatibility(HOST), Ok(()));
        // Older minors load (append-only).
        assert_eq!(AbiVersion::new(1, 0).check_host_compatibility(HOST), Ok(()));
        assert_eq!(AbiVersion::new(1, 1).check_host_compatibility(HOST), Ok(()));
        // Newer minor is refused.
        assert_eq!(
            AbiVersion::new(1, 3).check_host_compatibility(HOST),
            Err(AbiIncompatibility::NewerMinor {
                plugin: AbiVersion::new(1, 3),
                host: HOST,
            })
        );
        // Any other major is refused, older or newer, whatever the minor.
        for plugin in [
            AbiVersion::new(0, 4),
            AbiVersion::new(2, 0),
            AbiVersion::new(2, 9),
        ] {
            assert_eq!(
                plugin.check_host_compatibility(HOST),
                Err(AbiIncompatibility::UnsupportedMajor { plugin, host: HOST })
            );
        }
    }

    #[test]
    fn incompatibility_messages_name_both_versions_and_the_fix() {
        let newer = AbiVersion::new(1, 3)
            .check_host_compatibility(HOST)
            .unwrap_err();
        assert_eq!(
            newer.to_string(),
            "plugin built for ABI 1.3, this termiHub supports ABI 1.2 — update termiHub"
        );
        let future_major = AbiVersion::new(2, 0)
            .check_host_compatibility(HOST)
            .unwrap_err();
        assert_eq!(
            future_major.to_string(),
            "plugin built for ABI 2.0, this termiHub supports ABI 1.2: \
             major 2 is not supported — update termiHub"
        );
        let old_major = AbiVersion::new(0, 4)
            .check_host_compatibility(HOST)
            .unwrap_err();
        assert!(old_major.to_string().contains("major 0 is not supported"));
        assert!(old_major.to_string().contains("rebuilt"));
        assert_eq!(old_major.plugin(), AbiVersion::new(0, 4));
        assert_eq!(old_major.host(), HOST);
    }

    #[test]
    fn supports_gates_minor_additions() {
        let since_1_1 = AbiVersion::new(1, 1);
        assert!(!AbiVersion::new(1, 0).supports(since_1_1));
        assert!(AbiVersion::new(1, 1).supports(since_1_1));
        assert!(AbiVersion::new(1, 5).supports(since_1_1));
        // A different major never "supports" another major's addition.
        assert!(!AbiVersion::new(2, 5).supports(since_1_1));
    }

    #[test]
    fn parse_accepts_only_canonical_major_minor() {
        assert_eq!(AbiVersion::parse("1.0"), Some(AbiVersion::new(1, 0)));
        assert_eq!(AbiVersion::parse("12.34"), Some(AbiVersion::new(12, 34)));
        for bad in [
            "", "1", "1.", ".1", "1.0.0", "+1.0", "1.+0", " 1.0", "1.0 ", "a.b", "70000.0",
        ] {
            assert_eq!(AbiVersion::parse(bad), None, "{bad:?} should be rejected");
        }
    }

    #[test]
    fn display_is_major_dot_minor() {
        assert_eq!(AbiVersion::new(1, 0).to_string(), "1.0");
    }
}
