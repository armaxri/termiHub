//! The one current-user SID / protected-DACL helper for termiHub's per-user
//! Windows endpoints (#4322, DUP2-004).
//!
//! Every local endpoint that must be reachable by the current user only — the
//! core local-IPC named pipes (AGT-022), the agent's ssh-agent relay pipe
//! (AGT2-005) and the plugin runner's private channel pipe (#4201) — gets its
//! security descriptor from here, so a hardening fix lands in all of them at once.
//!
//! * [`dacl_sddl`] builds the SDDL for a **protected** DACL (`D:P`, so nothing is
//!   inherited from the parent) that grants `GENERIC_ALL` to the current user,
//!   any extra SIDs the caller names, and optionally `LocalSystem`. It is pure and
//!   compiles on every platform, so its shape is unit-tested everywhere.
//! * On Windows, `ProtectedDacl` owns the converted descriptor plus the
//!   `SECURITY_ATTRIBUTES` that point at it (for `CreateNamedPipeW` and friends)
//!   and can stamp the DACL on an existing file or directory
//!   (`ProtectedDacl::apply_to_path`).
//! * `current_user_sid_string` and `peer_sid_string` resolve the SIDs the
//!   per-user policy compares; [`DaclSummary`] reads a DACL back so tests can
//!   assert exactly which ACEs an object carries.

use std::fmt::Write as _;
use std::io;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{
    current_user_sid_string, dacl_of_descriptor, dacl_of_handle, dacl_of_path, peer_sid_string,
    sid_string_from_token, sid_to_string, ProtectedDacl,
};

/// The well-known `LocalSystem` SID, as `ConvertSidToStringSidW` renders it
/// (the SDDL alias `SY`).
pub const LOCAL_SYSTEM_SID: &str = "S-1-5-18";

/// `GENERIC_ALL`: the access mask of every non-inheritable ACE built by
/// [`dacl_sddl`] (pipes and other kernel objects).
pub const GENERIC_ALL: u32 = 0x1000_0000;

/// `FILE_ALL_ACCESS`: what the kernel maps `GENERIC_ALL` to when a descriptor
/// is stored on a file, directory or named pipe.
pub const FILE_ALL_ACCESS: u32 = 0x001F_01FF;

/// `ACCESS_ALLOWED_ACE_TYPE`.
pub const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

/// `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`: the flags an ACE built with
/// [`DaclSpec::inherit_to_children`] carries.
pub const OBJECT_AND_CONTAINER_INHERIT: u8 = 0x1 | 0x2;

/// Which principals a protected DACL grants, besides the current user (who is
/// always granted).
#[derive(Clone, Copy, Debug, Default)]
pub struct DaclSpec<'a> {
    /// Extra SIDs (`S-1-…` form only) to grant `GENERIC_ALL`, e.g. the plugin
    /// runner's AppContainer SID (#4187).
    pub extra_sids: &'a [&'a str],
    /// Also grant `LocalSystem` (`SY`). The core local-IPC endpoints do; the
    /// plugin runner's private pipe does not.
    pub include_system: bool,
    /// Mark every ACE object- and container-inheritable (`OICI`), so files and
    /// folders created inside a directory carrying this DACL get the same
    /// grants. Only meaningful for a directory.
    ///
    /// Inheritable ACEs grant the specific `FILE_ALL_ACCESS` rather than
    /// `GENERIC_ALL`: Windows splits an inheritable *generic* ACE stored on a
    /// directory into an effective ACE (rights mapped to `FILE_ALL_ACCESS`)
    /// plus an inherit-only `GENERIC_ALL` ACE. The specific right is the same
    /// access on the directory and on everything created inside it, and
    /// leaves exactly one ACE per principal.
    pub inherit_to_children: bool,
}

impl DaclSpec<'_> {
    /// The current user and `LocalSystem`: the policy of the core local-IPC
    /// endpoints (`ListenerSecurity::CurrentUserOnly`).
    pub const CURRENT_USER_AND_SYSTEM: DaclSpec<'static> = DaclSpec {
        extra_sids: &[],
        include_system: true,
        inherit_to_children: false,
    };
}

/// Whether `sid` is an `S-1-<digits and dashes>` string: the only form that may
/// be spliced into an SDDL string (an SDDL alias or a stray `)` would let a
/// caller widen the DACL).
pub fn is_sid_string(sid: &str) -> bool {
    sid.strip_prefix("S-1-").is_some_and(|rest| {
        !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit() || b == b'-')
    })
}

/// The SDDL of a protected DACL granting full control to `user_sid`, then to
/// each of `spec.extra_sids`, then (with `spec.include_system`) to `SY`, and to
/// nobody else. Full control is `GENERIC_ALL`, or `FILE_ALL_ACCESS` for
/// inheritable ACEs (see [`DaclSpec::inherit_to_children`]).
///
/// Every SID must pass [`is_sid_string`]; anything else is refused with
/// `InvalidInput` rather than spliced into the descriptor.
pub fn dacl_sddl(user_sid: &str, spec: &DaclSpec<'_>) -> io::Result<String> {
    let (flags, rights) = if spec.inherit_to_children {
        ("OICI", "FA")
    } else {
        ("", "GA")
    };
    let mut sddl = String::from("D:P");
    for sid in std::iter::once(&user_sid).chain(spec.extra_sids.iter()) {
        if !is_sid_string(sid) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("`{sid}` is not a SID"),
            ));
        }
        // Writing to a `String` cannot fail.
        let _ = write!(sddl, "(A;{flags};{rights};;;{sid})");
    }
    if spec.include_system {
        let _ = write!(sddl, "(A;{flags};{rights};;;SY)");
    }
    Ok(sddl)
}

/// One ACE of a DACL, as [`DaclSummary`] reads it back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ace {
    /// The ACE type (`ACCESS_ALLOWED_ACE_TYPE` is 0).
    pub ace_type: u8,
    /// The ACE flags (inheritance bits, `INHERITED_ACE`, …).
    pub flags: u8,
    /// The access mask.
    pub mask: u32,
    /// The trustee SID in `S-1-…` form; `None` for an ACE type whose SID is
    /// not read (anything but an access-allowed ACE).
    pub sid: Option<String>,
}

impl Ace {
    /// Whether this ACE allows full control: `GENERIC_ALL`, or the
    /// `FILE_ALL_ACCESS` the kernel stores it as on a file object.
    pub fn allows_full_control(&self) -> bool {
        self.ace_type == ACCESS_ALLOWED_ACE_TYPE
            && (self.mask == GENERIC_ALL || self.mask == FILE_ALL_ACCESS)
    }
}

/// A DACL read back from a descriptor, handle or path: whether it is protected
/// from inheritance, and its ACEs in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaclSummary {
    /// `SE_DACL_PROTECTED` is set on the descriptor.
    pub protected: bool,
    /// Whether the descriptor has a DACL at all (a missing or NULL DACL grants
    /// everyone everything).
    pub present: bool,
    /// The ACEs, in order.
    pub aces: Vec<Ace>,
}

impl DaclSummary {
    /// Whether this is a present, protected DACL whose ACEs each allow full
    /// control to exactly one of `sids`, every one of `sids` once, and nothing
    /// else — the shape [`dacl_sddl`] builds.
    pub fn grants_full_control_to_exactly(&self, sids: &[&str]) -> bool {
        if !self.present || !self.protected || self.aces.len() != sids.len() {
            return false;
        }
        let mut granted: Vec<&str> = Vec::with_capacity(self.aces.len());
        for ace in &self.aces {
            match (&ace.sid, ace.allows_full_control()) {
                (Some(sid), true) => granted.push(sid),
                _ => return false,
            }
        }
        let mut expected: Vec<&str> = sids.to_vec();
        granted.sort_unstable();
        expected.sort_unstable();
        granted == expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn only_sid_strings_are_accepted() {
        assert!(is_sid_string("S-1-15-2-1-2-3"));
        assert!(is_sid_string(USER));
        assert!(!is_sid_string("S-1-"));
        assert!(!is_sid_string("WD"));
        assert!(!is_sid_string("SY"));
        assert!(!is_sid_string("S-1-5)(A;;GA;;;WD"));
    }

    #[test]
    fn current_user_and_system_dacl_is_protected_and_grants_only_them() {
        assert_eq!(
            dacl_sddl(USER, &DaclSpec::CURRENT_USER_AND_SYSTEM).unwrap(),
            format!("D:P(A;;GA;;;{USER})(A;;GA;;;SY)")
        );
    }

    #[test]
    fn extra_sids_follow_the_user_and_system_is_optional() {
        let spec = DaclSpec {
            extra_sids: &["S-1-15-2-9"],
            ..DaclSpec::default()
        };
        assert_eq!(
            dacl_sddl(USER, &spec).unwrap(),
            format!("D:P(A;;GA;;;{USER})(A;;GA;;;S-1-15-2-9)")
        );
    }

    #[test]
    fn inheritable_aces_carry_oici() {
        let spec = DaclSpec {
            include_system: true,
            inherit_to_children: true,
            ..DaclSpec::default()
        };
        assert_eq!(
            dacl_sddl(USER, &spec).unwrap(),
            format!("D:P(A;OICI;FA;;;{USER})(A;OICI;FA;;;SY)")
        );
    }

    #[test]
    fn a_non_sid_is_refused_rather_than_spliced() {
        let spec = DaclSpec {
            extra_sids: &["S-1-5)(A;;GA;;;WD"],
            ..DaclSpec::default()
        };
        let err = dacl_sddl(USER, &spec).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        let err = dacl_sddl("WD", &DaclSpec::default()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    fn allow(sid: &str, mask: u32) -> Ace {
        Ace {
            ace_type: ACCESS_ALLOWED_ACE_TYPE,
            flags: 0,
            mask,
            sid: Some(sid.to_string()),
        }
    }

    #[test]
    fn summary_matches_only_the_exact_protected_grant_set() {
        let good = DaclSummary {
            protected: true,
            present: true,
            aces: vec![
                allow(USER, FILE_ALL_ACCESS),
                allow(LOCAL_SYSTEM_SID, GENERIC_ALL),
            ],
        };
        assert!(good.grants_full_control_to_exactly(&[LOCAL_SYSTEM_SID, USER]));
        assert!(!good.grants_full_control_to_exactly(&[USER]));

        let unprotected = DaclSummary {
            protected: false,
            ..good.clone()
        };
        assert!(!unprotected.grants_full_control_to_exactly(&[USER, LOCAL_SYSTEM_SID]));

        let mut everyone = good.clone();
        everyone.aces.push(allow("S-1-1-0", 0x0012_019F));
        assert!(!everyone.grants_full_control_to_exactly(&[USER, LOCAL_SYSTEM_SID]));

        let mut partial = good.clone();
        partial.aces[0].mask = 0x0012_019F;
        assert!(!partial.grants_full_control_to_exactly(&[USER, LOCAL_SYSTEM_SID]));

        let absent = DaclSummary {
            present: false,
            aces: Vec::new(),
            ..good
        };
        assert!(!absent.grants_full_control_to_exactly(&[]));
    }
}
