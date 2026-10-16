use super::*;

fn cert(der: &[u8], key: &[u8]) -> StoreCert {
    StoreCert {
        der: der.to_vec(),
        public_key: key.to_vec(),
        server_auth: true,
        time_valid: true,
    }
}

#[test]
fn only_server_auth_roots_in_their_validity_period_are_exported() {
    let good = cert(b"good", b"k1");
    let client_only = StoreCert {
        server_auth: false,
        ..cert(b"client-only", b"k2")
    };
    let expired = StoreCert {
        time_valid: false,
        ..cert(b"expired", b"k3")
    };
    assert_eq!(
        select_roots(&[good, client_only, expired], &[]),
        vec![b"good".to_vec()]
    );
}

#[test]
fn disallowed_certificates_are_excluded_by_bytes_or_public_key() {
    let trusted = [
        cert(b"distrusted", b"k1"),
        cert(b"reissued", b"k2"),
        cert(b"fine", b"k3"),
    ];
    let disallowed = [cert(b"distrusted", b"other"), cert(b"old-issue", b"k2")];
    assert_eq!(select_roots(&trusted, &disallowed), vec![b"fine".to_vec()]);
}

#[test]
fn a_disallowed_entry_without_a_key_matches_by_bytes_only() {
    let trusted = [cert(b"a", b""), cert(b"b", b"")];
    let disallowed = [cert(b"a", b"")];
    assert_eq!(select_roots(&trusted, &disallowed), vec![b"b".to_vec()]);
}

#[test]
fn duplicates_collapse_and_the_order_is_stable() {
    // The same root in several stores (current user, local machine, AuthRoot).
    let a = cert(b"root-a", b"ka");
    let b = cert(b"root-b", b"kb");
    let once = select_roots(&[a.clone(), b.clone()], &[]);
    let shuffled = select_roots(&[b.clone(), a.clone(), b, a], &[]);
    assert_eq!(once.len(), 2);
    assert_eq!(once, shuffled);
}

#[test]
fn the_server_auth_usage_is_recognised() {
    assert!(
        admits_server_auth(None),
        "no restriction admits every usage"
    );
    assert!(!admits_server_auth(Some(&[])), "an empty list admits none");
    assert!(admits_server_auth(Some(&[
        "1.3.6.1.5.5.7.3.2".to_owned(),
        "1.3.6.1.5.5.7.3.1".to_owned(),
    ])));
    assert!(!admits_server_auth(Some(&["1.3.6.1.5.5.7.3.3".to_owned()])));
}

#[test]
fn the_pem_holds_certificate_blocks_only_wrapped_at_64() {
    let der: Vec<u8> = (0..=255u8).collect();
    let pem = render_pem(&[der.clone(), vec![1, 2, 3]]);
    assert_eq!(pem.matches("-----BEGIN CERTIFICATE-----\n").count(), 2);
    assert_eq!(pem.matches("-----END CERTIFICATE-----\n").count(), 2);
    assert!(!pem.contains("PRIVATE KEY"));
    assert!(pem.lines().all(|line| line.len() <= 64));
    // The first block decodes back to the DER.
    use base64::Engine as _;
    let body: String = pem
        .lines()
        .skip(1)
        .take_while(|line| !line.starts_with("-----END"))
        .collect();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap(),
        der
    );
    assert_eq!(render_pem(&[]), "");
}

#[test]
fn the_snapshot_is_rewritten_only_when_it_changed() {
    let tmp = tempfile::TempDir::new().unwrap();
    let file = tmp.path().join(TLS_ROOTS_FILE_NAME);
    assert!(write_if_changed(&file, b"one").unwrap());
    assert!(!write_if_changed(&file, b"one").unwrap());
    assert!(write_if_changed(&file, b"two").unwrap());
    assert_eq!(std::fs::read(&file).unwrap(), b"two");
    // No temporary file is left behind.
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn the_snapshot_lives_outside_the_data_folder() {
    let root = Path::new("/plugins");
    let path = snapshot_path(root, "acme");
    assert_eq!(path, Path::new("/plugins/.tls-roots/acme/system-roots.pem"));
    assert!(!path.starts_with(root.join(crate::plugin::PLUGIN_DATA_DIR_NAME)));
}

#[test]
fn a_symlink_in_place_of_the_folder_is_refused() {
    let tmp = tempfile::TempDir::new().unwrap();
    let file = tmp.path().join("file");
    std::fs::write(&file, b"x").unwrap();
    assert!(ensure_real_dir(&file).is_err());
    let folder = tmp.path().join("a").join("b");
    ensure_real_dir(&folder).unwrap();
    assert!(folder.is_dir());
    ensure_real_dir(&folder).unwrap();
    #[cfg(unix)]
    {
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&folder, &link).unwrap();
        assert!(ensure_real_dir(&link).is_err());
    }
}

#[test]
fn the_snapshot_folder_goes_with_the_plugin() {
    let tmp = tempfile::TempDir::new().unwrap();
    let file = snapshot_path(tmp.path(), "acme");
    ensure_real_dir(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"pem").unwrap();
    remove_snapshot(tmp.path(), "acme").unwrap();
    assert!(!file.parent().unwrap().exists());
    // Absent, and an invalid id, are no-ops.
    remove_snapshot(tmp.path(), "acme").unwrap();
    remove_snapshot(tmp.path(), "..").unwrap();
    assert!(tmp.path().join(TLS_ROOTS_DIR_NAME).is_dir());
}

#[test]
fn the_host_never_hands_its_own_ssl_cert_file_through() {
    assert!(!super::super::spawn::PASSED_ENV.contains(&SSL_CERT_FILE_ENV));
}

/// Windows: the machine's stores export to a non-empty snapshot of
/// certificates only.
#[cfg(windows)]
#[test]
fn the_system_stores_export_a_snapshot() {
    let trusted = windows::trusted_candidates().unwrap();
    let disallowed = windows::disallowed().unwrap();
    let roots = select_roots(&trusted, &disallowed);
    assert!(!roots.is_empty(), "{} candidates", trusted.len());
    let pem = render_pem(&roots);
    assert!(!pem.contains("PRIVATE KEY"));
}
