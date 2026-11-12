//! Which OS keychain namespace this build reads and writes (#5478).
//!
//! The installed app keeps its secrets under fixed OS credential-store names
//! (`termiHub`, `termiHub-backup-restore`, `termiHub-biometric-unlock`,
//! `termiHub-biometric-unlock-v2`). A dev build (`scripts/dev.sh`, any debug
//! build) or a test-instance build (`--features test-bridge`) runs on the same
//! machine and the same login keychain, so with the same names it would read,
//! overwrite and delete the installed app's entries.
//!
//! Every keychain name is therefore built from a base name and a
//! [`KeychainNamespace`]: the release namespace leaves the base name unchanged
//! (so real users' entries keep their names and need no migration), while an
//! isolated namespace appends `-dev`, or `-dev-<instance>` when the launcher
//! names the checkout through [`DEV_INSTANCE_ENV`] (`scripts/dev.sh` exports
//! `dev.local.json`'s `dev_name`), so parallel dev checkouts stay apart too.
//!
//! The build flavour is a parameter of [`KeychainNamespace::select`], so both
//! flavours are unit-tested from one test build; only
//! [`KeychainNamespace::current`] reads the real build flavour and environment.

use std::sync::OnceLock;

/// Environment variable naming the dev instance (checkout) whose keychain
/// namespace an isolated build uses. Ignored by release builds.
pub const DEV_INSTANCE_ENV: &str = "TERMIHUB_DEV_NAME";

/// Whether this build keeps out of the installed app's keychain entries: any
/// debug build, and any test-instance (`test-bridge`) build even in release
/// mode.
pub const IS_ISOLATED_BUILD: bool = cfg!(any(debug_assertions, feature = "test-bridge"));

/// Longest instance tag kept in a keychain name.
const MAX_INSTANCE_LEN: usize = 32;

/// The suffix applied to every OS keychain name of this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainNamespace {
    suffix: String,
}

impl KeychainNamespace {
    /// The installed app's namespace: names are used unchanged.
    pub fn release() -> Self {
        Self {
            suffix: String::new(),
        }
    }

    /// A dev/test namespace, never equal to [`Self::release`]. `instance`
    /// (a checkout name such as `dev3`) is reduced to ASCII letters, digits,
    /// `-` and `_`, capped at 32 characters; nothing left means plain `-dev`.
    pub fn isolated(instance: Option<&str>) -> Self {
        let tag: String = instance
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(MAX_INSTANCE_LEN)
            .collect();
        let suffix = if tag.is_empty() {
            "-dev".to_string()
        } else {
            format!("-dev-{tag}")
        };
        Self { suffix }
    }

    /// The namespace for a build: isolated (with `instance`) when
    /// `isolated_build`, otherwise the release namespace, which ignores
    /// `instance`.
    pub fn select(isolated_build: bool, instance: Option<&str>) -> Self {
        if isolated_build {
            Self::isolated(instance)
        } else {
            Self::release()
        }
    }

    /// The namespace of the running build ([`IS_ISOLATED_BUILD`] and
    /// [`DEV_INSTANCE_ENV`]), resolved once per process so every store agrees.
    pub fn current() -> &'static Self {
        static CURRENT: OnceLock<KeychainNamespace> = OnceLock::new();
        CURRENT.get_or_init(|| {
            let instance = std::env::var(DEV_INSTANCE_ENV).ok();
            Self::select(IS_ISOLATED_BUILD, instance.as_deref())
        })
    }

    /// The OS keychain name for `base` in this namespace.
    pub fn name(&self, base: &str) -> String {
        format!("{base}{}", self.suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASES: [&str; 4] = [
        "termiHub",
        "termiHub-backup-restore",
        "termiHub-biometric-unlock",
        "termiHub-biometric-unlock-v2",
    ];

    #[test]
    fn release_keeps_every_shipped_name_unchanged() {
        let ns = KeychainNamespace::select(false, None);
        assert_eq!(ns, KeychainNamespace::release());
        for base in BASES {
            assert_eq!(ns.name(base), base);
        }
    }

    #[test]
    fn release_ignores_the_dev_instance() {
        let ns = KeychainNamespace::select(false, Some("dev3"));
        assert_eq!(ns, KeychainNamespace::release());
        assert_eq!(ns.name("termiHub"), "termiHub");
    }

    #[test]
    fn isolated_build_never_resolves_a_release_name() {
        for instance in [None, Some(""), Some("dev0"), Some("dev9"), Some("!!!")] {
            let ns = KeychainNamespace::select(true, instance);
            assert_ne!(ns, KeychainNamespace::release(), "{instance:?}");
            for base in BASES {
                let name = ns.name(base);
                assert!(!BASES.contains(&name.as_str()), "{instance:?} -> {name}");
            }
        }
    }

    #[test]
    fn isolated_without_instance_uses_plain_dev_suffix() {
        assert_eq!(
            KeychainNamespace::isolated(None).name("termiHub"),
            "termiHub-dev"
        );
        assert_eq!(
            KeychainNamespace::isolated(Some("  ")).name("termiHub"),
            "termiHub-dev"
        );
    }

    #[test]
    fn isolated_instance_names_the_checkout() {
        assert_eq!(
            KeychainNamespace::isolated(Some("dev3")).name("termiHub-backup-restore"),
            "termiHub-backup-restore-dev-dev3"
        );
    }

    #[test]
    fn distinct_checkouts_get_distinct_names() {
        let a = KeychainNamespace::isolated(Some("dev1")).name("termiHub");
        let b = KeychainNamespace::isolated(Some("dev2")).name("termiHub");
        assert_ne!(a, b);
    }

    #[test]
    fn instance_is_sanitized_and_capped() {
        let ns = KeychainNamespace::isolated(Some("dev 3/../é:x"));
        assert_eq!(ns.name("termiHub"), "termiHub-dev-dev3x");
        let long = "a".repeat(100);
        let name = KeychainNamespace::isolated(Some(&long)).name("termiHub");
        assert_eq!(
            name,
            format!("termiHub-dev-{}", "a".repeat(MAX_INSTANCE_LEN))
        );
    }

    /// A debug test build (how `cargo test` runs) is isolated, so no store
    /// built in a unit test can address the installed app's entries.
    #[test]
    fn debug_build_is_isolated() {
        if cfg!(debug_assertions) {
            assert_ne!(*KeychainNamespace::current(), KeychainNamespace::release());
        }
    }
}
