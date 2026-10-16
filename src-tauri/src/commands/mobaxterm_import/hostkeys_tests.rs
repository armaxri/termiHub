//! Tests for the MobaXterm `[SSH_Hostkeys]` import (#4852).
//!
//! Every fixture is synthetic: the keys were freshly generated with
//! `ssh-keygen` for these tests only (they belong to no machine), the hosts use
//! documentation ranges (192.0.2.x, 203.0.113.x, 2001:db8::) and example.com.
//! Each `*_PUTTY` value is the PuTTY host-key cache spelling of the matching
//! `*_OPENSSH` key, and `*_FP` is what `ssh-keygen -l` prints for it.

use russh::keys::ssh_key::PublicKey;
use termihub_core::backends::ssh::host_key::KnownHostsStatus;

use super::hostkeys::{convert, parse_host_keys, RawHostKey};
use super::preview_from_bytes;
use super::trusted_hosts::{
    host_key_entries, import_host_keys, HostKeySelection, HostKeyTrust, NothingTrusted, StoreTrust,
    TrustCheck,
};
use crate::session::ssh_trust_store::{SshTrustStore, TrustLookup};

const ED25519_PUTTY: &str = "0x64b8e926a10a9590a203499513be95bd55f2d371d77896989e427ea8109f27f2,\
0x1c718b8ef20755c1c8f8c5bbe68217b09173e3f6dfb827bb9eb2739c610fd3a0";
const ED25519_OPENSSH: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKDTD2Gcc7Keuye43/bjc5GwF4Lmu8X4yMFVB/KOi3Ec";
const ED25519_FP: &str = "SHA256:D0k/zRUCvz3ysFQzAG0q7hQl2n/TE2fiVuLyLO5vJFw";

const P256_PUTTY: &str = "nistp256,\
0xf33d663321259b52d7fee729da9f9920ab93f4ff42db50e5cd05213fd0a1ad4d,\
0x5e59cc1f7d95b72a4c1727b7edda0d4048bf13540f2cb5b60d657d4217921394";
const P256_OPENSSH: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPM9ZjMhJZtS1/7nKdqfmSCrk/T/QttQ5c0FIT/Qoa1NXlnMH32VtypMFye37doNQEi/E1QPLLW2DWV9QheSE5Q=";
const P256_FP: &str = "SHA256:GflqyLiIanR7ITcazOlFTzInWEazQAiEfYjhieBmBlw";

const P384_PUTTY: &str = "nistp384,\
0xf651e713bff89ba473be0dc51f82aff396d6102f029ca8622229e0f9cf3edb19e488deec5b3ead1fffe9ec46fbc4ec49,\
0x612429de6acbdac0f3d43fc118b17a6b16347bdeb042a8d8f6d6e35bc23fa76021c176c5b9c846034abe3b07db1b2f8d";
const P384_FP: &str = "SHA256:OsuMJDutweN5tAIQQCb0S/X61sqrVoLkvLIBivNSkuM";

const P521_PUTTY: &str = "nistp521,\
0x109bbd4bb6d81fffffe3da876414541ae2d05dcf0408320a4552409c61882ef0ed5e3cb61f5c454320db4c174e62fb5dfc4a83a9dff476bc848032ca16f7b7de5fb,\
0x18afbaa82db442fc1bb310bf337ae594c4ccdc204c7a0eeb272a113593e307acbb6ac1224ee3d1ff50aefd6f82ca8ec7f8d2957e12acd45474e1e31ab9c670570b";
const P521_FP: &str = "SHA256:Xcm3K2nXVcuY73cfacO6KCRYPGsenECx6CVjYtBXI24";

const RSA_PUTTY: &str = "0x10001,\
0xb7c5687f9994139588735b747f71cd42e4955ff82b5b3489657a683489a6a3dab548f63af6dbbdc93741228a1538b2\
82df702f7b6680f0917554955b6cb006999f03ad94f5ea8fb56d010ab14c7624bfa75133818a980bc7c601fe6bd5fb\
f81914939e53d5679533334d02e72504ae8dc6e7340b9077b0b75efed30e3a37aa095d75eec22f52e615cfac4704da\
c5b3a93e4fc8210a646a327db5a5bbd51c625fe072803f9325c3ff2ff6c31b0a9d9bdb5c66fdae64ae78ed2280d12e\
51344b7266a471f6c5da37f984ed42373c019d5238ae050ec162107ce41c3216ecb808a5c913f0782bb6f1ba396cf2\
9a01a111148b116005c28c5bac852a5a170516ced9";
const RSA_OPENSSH: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3xWh/mZQTlYhzW3R/cc1C5JVf+CtbNIllemg0iaaj2rVI9jr2273JN0EiihU4soLfcC97ZoDwkXVUlVtssAaZnwOtlPXqj7VtAQqxTHYkv6dRM4GKmAvHxgH+a9X7+BkUk55T1WeVMzNNAuclBK6Nxuc0C5B3sLde/tMOOjeqCV117sIvUuYVz6xHBNrFs6k+T8ghCmRqMn21pbvVHGJf4HKAP5Mlw/8v9sMbCp2b21xm/a5krnjtIoDRLlE0S3JmpHH2xdo3+YTtQjc8AZ1SOK4FDsFiEHzkHDIW7LgIpckT8HgrtvG6OWzymgGhERSLEWAFwoxbrIUqWhcFFs7Z";
const RSA_FP: &str = "SHA256:uyN+WW7iOMrYqwASFPd2J96MZycl8gO/tDTD238RSAY";

fn raw(id: &str, value: &str) -> RawHostKey {
    RawHostKey {
        id: id.to_string(),
        value: value.to_string(),
    }
}

fn ok(id: &str, value: &str) -> super::hostkeys::ConvertedHostKey {
    convert(&raw(id, value)).unwrap_or_else(|e| panic!("{id} converts: {e}"))
}

fn err(id: &str, value: &str) -> String {
    convert(&raw(id, value)).expect_err(&format!("{id}={value} must be rejected"))
}

/// A synthetic ini with the host-key section between unrelated sections.
fn ini() -> String {
    format!(
        "[Bookmarks]\r\nSubRep=\r\n\
         [SSH_Hostkeys]\r\n\
         ssh-ed25519@22:203.0.113.5={ED25519_PUTTY}\r\n\
         ecdsa-sha2-nistp256@2222:server.example.com={P256_PUTTY}\r\n\
         rsa2@22:192.0.2.7={RSA_PUTTY}\r\n\
         dss@22:192.0.2.8=0x1,0x2,0x3,0x4\r\n\
         \r\n\
         [Misc]\r\nssh-ed25519@22:192.0.2.99={ED25519_PUTTY}\r\n"
    )
}

#[test]
fn parse_reads_only_the_host_key_section() {
    let keys = parse_host_keys(&ini());
    let ids: Vec<&str> = keys.iter().map(|k| k.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "ssh-ed25519@22:203.0.113.5",
            "ecdsa-sha2-nistp256@2222:server.example.com",
            "rsa2@22:192.0.2.7",
            "dss@22:192.0.2.8",
        ]
    );
    assert_eq!(keys[0].value, ED25519_PUTTY);
}

#[test]
fn every_supported_type_converts_to_the_ssh_keygen_key() {
    let ed = ok("ssh-ed25519@22:203.0.113.5", ED25519_PUTTY);
    assert_eq!(
        ed.known_hosts_line,
        format!("203.0.113.5 {ED25519_OPENSSH}")
    );
    assert_eq!(ed.fingerprint, ED25519_FP);
    assert_eq!(ed.key_type, "ssh-ed25519");

    let ec = ok("ecdsa-sha2-nistp256@22:server.example.com", P256_PUTTY);
    assert_eq!(
        ec.known_hosts_line,
        format!("server.example.com {P256_OPENSSH}")
    );
    assert_eq!(ec.fingerprint, P256_FP);

    let rsa = ok("rsa2@22:192.0.2.7", RSA_PUTTY);
    assert_eq!(rsa.known_hosts_line, format!("192.0.2.7 {RSA_OPENSSH}"));
    assert_eq!(rsa.fingerprint, RSA_FP);
    assert_eq!(rsa.key_type, "ssh-rsa");

    assert_eq!(
        ok("ecdsa-sha2-nistp384@22:192.0.2.1", P384_PUTTY).fingerprint,
        P384_FP
    );
    assert_eq!(
        ok("ecdsa-sha2-nistp521@22:192.0.2.1", P521_PUTTY).fingerprint,
        P521_FP
    );
}

#[test]
fn ecdsa_without_curve_prefix_is_accepted() {
    let bare = P256_PUTTY.trim_start_matches("nistp256,");
    assert_eq!(
        ok("ecdsa-sha2-nistp256@22:192.0.2.1", bare).fingerprint,
        P256_FP
    );
}

#[test]
fn non_default_port_and_ipv6_hosts() {
    let k = ok("ssh-ed25519@2222:server.example.com", ED25519_PUTTY);
    assert_eq!(k.port, 2222);
    assert!(k.known_hosts_line.starts_with("[server.example.com]:2222 "));
    let v6 = ok("ssh-ed25519@22:2001:db8::1", ED25519_PUTTY);
    assert_eq!(v6.host, "2001:db8::1");
    assert_eq!(v6.port, 22);
}

#[test]
fn hosts_that_are_patterns_or_lists_are_rejected() {
    for host in [
        "",
        "a host",
        "a\thost",
        "a,b",
        "*.example.com",
        "host?",
        "!host",
        "[192.0.2.1]",
        "user@host",
    ] {
        let id = format!("ssh-ed25519@22:{host}");
        assert!(
            convert(&raw(&id, ED25519_PUTTY)).is_err(),
            "host {host:?} must be rejected"
        );
    }
}

#[test]
fn bad_ports_and_entry_names_are_rejected() {
    for id in [
        "ssh-ed25519@0:192.0.2.1",
        "ssh-ed25519@65536:192.0.2.1",
        "ssh-ed25519@+22:192.0.2.1",
        "ssh-ed25519@:192.0.2.1",
        "ssh-ed25519:192.0.2.1",
        "ssh-ed25519@22",
    ] {
        assert!(convert(&raw(id, ED25519_PUTTY)).is_err(), "{id}");
    }
}

#[test]
fn unknown_and_unsupported_types_are_rejected() {
    assert!(err("dss@22:192.0.2.1", "0x1,0x2,0x3,0x4").contains("DSA"));
    assert!(err("ssh-ed448@22:192.0.2.1", "0x1,0x2").contains("Ed448"));
    assert!(err("ssh-foo@22:192.0.2.1", "0x1,0x2").contains("Unknown"));
}

#[test]
fn malformed_values_are_rejected() {
    let id = "ssh-ed25519@22:192.0.2.1";
    for value in [
        "",
        "0x1",
        "0x1,0x2,0x3",
        "1c71,0x1c",
        "0x,0x1",
        "0xZZ,0x1",
        "0x1, 0x2",
        "AAAAC3NzaC1lZDI1NTE5AAAAIKDTD2Gcc7Keuye43",
    ] {
        assert!(convert(&raw(id, value)).is_err(), "{value:?}");
    }
}

#[test]
fn a_mismatched_curve_or_key_type_is_rejected() {
    // A P-256 key under a P-384 entry: the curve prefix contradicts the type.
    assert!(err("ecdsa-sha2-nistp384@22:192.0.2.1", P256_PUTTY).contains("does not match"));
    // Without the prefix, the P-256 point is not on P-384.
    let bare = P256_PUTTY.trim_start_matches("nistp256,");
    assert!(convert(&raw("ecdsa-sha2-nistp384@22:192.0.2.1", bare)).is_err());
    // An RSA key spelled under the Ed25519 type is not a curve point.
    assert!(convert(&raw("ssh-ed25519@22:192.0.2.1", RSA_PUTTY)).is_err());
    // An Ed25519 key under the RSA type fails the RSA checks.
    assert!(convert(&raw("rsa2@22:192.0.2.1", ED25519_PUTTY)).is_err());
}

#[test]
fn points_off_their_curve_are_rejected() {
    // Change the last hex digit of y.
    let tweak = |v: &str| {
        let mut s = v.to_string();
        let last = s.pop().expect("non-empty");
        s.push(if last == '0' { '1' } else { '0' });
        s
    };
    assert!(err("ssh-ed25519@22:192.0.2.1", &tweak(ED25519_PUTTY)).contains("curve point"));
    assert!(err("ecdsa-sha2-nistp256@22:192.0.2.1", &tweak(P256_PUTTY)).contains("curve point"));
    // The Ed25519 identity (0, 1) is on the curve but is no key.
    assert!(convert(&raw("ssh-ed25519@22:192.0.2.1", "0x0,0x1")).is_err());
}

#[test]
fn weak_or_malformed_rsa_is_rejected() {
    let id = "rsa2@22:192.0.2.1";
    // Even modulus.
    let even = RSA_PUTTY.trim_end_matches('9').to_string() + "8";
    assert!(err(id, &even).contains("modulus"));
    // 512-bit modulus.
    let short = format!("0x10001,0x{}", "f".repeat(127) + "1");
    assert!(err(id, &short).contains("modulus"));
    // Even and trivial exponents.
    let n = RSA_PUTTY.split_once(',').expect("two fields").1;
    assert!(err(id, &format!("0x10000,{n}")).contains("exponent"));
    assert!(err(id, &format!("0x1,{n}")).contains("exponent"));
}

#[test]
fn preview_lists_host_keys_with_status() {
    let preview = preview_from_bytes(ini().as_bytes(), "/tmp/MobaXterm.ini", &Default::default());
    let statuses: Vec<(&str, &str)> = preview
        .host_keys
        .iter()
        .map(|k| (k.host.as_str(), k.status.as_str()))
        .collect();
    assert_eq!(
        statuses,
        [
            ("203.0.113.5", "new"),
            ("server.example.com", "new"),
            ("192.0.2.7", "new"),
            ("192.0.2.8", "invalid"),
        ]
    );
    let dss = &preview.host_keys[3];
    assert!(dss.reason.as_deref().unwrap_or("").contains("DSA"));
    assert!(dss.fingerprint.is_none());
    assert_eq!(preview.host_keys[1].port, Some(2222));
}

fn system_unknown(_: &str, _: u16, _: &PublicKey) -> KnownHostsStatus {
    KnownHostsStatus::Unknown
}

fn system_changed(_: &str, _: u16, _: &PublicKey) -> KnownHostsStatus {
    KnownHostsStatus::Changed
}

fn system_match(_: &str, _: u16, _: &PublicKey) -> KnownHostsStatus {
    KnownHostsStatus::Match
}

#[test]
fn classification_against_store_and_known_hosts() {
    let store = SshTrustStore::in_memory();
    let key = ok("ssh-ed25519@22:203.0.113.5", ED25519_PUTTY);
    let trust = StoreTrust::with_system(&store, system_unknown);
    assert_eq!(trust.classify(&key), HostKeyTrust::New);

    store.remember("203.0.113.5:22", ED25519_FP);
    assert_eq!(trust.classify(&key), HostKeyTrust::Trusted);

    let other = ok("rsa2@22:203.0.113.5", RSA_PUTTY);
    assert_eq!(trust.classify(&other), HostKeyTrust::ConflictStore);

    let fresh = SshTrustStore::in_memory();
    assert_eq!(
        StoreTrust::with_system(&fresh, system_changed).classify(&key),
        HostKeyTrust::ConflictSystem
    );
    assert_eq!(
        StoreTrust::with_system(&fresh, system_match).classify(&key),
        HostKeyTrust::Trusted
    );
}

fn select(id: &str, fingerprint: &str) -> HostKeySelection {
    HostKeySelection {
        id: id.to_string(),
        fingerprint: fingerprint.to_string(),
    }
}

#[test]
fn import_trusts_only_the_selected_new_keys() {
    let store = SshTrustStore::in_memory();
    let trust = StoreTrust::with_system(&store, system_unknown);
    let text = ini();
    let result = import_host_keys(
        &text,
        &[select("ssh-ed25519@22:203.0.113.5", ED25519_FP)],
        &store,
        &trust,
    );
    assert_eq!(result.imported, 1);
    assert!(result.skipped.is_empty());
    assert_eq!(
        store.lookup("203.0.113.5:22", ED25519_FP),
        TrustLookup::Trusted
    );
    // The unselected RSA key was not trusted.
    assert_eq!(store.lookup("192.0.2.7:22", RSA_FP), TrustLookup::Unknown);

    // A repeat import reports it as already trusted, not re-added.
    let again = import_host_keys(
        &text,
        &[select("ssh-ed25519@22:203.0.113.5", ED25519_FP)],
        &store,
        &trust,
    );
    assert_eq!((again.imported, again.already_trusted), (0, 1));
    assert_eq!(store.fingerprints_for("203.0.113.5:22").len(), 1);
}

#[test]
fn import_never_extends_a_host_that_trusts_a_different_key() {
    let store = SshTrustStore::in_memory();
    store.remember("192.0.2.7:22", ED25519_FP);
    let trust = StoreTrust::with_system(&store, system_unknown);
    let result = import_host_keys(
        &ini(),
        &[select("rsa2@22:192.0.2.7", RSA_FP)],
        &store,
        &trust,
    );
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped.len(), 1);
    assert!(result.skipped[0].contains("different key"));
    assert_eq!(
        store.fingerprints_for("192.0.2.7:22"),
        vec![ED25519_FP.to_string()]
    );
}

#[test]
fn import_refuses_a_key_contradicting_known_hosts() {
    let store = SshTrustStore::in_memory();
    let trust = StoreTrust::with_system(&store, system_changed);
    let result = import_host_keys(
        &ini(),
        &[select("rsa2@22:192.0.2.7", RSA_FP)],
        &store,
        &trust,
    );
    assert_eq!(result.imported, 0);
    assert!(result.skipped[0].contains("known_hosts"));
    assert!(store.entries().is_empty());
}

#[test]
fn import_skips_stale_missing_and_invalid_selections() {
    let store = SshTrustStore::in_memory();
    let trust = StoreTrust::with_system(&store, system_unknown);
    let result = import_host_keys(
        &ini(),
        &[
            // The preview showed another fingerprint: the file changed.
            select("ssh-ed25519@22:203.0.113.5", RSA_FP),
            select("ssh-ed25519@22:198.51.100.1", ED25519_FP),
            select("dss@22:192.0.2.8", "SHA256:x"),
        ],
        &store,
        &trust,
    );
    assert_eq!(result.imported, 0);
    assert_eq!(result.skipped.len(), 3);
    assert!(store.entries().is_empty());
}

#[test]
fn import_accepts_several_key_types_for_one_host() {
    let text = format!(
        "[SSH_Hostkeys]\nssh-ed25519@22:192.0.2.40={ED25519_PUTTY}\nrsa2@22:192.0.2.40={RSA_PUTTY}\n"
    );
    let store = SshTrustStore::in_memory();
    let trust = StoreTrust::with_system(&store, system_unknown);
    let result = import_host_keys(
        &text,
        &[
            select("ssh-ed25519@22:192.0.2.40", ED25519_FP),
            select("rsa2@22:192.0.2.40", RSA_FP),
        ],
        &store,
        &trust,
    );
    assert_eq!(result.imported, 2, "{:?}", result.skipped);
    assert_eq!(store.fingerprints_for("192.0.2.40:22").len(), 2);
}

#[test]
fn entries_use_the_injected_trust() {
    let store = SshTrustStore::in_memory();
    store.remember("203.0.113.5:22", ED25519_FP);
    store.remember("192.0.2.7:22", ED25519_FP);
    let entries = host_key_entries(&ini(), &StoreTrust::with_system(&store, system_unknown));
    let statuses: Vec<&str> = entries.iter().map(|e| e.status.as_str()).collect();
    assert_eq!(statuses, ["trusted", "new", "conflict", "invalid"]);
    assert!(entries[2].reason.is_some());
    let none = host_key_entries(&ini(), &NothingTrusted);
    assert_eq!(none[0].status, "new");
}
