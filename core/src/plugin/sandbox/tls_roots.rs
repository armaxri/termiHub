//! Windows: the host-provided TLS root snapshot of a sandboxed plugin (#4811).
//!
//! A plugin's Less-Privileged AppContainer cannot open the system trust store:
//! `CertOpenSystemStore` (current-user and local-machine `ROOT`) and the
//! CryptoAPI chain engine are denied inside it, and no capability opens them
//! without also opening `HKCU\Software` (#4606). So before each runner start
//! the **unconfined host** exports the roots the system trusts for server
//! authentication into a PEM file, grants the plugin's AppContainer read
//! access to it, and points the runner's `SSL_CERT_FILE` at it.
//! `rustls-native-certs` (and OpenSSL-style loaders) read `SSL_CERT_FILE`
//! instead of the system store; the platform verifier
//! (`rustls-platform-verifier`, `native-tls`/SChannel) stays unavailable.
//!
//! * **What is exported:** the certificates of the current-user and
//!   local-machine `ROOT` and `AuthRoot` stores that are valid for server
//!   authentication (no enhanced-key-usage restriction, or one that lists
//!   `serverAuth`) and within their validity period — minus every certificate
//!   of the current-user or local-machine `Disallowed` store, matched by its
//!   bytes *or* its public key (a distrusted key stays distrusted when
//!   re-issued). The `CA` (intermediate) store is **not** exported: every
//!   certificate in `SSL_CERT_FILE` becomes a trust anchor, and an
//!   intermediate as an anchor would be trusted without its root.
//! * **Public certificates only:** the file holds `CERTIFICATE` PEM blocks of
//!   the stores' encoded certificates; no private key is ever read.
//! * **Where:** `<plugins root>/.tls-roots/<id>/system-roots.pem`
//!   ([`snapshot_path`]), outside the plugin's writable data folder. The
//!   folder grants the plugin's AppContainer read access only; the plugin
//!   cannot change or replace the file.
//! * **Freshness:** re-exported at every runner start (load, idle respawn,
//!   crash recovery) and rewritten only when it changed. An export that
//!   fails removes any stale file and starts the runner without
//!   `SSL_CERT_FILE`, as before #4811.
//! * **Uninstall:** the plugin's snapshot folder is removed with it
//!   ([`remove_snapshot`]).
//!
//! The selection and the PEM rendering are pure and tested on every OS; the
//! store access is Windows-only.

// The export runs on Windows only; elsewhere the pure parts serve the tests.
#![cfg_attr(
    not(windows),
    allow(dead_code, reason = "the export runs on Windows only")
)]

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Folder under the plugins root holding every plugin's TLS root snapshot
/// folder. It starts with `.`, which a plugin id never does, so it cannot
/// collide with an installed plugin, and the manager's scan skips it (it has
/// no manifest).
pub(crate) const TLS_ROOTS_DIR_NAME: &str = ".tls-roots";

/// The snapshot's file name inside the plugin's snapshot folder.
pub(crate) const TLS_ROOTS_FILE_NAME: &str = "system-roots.pem";

/// The environment variable the runner gets pointing at the snapshot, the one
/// `rustls-native-certs` and OpenSSL read. Never inherited from the host: the
/// scrubbed environment drops it, and the host sets it only to the snapshot.
pub(crate) const SSL_CERT_FILE_ENV: &str = "SSL_CERT_FILE";

/// `id-kp-serverAuth`.
const SERVER_AUTH_OID: &str = "1.3.6.1.5.5.7.3.1";

/// Plugin `id`'s snapshot file under the (canonical) plugins `root`.
pub(crate) fn snapshot_path(root: &Path, id: &str) -> PathBuf {
    root.join(TLS_ROOTS_DIR_NAME)
        .join(id)
        .join(TLS_ROOTS_FILE_NAME)
}

/// Remove plugin `id`'s snapshot folder, if any (on uninstall). Refuses an
/// invalid id and never follows a symlink: a symlinked entry is unlinked.
pub(crate) fn remove_snapshot(plugins_root: &Path, id: &str) -> std::io::Result<()> {
    if !crate::plugin::manifest::is_valid_plugin_id(id) {
        return Ok(());
    }
    let dir = plugins_root.join(TLS_ROOTS_DIR_NAME).join(id);
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&dir),
        Ok(_) => std::fs::remove_file(&dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// A certificate read from a system store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoreCert {
    /// The encoded certificate (DER).
    pub(crate) der: Vec<u8>,
    /// Its subject public key bits.
    pub(crate) public_key: Vec<u8>,
    /// Valid for server authentication (no usage restriction, or `serverAuth`).
    pub(crate) server_auth: bool,
    /// Within its validity period now.
    pub(crate) time_valid: bool,
}

/// Whether a certificate's enhanced key usage — `None` for "every usage" —
/// admits server authentication.
pub(crate) fn admits_server_auth(usages: Option<&[String]>) -> bool {
    usages.is_none_or(|oids| oids.iter().any(|oid| oid == SERVER_AUTH_OID))
}

/// The roots to export: the `trusted` candidates valid for server
/// authentication and in their validity period, minus any `disallowed` one
/// (same bytes or same public key), deduplicated and in a stable order (by
/// SHA-256 of the DER), so an unchanged trust store renders an identical file.
pub(crate) fn select_roots(trusted: &[StoreCert], disallowed: &[StoreCert]) -> Vec<Vec<u8>> {
    let mut roots: Vec<([u8; 32], &[u8])> = trusted
        .iter()
        .filter(|c| c.server_auth && c.time_valid)
        .filter(|c| {
            !disallowed.iter().any(|d| {
                d.der == c.der || (!d.public_key.is_empty() && d.public_key == c.public_key)
            })
        })
        .map(|c| (Sha256::digest(&c.der).into(), c.der.as_slice()))
        .collect();
    roots.sort_unstable_by_key(|a| a.0);
    roots.dedup_by(|a, b| a.0 == b.0);
    roots.into_iter().map(|(_, der)| der.to_vec()).collect()
}

/// Render `roots` (DER) as `CERTIFICATE` PEM blocks, 64 base64 characters a
/// line.
pub(crate) fn render_pem(roots: &[Vec<u8>]) -> String {
    use base64::Engine as _;
    let mut pem = String::new();
    for der in roots {
        let encoded = base64::engine::general_purpose::STANDARD.encode(der);
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        for line in encoded.as_bytes().chunks(64) {
            // Base64 output is ASCII.
            pem.push_str(std::str::from_utf8(line).unwrap_or_default());
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    pem
}

/// Write `contents` to `path` unless it already holds exactly that; returns
/// whether it wrote. The write goes to a sibling temporary file renamed over
/// `path`, so a runner never reads a half-written snapshot.
pub(crate) fn write_if_changed(path: &Path, contents: &[u8]) -> std::io::Result<bool> {
    if std::fs::read(path).is_ok_and(|current| current == contents) {
        return Ok(false);
    }
    let folder = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent folder"))?;
    let mut temp = tempfile::NamedTempFile::new_in(folder)?;
    std::io::Write::write_all(&mut temp, contents)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(true)
}

/// Create `folder` (and its parents) if absent; refuse a symlink or a
/// non-folder in its place.
pub(crate) fn ensure_real_dir(folder: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(folder) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("`{}` is not a folder", folder.display()),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir_all(folder),
        Err(e) => Err(e),
    }
}

/// Windows: export the snapshot to `file` and grant `container` read access
/// to its folder. Returns the file to point `SSL_CERT_FILE` at, or why there
/// is none (any stale file is then removed, so the plugin never reads an
/// out-of-date trust list).
#[cfg(windows)]
pub(super) fn refresh(
    container: &termihub_plugin_runner::appcontainer::AppContainer,
    file: &Path,
) -> Result<PathBuf, String> {
    let outcome = (|| {
        let folder = file
            .parent()
            .ok_or_else(|| format!("`{}` has no folder", file.display()))?;
        ensure_real_dir(folder).map_err(|e| format!("creating `{}`: {e}", folder.display()))?;
        // Read only: no write, no delete, no execute. The grant is
        // inheritable, so the renamed-in file carries it too.
        container
            .grant_tree(
                folder,
                windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ,
            )
            .map_err(|e| format!("granting `{}`: {e}", folder.display()))?;
        let trusted = windows::trusted_candidates()?;
        let disallowed = windows::disallowed()?;
        let roots = select_roots(&trusted, &disallowed);
        if roots.is_empty() {
            return Err("the system stores hold no usable root".to_owned());
        }
        write_if_changed(file, render_pem(&roots).as_bytes())
            .map_err(|e| format!("writing `{}`: {e}", file.display()))?;
        Ok(file.to_owned())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(file);
    }
    outcome
}

/// Windows: the system certificate stores, read-only.
#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{GetLastError, CRYPT_E_NOT_FOUND};
    use windows_sys::Win32::Security::Cryptography::{
        CertCloseStore, CertEnumCertificatesInStore, CertGetEnhancedKeyUsage, CertOpenStore,
        CertVerifyTimeValidity, CERT_CONTEXT, CERT_STORE_OPEN_EXISTING_FLAG,
        CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG, CERT_SYSTEM_STORE_CURRENT_USER,
        CERT_SYSTEM_STORE_LOCAL_MACHINE, CTL_USAGE, HCERTSTORE,
    };

    use super::{admits_server_auth, StoreCert};

    /// The stores whose certificates the system trusts as roots.
    const TRUSTED: &[(u32, &str)] = &[
        (CERT_SYSTEM_STORE_CURRENT_USER, "ROOT"),
        (CERT_SYSTEM_STORE_LOCAL_MACHINE, "ROOT"),
        (CERT_SYSTEM_STORE_CURRENT_USER, "AuthRoot"),
        (CERT_SYSTEM_STORE_LOCAL_MACHINE, "AuthRoot"),
    ];

    /// The stores of explicitly distrusted certificates.
    const DISALLOWED: &[(u32, &str)] = &[
        (CERT_SYSTEM_STORE_CURRENT_USER, "Disallowed"),
        (CERT_SYSTEM_STORE_LOCAL_MACHINE, "Disallowed"),
    ];

    /// `ERROR_FILE_NOT_FOUND`: the store does not exist (nothing in it).
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    pub(super) fn trusted_candidates() -> Result<Vec<StoreCert>, String> {
        read_stores(TRUSTED)
    }

    pub(super) fn disallowed() -> Result<Vec<StoreCert>, String> {
        read_stores(DISALLOWED)
    }

    fn read_stores(stores: &[(u32, &str)]) -> Result<Vec<StoreCert>, String> {
        let mut certs = Vec::new();
        for &(location, name) in stores {
            certs.extend(read_store(location, name)?);
        }
        Ok(certs)
    }

    /// Every certificate of one system store; an absent store is empty.
    fn read_store(location: u32, name: &str) -> Result<Vec<StoreCert>, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: the system-store provider with a NUL-terminated store name,
        // opened read-only; closed below.
        let store: HCERTSTORE = unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                0,
                0,
                location | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG,
                wide.as_ptr().cast(),
            )
        };
        if store.is_null() {
            // SAFETY: reads the calling thread's last error.
            let error = unsafe { GetLastError() };
            if error == ERROR_FILE_NOT_FOUND {
                return Ok(Vec::new());
            }
            return Err(format!(
                "opening the `{name}` store: {}",
                std::io::Error::from_raw_os_error(error as i32)
            ));
        }
        let mut certs = Vec::new();
        let mut cert: *const CERT_CONTEXT = std::ptr::null();
        loop {
            // SAFETY: `store` is open; `cert` is NULL or the previous context,
            // which this call frees.
            cert = unsafe { CertEnumCertificatesInStore(store, cert) };
            if cert.is_null() {
                break;
            }
            // SAFETY: a context from the enumeration, valid until the next
            // call.
            certs.push(unsafe { store_cert(cert) });
        }
        // SAFETY: the enumeration ended (`cert` is NULL, nothing to free);
        // the store is closed once.
        unsafe { CertCloseStore(store, 0) };
        Ok(certs)
    }

    /// Copy what [`super::select_roots`] needs out of a certificate context.
    ///
    /// # Safety
    ///
    /// `cert` must be a valid certificate context.
    unsafe fn store_cert(cert: *const CERT_CONTEXT) -> StoreCert {
        let context = &*cert;
        let der = slice(context.pbCertEncoded, context.cbCertEncoded).to_vec();
        let info = &*context.pCertInfo;
        let key = &info.SubjectPublicKeyInfo.PublicKey;
        let public_key = slice(key.pbData, key.cbData).to_vec();
        let time_valid = CertVerifyTimeValidity(std::ptr::null(), context.pCertInfo) == 0;
        StoreCert {
            der,
            public_key,
            server_auth: admits_server_auth(enhanced_key_usage(cert).as_deref()),
            time_valid,
        }
    }

    /// # Safety
    ///
    /// `data` must point to `len` readable bytes (or `len` be 0).
    unsafe fn slice<'a>(data: *const u8, len: u32) -> &'a [u8] {
        if data.is_null() || len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(data, len as usize)
        }
    }

    /// The certificate's enhanced key usage (extension and properties
    /// combined): `None` for "every usage", else the usage OIDs — empty for
    /// "no usage", including when the usage cannot be read.
    ///
    /// # Safety
    ///
    /// `cert` must be a valid certificate context.
    unsafe fn enhanced_key_usage(cert: *const CERT_CONTEXT) -> Option<Vec<String>> {
        let mut size = 0u32;
        if CertGetEnhancedKeyUsage(cert, 0, std::ptr::null_mut(), &mut size) == 0 {
            // Unreadable: treated as valid for no usage (fail closed).
            return Some(Vec::new());
        }
        // A `CTL_USAGE` followed by its OID pointers and strings, aligned for
        // the pointers.
        let words = (size as usize).div_ceil(std::mem::size_of::<usize>());
        let mut buffer = vec![0usize; words.max(1)];
        let usage = buffer.as_mut_ptr().cast::<CTL_USAGE>();
        if CertGetEnhancedKeyUsage(cert, 0, usage, &mut size) == 0 {
            return Some(Vec::new());
        }
        let usage = &*usage;
        if usage.cUsageIdentifier == 0 {
            // Zero identifiers: every usage when the API says "not found"
            // (no restriction anywhere), otherwise valid for none.
            let unrestricted = GetLastError() == CRYPT_E_NOT_FOUND as u32;
            return if unrestricted { None } else { Some(Vec::new()) };
        }
        let oids =
            std::slice::from_raw_parts(usage.rgpszUsageIdentifier, usage.cUsageIdentifier as usize);
        Some(
            oids.iter()
                .filter(|oid| !oid.is_null())
                .map(|&oid| {
                    std::ffi::CStr::from_ptr(oid.cast_const().cast())
                        .to_string_lossy()
                        .into_owned()
                })
                .collect(),
        )
    }
}

#[cfg(test)]
#[path = "tls_roots_tests.rs"]
mod tests;
