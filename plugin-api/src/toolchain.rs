//! The **build-toolchain record** a plugin reports and the host enforces
//! (PLG-013, added in ABI **1.1**).
//!
//! # Why the toolchain matters when the ABI is `#[repr(C)]`
//!
//! Every type that crosses the boundary is hand-rolled `#[repr(C)]`, so data
//! *layouts* do not depend on the compiler. What does is everything around
//! them that the host relies on for soundness and containment:
//!
//! * **Panic strategy.** Every plugin entry point and callback contains panics
//!   with `catch_unwind` (plugin side) and the host wraps each call in
//!   `catch_unwind` too. A plugin built with `panic = "abort"` turns any panic —
//!   even one the SDK would have contained — into an abort of the *whole host
//!   process*. A plugin must be built with the host's panic strategy.
//! * **The compiler itself.** Unwinding and `extern "C"` semantics, the
//!   `bool`/`char` validity rules the SDK relies on, and the standard library's
//!   panic runtime (two copies of which meet at the boundary) are validated
//!   only against the exact toolchain the host is built and tested with.
//!
//! # The compatibility rule (ADR-15)
//!
//! A host loads a plugin that reports a toolchain **only if both halves match
//! the host's own record exactly**:
//!
//! | Plugin vs host                               | Outcome  |
//! | -------------------------------------------- | -------- |
//! | same rustc release **and** commit hash, same panic strategy | loads |
//! | different rustc (even a patch release)       | refused  |
//! | different panic strategy                     | refused  |
//! | unknown/empty rustc, or unknown panic strategy (either side) | refused (fail closed) |
//!
//! Exact match rather than "same minor" is deliberate: the host is built by CI
//! with **one** pinned compiler (`.github/rust-version`), so an exact match is
//! both cheap to satisfy and the only claim the host's test suite actually
//! backs. A plugin built for ABI **1.0** predates this record and cannot prove
//! its toolchain at all; how the host treats it is decided by the host loader
//! (it requires an explicit user acceptance — see ADR-15).
//!
//! # How it is recorded
//!
//! This crate's build script captures `rustc -vV` of the compiler building it.
//! Because the crate is compiled into both sides by that side's compiler,
//! [`BUILD_RUSTC`] and [`BUILD_PANIC_STRATEGY`] describe the plugin inside a
//! plugin and the host inside the host. [`PluginInfo::new`](crate::PluginInfo::new)
//! fills them in automatically — plugin authors do nothing.

use core::fmt;

/// The rustc that compiled this copy of the crate, as
/// `"<release> (<commit-hash>)"` (e.g. `1.98.0 (88d9e12ae…)`). Empty when the
/// build script could not determine it — which the host treats as unknown and
/// refuses.
pub const BUILD_RUSTC: &str = env!("TERMIHUB_PLUGIN_API_RUSTC");

/// The panic strategy this copy of the crate was compiled with. Cargo applies a
/// profile's `panic` setting to every crate in the build, so this is the final
/// artifact's strategy.
pub const BUILD_PANIC_STRATEGY: PanicStrategy = if cfg!(panic = "unwind") {
    PanicStrategy::Unwind
} else if cfg!(panic = "abort") {
    PanicStrategy::Abort
} else {
    PanicStrategy::Unknown
};

/// A panic strategy, carried across the ABI as a plain `u32`
/// ([`to_wire`](Self::to_wire) / [`from_wire`](Self::from_wire)).
///
/// Never passed as a Rust enum across the boundary: an out-of-range
/// discriminant would be undefined behavior on the receiving side, so the wire
/// form is an integer and every unrecognized value decodes to
/// [`Unknown`](Self::Unknown).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanicStrategy {
    /// Not reported, or not recognized. Never compatible with anything.
    Unknown,
    /// `panic = "unwind"` — the Rust default.
    Unwind,
    /// `panic = "abort"`.
    Abort,
}

impl PanicStrategy {
    /// Wire value of [`Unknown`](Self::Unknown) — also what an unset field reads as.
    pub const WIRE_UNKNOWN: u32 = 0;
    /// Wire value of [`Unwind`](Self::Unwind).
    pub const WIRE_UNWIND: u32 = 1;
    /// Wire value of [`Abort`](Self::Abort).
    pub const WIRE_ABORT: u32 = 2;

    /// Encode for the `PluginInfo::panic_strategy` field.
    #[must_use]
    pub const fn to_wire(self) -> u32 {
        match self {
            Self::Unknown => Self::WIRE_UNKNOWN,
            Self::Unwind => Self::WIRE_UNWIND,
            Self::Abort => Self::WIRE_ABORT,
        }
    }

    /// Decode a wire value; anything unrecognized is [`Unknown`](Self::Unknown).
    #[must_use]
    pub const fn from_wire(value: u32) -> Self {
        match value {
            Self::WIRE_UNWIND => Self::Unwind,
            Self::WIRE_ABORT => Self::Abort,
            _ => Self::Unknown,
        }
    }
}

impl fmt::Display for PanicStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unknown => "unknown",
            Self::Unwind => "unwind",
            Self::Abort => "abort",
        })
    }
}

/// A build-toolchain record: the rustc identity plus the panic strategy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toolchain {
    /// `"<release> (<commit-hash>)"`, or empty when unknown.
    pub rustc: String,
    /// The panic strategy.
    pub panic_strategy: PanicStrategy,
}

impl Toolchain {
    /// The toolchain that compiled this copy of the crate — the host's own
    /// record when called from the host.
    #[must_use]
    pub fn current() -> Self {
        Self {
            rustc: BUILD_RUSTC.to_owned(),
            panic_strategy: BUILD_PANIC_STRATEGY,
        }
    }

    /// Whether both halves are known. An unknown record is never compatible.
    #[must_use]
    pub fn is_known(&self) -> bool {
        is_well_formed_rustc(&self.rustc) && self.panic_strategy != PanicStrategy::Unknown
    }

    /// Decide whether a plugin built with `self` may be loaded by a host built
    /// with `host`: exact rustc match and equal panic strategy, both known (see
    /// the [module docs](self)). Fails closed on anything unknown.
    pub fn check_host_compatibility(
        &self,
        host: &Toolchain,
    ) -> Result<(), ToolchainIncompatibility> {
        if !host.is_known() {
            return Err(ToolchainIncompatibility::HostUnknown { host: host.clone() });
        }
        if !self.is_known() {
            return Err(ToolchainIncompatibility::PluginUnknown {
                plugin: self.clone(),
                host: host.clone(),
            });
        }
        if self.rustc != host.rustc {
            return Err(ToolchainIncompatibility::RustcMismatch {
                plugin: self.clone(),
                host: host.clone(),
            });
        }
        if self.panic_strategy != host.panic_strategy {
            return Err(ToolchainIncompatibility::PanicStrategyMismatch {
                plugin: self.clone(),
                host: host.clone(),
            });
        }
        Ok(())
    }
}

impl fmt::Display for Toolchain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let rustc = if self.rustc.is_empty() {
            "unknown"
        } else {
            &self.rustc
        };
        write!(f, "rustc {rustc}, panic={}", self.panic_strategy)
    }
}

/// A rustc record is well formed when it is `"<release> (<hash>)"` with both
/// parts non-empty — the exact shape the build script emits. Anything else
/// (empty, truncated, hand-written) is treated as unknown.
fn is_well_formed_rustc(rustc: &str) -> bool {
    let Some((release, rest)) = rustc.split_once(" (") else {
        return false;
    };
    let Some(hash) = rest.strip_suffix(')') else {
        return false;
    };
    !release.is_empty()
        && !hash.is_empty()
        && !release.contains(char::is_whitespace)
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Why a plugin's build toolchain is not acceptable to this host. The `Display`
/// text is user-facing and names both toolchains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolchainIncompatibility {
    /// The plugin was built with a different rustc than the host.
    RustcMismatch {
        /// The plugin's record.
        plugin: Toolchain,
        /// The host's record.
        host: Toolchain,
    },
    /// The plugin was built with a different panic strategy than the host.
    PanicStrategyMismatch {
        /// The plugin's record.
        plugin: Toolchain,
        /// The host's record.
        host: Toolchain,
    },
    /// The plugin claims an ABI with a toolchain record but reported none (or
    /// a malformed one).
    PluginUnknown {
        /// The plugin's (incomplete) record.
        plugin: Toolchain,
        /// The host's record.
        host: Toolchain,
    },
    /// The host's own toolchain is unknown (its build could not record it), so
    /// no plugin can be verified against it.
    HostUnknown {
        /// The host's (incomplete) record.
        host: Toolchain,
    },
}

impl fmt::Display for ToolchainIncompatibility {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RustcMismatch { plugin, host } => write!(
                f,
                "plugin was built with rustc {}, this termiHub was built with rustc {} — rebuild \
                 the plugin with exactly that compiler",
                plugin.rustc, host.rustc
            ),
            Self::PanicStrategyMismatch { plugin, host } => write!(
                f,
                "plugin was built with panic={}, this termiHub requires panic={} — rebuild the \
                 plugin without changing the panic strategy",
                plugin.panic_strategy, host.panic_strategy
            ),
            Self::PluginUnknown { plugin, host } => write!(
                f,
                "plugin did not report a verifiable build toolchain ({plugin}); this termiHub \
                 requires {host} — rebuild the plugin with the termiHub plugin SDK"
            ),
            Self::HostUnknown { host } => write!(
                f,
                "this termiHub build does not know its own toolchain ({host}), so no native \
                 plugin can be verified against it"
            ),
        }
    }
}

impl std::error::Error for ToolchainIncompatibility {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tc(rustc: &str, panic: PanicStrategy) -> Toolchain {
        Toolchain {
            rustc: rustc.to_owned(),
            panic_strategy: panic,
        }
    }

    const HOST_RUSTC: &str = "1.98.0 (88d9e12ae178fab0fb5cc050a94da85685d449ea)";

    #[test]
    fn this_build_records_a_known_toolchain() {
        // The build script ran against the real compiler, so the record is
        // well formed and the test harness uses the unwind strategy.
        let current = Toolchain::current();
        assert!(current.is_known(), "{current}");
        assert_eq!(current.panic_strategy, PanicStrategy::Unwind);
        assert_eq!(current.check_host_compatibility(&current), Ok(()));
    }

    #[test]
    fn exact_match_is_required() {
        let host = tc(HOST_RUSTC, PanicStrategy::Unwind);
        assert_eq!(host.clone().check_host_compatibility(&host), Ok(()));

        // Different patch release, different hash.
        let other = tc("1.98.1 (0123456789abcdef)", PanicStrategy::Unwind);
        assert!(matches!(
            other.check_host_compatibility(&host),
            Err(ToolchainIncompatibility::RustcMismatch { .. })
        ));
        // Same release string, different commit (e.g. a distro rebuild).
        let rebuilt = tc("1.98.0 (deadbeef)", PanicStrategy::Unwind);
        assert!(matches!(
            rebuilt.check_host_compatibility(&host),
            Err(ToolchainIncompatibility::RustcMismatch { .. })
        ));
        // Same compiler, abort strategy.
        let abort = tc(HOST_RUSTC, PanicStrategy::Abort);
        assert!(matches!(
            abort.check_host_compatibility(&host),
            Err(ToolchainIncompatibility::PanicStrategyMismatch { .. })
        ));
    }

    #[test]
    fn unknown_records_fail_closed() {
        let host = tc(HOST_RUSTC, PanicStrategy::Unwind);
        for plugin in [
            tc("", PanicStrategy::Unwind),
            tc(HOST_RUSTC, PanicStrategy::Unknown),
            tc("1.98.0", PanicStrategy::Unwind),
            tc("1.98.0 ()", PanicStrategy::Unwind),
            tc("1.98.0 (not-hex)", PanicStrategy::Unwind),
            tc(" (abc)", PanicStrategy::Unwind),
        ] {
            assert!(
                matches!(
                    plugin.check_host_compatibility(&host),
                    Err(ToolchainIncompatibility::PluginUnknown { .. })
                ),
                "{plugin:?}"
            );
        }
        // An unknown host verifies nothing — not even an identical record.
        let unknown_host = tc("", PanicStrategy::Unwind);
        assert!(matches!(
            unknown_host.clone().check_host_compatibility(&unknown_host),
            Err(ToolchainIncompatibility::HostUnknown { .. })
        ));
    }

    #[test]
    fn panic_strategy_wire_round_trips_and_rejects_garbage() {
        for s in [
            PanicStrategy::Unknown,
            PanicStrategy::Unwind,
            PanicStrategy::Abort,
        ] {
            assert_eq!(PanicStrategy::from_wire(s.to_wire()), s);
        }
        assert_eq!(PanicStrategy::from_wire(0), PanicStrategy::Unknown);
        assert_eq!(PanicStrategy::from_wire(3), PanicStrategy::Unknown);
        assert_eq!(PanicStrategy::from_wire(u32::MAX), PanicStrategy::Unknown);
    }

    #[test]
    fn messages_name_both_toolchains() {
        let host = tc(HOST_RUSTC, PanicStrategy::Unwind);
        let err = tc("1.97.0 (abc)", PanicStrategy::Unwind)
            .check_host_compatibility(&host)
            .unwrap_err()
            .to_string();
        assert!(err.contains("1.97.0 (abc)"), "{err}");
        assert!(err.contains(HOST_RUSTC), "{err}");
        let err = tc(HOST_RUSTC, PanicStrategy::Abort)
            .check_host_compatibility(&host)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("panic=abort") && err.contains("panic=unwind"),
            "{err}"
        );
    }
}
