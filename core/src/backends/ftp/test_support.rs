//! Test-only FTPS trust anchors (#4006).
//!
//! The shipping FTPS client trusts the Mozilla root store and nothing else, so
//! a handshake against a fixture whose certificate is signed by a throwaway
//! test CA cannot succeed. This module lets **tests** add such a CA to the
//! trust store of every FTPS connector built afterwards in the process.
//!
//! It is compiled only behind the `ftp-test-support` feature, which no shipping
//! build enables (the desktop and the agent depend on `ftp` alone), and it only
//! ever *adds* a root: certificate, name and validity checks stay exactly as in
//! production. A test that trusts the fixture CA still fails on an expired or
//! mis-named leaf, so the FTPS integration test exercises the real
//! verification path rather than bypassing it.

use std::sync::Mutex;

use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::CertificateDer;
use tokio_rustls::rustls::RootCertStore;

/// Extra roots added by tests, in registration order.
static EXTRA_ROOTS: Mutex<Vec<CertificateDer<'static>>> = Mutex::new(Vec::new());

/// Trust every certificate in `pem` as an additional FTPS root for this
/// process. Returns how many certificates were added.
///
/// Idempotent per certificate: registering the same CA twice keeps one copy,
/// so calling it from every test is harmless.
pub fn trust_test_root_pem(pem: &[u8]) -> Result<usize, String> {
    let certs = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("invalid PEM certificate: {e}"))?;
    if certs.is_empty() {
        return Err("no certificate found in PEM".to_string());
    }
    let mut roots = EXTRA_ROOTS.lock().map_err(|e| e.to_string())?;
    for cert in certs {
        if !roots.contains(&cert) {
            roots.push(cert);
        }
    }
    Ok(roots.len())
}

/// Add the registered test roots to `store`. A certificate rustls rejects as
/// a trust anchor is skipped, the same as a malformed Mozilla root would be.
pub(super) fn add_test_roots(store: &mut RootCertStore) {
    if let Ok(roots) = EXTRA_ROOTS.lock() {
        let _ = store.add_parsable_certificates(roots.iter().cloned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_input_without_a_certificate() {
        assert!(trust_test_root_pem(b"not a pem").is_err());
    }
}
