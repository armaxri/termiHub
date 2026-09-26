//! Publisher-key continuity for plugin install/update (#3489).
//!
//! Installing a plugin whose id is already installed *replaces* the installed
//! copy. The trust gate ([`assess_trust`](super::assess_trust)) only looks at the
//! **incoming** package: a package signed by a key the user has never seen reads
//! as "signed by an unknown publisher", and an unsigned one as "unsigned". Neither
//! banner says *the publisher changed* — so a compromised update host could ship a
//! package signed by a different key (or by no key at all) and the user would see
//! only the generic banner.
//!
//! [`classify_signer_change`] compares the signer of the incoming package with the
//! signer recorded for the installed copy and decides whether the replace may
//! proceed silently or needs the user's explicit confirmation. Like the version
//! gate ([`version_change`](super::version_change)), the decision is made by the
//! backend: the [`PluginManager`](super::PluginManager) refuses an unconfirmed
//! replace with
//! [`PluginManagerError::SignerChangeUnconfirmed`](super::PluginManagerError::SignerChangeUnconfirmed).
//!
//! # Transition rules
//!
//! | Installed signer → incoming signer | Result |
//! | --- | --- |
//! | not installed | [`Fresh`](SignerChangeKind::Fresh) — proceeds |
//! | key A → key A | [`SameKey`](SignerChangeKind::SameKey) — proceeds |
//! | unsigned → key B | [`NewlySigned`](SignerChangeKind::NewlySigned) — proceeds; key B is recorded |
//! | unsigned → unsigned | [`StillUnsigned`](SignerChangeKind::StillUnsigned) — proceeds (the unsigned-risk gate still applies) |
//! | key A → key B | [`KeyChanged`](SignerChangeKind::KeyChanged) — **confirm** |
//! | key A → unsigned | [`SignatureRemoved`](SignerChangeKind::SignatureRemoved) — **confirm** |
//! | installed signer unknown | [`Unverifiable`](SignerChangeKind::Unverifiable) — **confirm** |
//!
//! Anything that cannot be proven to be the same publisher (or an improvement)
//! fails closed to "confirm".

use serde::{Deserialize, Serialize};

/// Who signed a package: nobody, or the Ed25519 key with this fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PackageSigner {
    /// The package carried no signature (an accepted-risk install).
    Unsigned,
    /// The package was validly signed by this key.
    Signed {
        /// The signing key's `sha256:` fingerprint.
        #[serde(rename = "keyId")]
        key_id: String,
    },
}

impl PackageSigner {
    /// The signing key fingerprint, or `None` for an unsigned package.
    #[must_use]
    pub fn key_id(&self) -> Option<&str> {
        match self {
            Self::Unsigned => None,
            Self::Signed { key_id } => Some(key_id),
        }
    }

    /// Build from an optional key fingerprint (`None` → unsigned).
    #[must_use]
    pub fn from_key_id(key_id: Option<&str>) -> Self {
        match key_id {
            Some(k) => Self::Signed {
                key_id: k.to_owned(),
            },
            None => Self::Unsigned,
        }
    }
}

/// What is known about who signed the currently installed copy of a plugin id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledSigner<'a> {
    /// Nothing is installed under this id.
    Absent,
    /// A plugin is installed but its signer cannot be determined (no record and
    /// no readable signature evidence) — treated as "could be anyone".
    Unknown,
    /// The installed copy's signer is known.
    Known(&'a PackageSigner),
}

/// How the incoming package's signer relates to the installed copy's signer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignerChangeKind {
    /// No plugin with this id is installed.
    Fresh,
    /// Both are signed by the same key.
    SameKey,
    /// The installed copy was unsigned; the incoming package is signed — an
    /// improvement. The new key is recorded for future comparisons.
    NewlySigned,
    /// Neither is signed. The unsigned-source risk gate still applies.
    StillUnsigned,
    /// The installed copy was signed by one key, the incoming package by another.
    KeyChanged,
    /// The installed copy was signed; the incoming package is unsigned.
    SignatureRemoved,
    /// The installed copy's signer could not be determined.
    Unverifiable,
}

impl SignerChangeKind {
    /// Whether replacing the installed plugin with this signer change needs the
    /// user's explicit confirmation.
    #[must_use]
    pub fn requires_confirmation(self) -> bool {
        matches!(
            self,
            Self::KeyChanged | Self::SignatureRemoved | Self::Unverifiable
        )
    }
}

/// A classified signer transition plus both fingerprints, as the confirmation
/// prompt shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerChange {
    /// The plugin id being installed.
    pub plugin_id: String,
    /// The display name from the incoming manifest.
    pub plugin_name: String,
    /// The fingerprint of the key that signed the installed copy; `None` when it
    /// was unsigned, unknown, or nothing is installed.
    pub installed_key_id: Option<String>,
    /// The fingerprint of the key that signed the incoming package; `None` when
    /// it is unsigned.
    pub incoming_key_id: Option<String>,
    /// How the signers relate.
    pub kind: SignerChangeKind,
}

impl SignerChange {
    /// Whether this change needs explicit confirmation before it is applied.
    #[must_use]
    pub fn requires_confirmation(&self) -> bool {
        self.kind.requires_confirmation()
    }
}

/// Classify replacing a plugin signed by `installed` with a package signed by
/// `incoming`. See the [module docs](self) for the rule table.
#[must_use]
pub fn classify_signer_change(
    installed: InstalledSigner<'_>,
    incoming: &PackageSigner,
) -> SignerChangeKind {
    let installed = match installed {
        InstalledSigner::Absent => return SignerChangeKind::Fresh,
        InstalledSigner::Unknown => return SignerChangeKind::Unverifiable,
        InstalledSigner::Known(s) => s,
    };
    match (installed.key_id(), incoming.key_id()) {
        (Some(old), Some(new)) if old.eq_ignore_ascii_case(new) => SignerChangeKind::SameKey,
        (Some(_), Some(_)) => SignerChangeKind::KeyChanged,
        (Some(_), None) => SignerChangeKind::SignatureRemoved,
        (None, Some(_)) => SignerChangeKind::NewlySigned,
        (None, None) => SignerChangeKind::StillUnsigned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "sha256:aaaa";
    const B: &str = "sha256:bbbb";

    fn signed(k: &str) -> PackageSigner {
        PackageSigner::Signed { key_id: k.into() }
    }

    #[test]
    fn transition_matrix() {
        use SignerChangeKind::*;
        let unsigned = PackageSigner::Unsigned;
        let a = signed(A);
        let a_upper = signed("SHA256:AAAA");
        let b = signed(B);
        let cases: &[(InstalledSigner<'_>, &PackageSigner, SignerChangeKind)] = &[
            (InstalledSigner::Absent, &a, Fresh),
            (InstalledSigner::Absent, &unsigned, Fresh),
            (InstalledSigner::Known(&a), &a, SameKey),
            (InstalledSigner::Known(&a_upper), &a, SameKey),
            (InstalledSigner::Known(&unsigned), &b, NewlySigned),
            (InstalledSigner::Known(&unsigned), &unsigned, StillUnsigned),
            (InstalledSigner::Known(&a), &b, KeyChanged),
            (InstalledSigner::Known(&a), &unsigned, SignatureRemoved),
            (InstalledSigner::Unknown, &a, Unverifiable),
            (InstalledSigner::Unknown, &unsigned, Unverifiable),
        ];
        for (installed, incoming, expected) in cases {
            assert_eq!(
                classify_signer_change(*installed, incoming),
                *expected,
                "{installed:?} -> {incoming:?}"
            );
        }
    }

    #[test]
    fn only_risky_kinds_require_confirmation() {
        use SignerChangeKind::*;
        for kind in [Fresh, SameKey, NewlySigned, StillUnsigned] {
            assert!(!kind.requires_confirmation(), "{kind:?}");
        }
        for kind in [KeyChanged, SignatureRemoved, Unverifiable] {
            assert!(kind.requires_confirmation(), "{kind:?}");
        }
    }

    #[test]
    fn package_signer_round_trips_through_json() {
        let s = signed(A);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["kind"], "signed");
        assert_eq!(json["keyId"], A);
        let back: PackageSigner = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);

        let u = serde_json::to_value(PackageSigner::Unsigned).unwrap();
        assert_eq!(u["kind"], "unsigned");
        assert_eq!(PackageSigner::from_key_id(None), PackageSigner::Unsigned);
        assert_eq!(PackageSigner::from_key_id(Some(A)).key_id(), Some(A));
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let change = SignerChange {
            plugin_id: "p".into(),
            plugin_name: "P".into(),
            installed_key_id: Some(A.into()),
            incoming_key_id: Some(B.into()),
            kind: SignerChangeKind::KeyChanged,
        };
        let json = serde_json::to_value(&change).unwrap();
        assert_eq!(json["pluginId"], "p");
        assert_eq!(json["installedKeyId"], A);
        assert_eq!(json["incomingKeyId"], B);
        assert_eq!(json["kind"], "keyChanged");
        let removed = SignerChange {
            incoming_key_id: None,
            kind: SignerChangeKind::SignatureRemoved,
            ..change
        };
        let json = serde_json::to_value(&removed).unwrap();
        assert_eq!(json["kind"], "signatureRemoved");
        assert!(json["incomingKeyId"].is_null());
    }
}
