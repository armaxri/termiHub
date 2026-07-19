//! VeNCrypt (RFB security type 19) client-side negotiation over TLS.
//!
//! Upstream `vnc-rs` hard-errors on any security type other than `None`/`VncAuth`.
//! This module — added by the termiHub fork ([issue #1714]) — drives the VeNCrypt
//! 0.2 handshake and, for the TLS/X509 sub-types, wraps the transport in a rustls
//! [`TlsStream`] before completing the inner authentication and handing back a
//! connected [`VncClient`].
//!
//! ## Wire protocol (VeNCrypt 0.2, [rfbproto] / [vencrypt spec])
//!
//! After the client selects security type `19`:
//!
//! 1. Server → 2×U8: highest supported VeNCrypt version (major, minor).
//! 2. Client → 2×U8: the version to use (this fork implements only `0.2`).
//! 3. Server → 1×U8: `0` = version accepted, non-zero = failure.
//! 4. Server → 1×U8 sub-type count `n`, then `n`×U32 offered sub-types.
//! 5. Client → 1×U32: the chosen sub-type (or `0` if none is acceptable).
//! 6. For a TLS/X509 sub-type the TLS handshake begins immediately (no ack byte);
//!    for the bare `Plain` sub-type the stream stays plaintext.
//! 7. The sub-type's second-stage auth runs (`None` / `VncAuth` / `Plain`),
//!    followed by the standard RFB `SecurityResult`.
//!
//! ## Supported sub-types
//!
//! rustls has no anonymous-cipher support, so the anonymous-TLS sub-types
//! (`TLSNone`/`TLSVnc`/`TLSPlain`, 257–259) cannot be negotiated. This fork
//! supports the X509 sub-types (`X509None`/`X509Vnc`/`X509Plain`, 260–262) and
//! the plaintext `Plain` sub-type (256).
//!
//! [issue #1714]: https://github.com/armaxri/termiHub/issues/1714
//! [rfbproto]: https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst
//! [vencrypt spec]: https://www.berrange.com/~dan/vencrypt.txt

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::aws_lc_rs;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio_rustls::TlsConnector;

use super::auth::AuthHelper;
use super::connection::VncClient;
use crate::{PixelFormat, VncEncoding, VncError, VncVersion};

// VeNCrypt 0.2 sub-types (RFB 6.2.19).
const PLAIN: u32 = 256;
const TLS_NONE: u32 = 257;
const TLS_VNC: u32 = 258;
const TLS_PLAIN: u32 = 259;
const X509_NONE: u32 = 260;
const X509_VNC: u32 = 261;
const X509_PLAIN: u32 = 262;

/// How the server's TLS certificate is validated for the X509 VeNCrypt sub-types.
#[derive(Clone)]
pub enum TlsVerify {
    /// Verify against the Mozilla/webpki root store. Rejects self-signed certs.
    Roots,
    /// Verify against the given PEM-encoded CA certificate(s).
    CaPem(Vec<u8>),
    /// Accept **any** server certificate without verification. Insecure — for
    /// self-signed VNC servers whose certificate the user has chosen to trust.
    Insecure,
}

/// Client configuration for the VeNCrypt security type.
///
/// The password is supplied through the connector's existing auth callback (it
/// doubles as the `VncAuth` password and the `Plain` password).
#[derive(Clone)]
pub struct VencryptConfig {
    /// Username for the `Plain` sub-auth. Empty steers sub-type selection toward
    /// the `*Vnc` variants.
    pub username: String,
    /// TLS server name (SNI / certificate hostname) — usually the VNC host.
    pub server_name: String,
    /// How to verify the server's TLS certificate.
    pub verify: TlsVerify,
}

/// The second-stage authentication a sub-type implies, run once the (optional)
/// TLS layer is established.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SubAuth {
    None,
    VncAuth,
    Plain,
}

fn sub_auth(subtype: u32) -> SubAuth {
    match subtype {
        PLAIN | TLS_PLAIN | X509_PLAIN => SubAuth::Plain,
        TLS_VNC | X509_VNC => SubAuth::VncAuth,
        TLS_NONE | X509_NONE => SubAuth::None,
        _ => SubAuth::None,
    }
}

/// Whether the sub-type runs its second stage over a TLS-wrapped transport.
fn needs_tls(subtype: u32) -> bool {
    subtype != PLAIN
}

/// Pick the most preferred sub-type we can actually complete from those offered.
///
/// The anonymous-TLS sub-types (257–259) are excluded — rustls cannot negotiate
/// anonymous ciphers. When a username is available the `*Plain` variants are
/// preferred, otherwise the `*Vnc` variants; the plaintext `Plain` sub-type is
/// the last resort. Returns `None` when nothing supported is on offer.
fn select_subtype(offered: &[u32], have_username: bool) -> Option<u32> {
    let preference: &[u32] = if have_username {
        &[X509_PLAIN, X509_VNC, X509_NONE, PLAIN]
    } else {
        &[X509_VNC, X509_PLAIN, X509_NONE, PLAIN]
    };
    preference
        .iter()
        .copied()
        .find(|t| offered.contains(t))
}

/// Drive the VeNCrypt handshake to a connected [`VncClient`].
///
/// The caller must already have selected security type `19` (written the single
/// byte) before calling this. `stream` is positioned at the server's VeNCrypt
/// version bytes.
#[allow(clippy::too_many_arguments)]
pub(super) async fn connect<S>(
    mut stream: S,
    cfg: &VencryptConfig,
    password: String,
    rfb_version: VncVersion,
    shared: bool,
    pixel_format: Option<PixelFormat>,
    encodings: Vec<VncEncoding>,
) -> Result<VncClient, VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // 1. Server VeNCrypt version.
    let major = stream.read_u8().await?;
    let minor = stream.read_u8().await?;
    // 2. Only 0.2 is implemented; require the server to support at least it.
    if major != 0 || minor < 2 {
        return Err(VncError::Vencrypt(format!(
            "unsupported VeNCrypt version {major}.{minor} (this client requires 0.2)"
        )));
    }
    stream.write_all(&[0, 2]).await?;
    stream.flush().await?;

    // 3. Version ack.
    let ack = stream.read_u8().await?;
    if ack != 0 {
        return Err(VncError::Vencrypt(
            "server rejected VeNCrypt version 0.2".to_string(),
        ));
    }

    // 4. Offered sub-types.
    let count = stream.read_u8().await?;
    if count == 0 {
        return Err(VncError::Vencrypt(
            "server offered no VeNCrypt sub-types".to_string(),
        ));
    }
    let mut offered = Vec::with_capacity(count as usize);
    for _ in 0..count {
        offered.push(stream.read_u32().await?);
    }

    let chosen = match select_subtype(&offered, !cfg.username.is_empty()) {
        Some(t) => t,
        None => {
            // Tell the server we cannot proceed, then report a clear error.
            let _ = stream.write_u32(0).await;
            let _ = stream.flush().await;
            return Err(VncError::Vencrypt(format!(
                "no supported VeNCrypt sub-type offered (got {offered:?}); the \
                 anonymous-TLS sub-types 257-259 are unsupported (rustls has no \
                 anonymous-cipher support)"
            )));
        }
    };

    // 5. Send the chosen sub-type.
    stream.write_u32(chosen).await?;
    stream.flush().await?;

    let sub = sub_auth(chosen);

    // 6/7. TLS (if any) then inner auth + SecurityResult + client init.
    if needs_tls(chosen) {
        let tls = tls_handshake(stream, cfg).await?;
        finalize(
            tls,
            sub,
            cfg,
            &password,
            rfb_version,
            shared,
            pixel_format,
            encodings,
        )
        .await
    } else {
        finalize(
            stream,
            sub,
            cfg,
            &password,
            rfb_version,
            shared,
            pixel_format,
            encodings,
        )
        .await
    }
}

/// Perform the inner sub-authentication, read the standard `SecurityResult`, and
/// build the connected client. Generic over the (possibly TLS-wrapped) stream.
#[allow(clippy::too_many_arguments)]
async fn finalize<S>(
    mut stream: S,
    sub: SubAuth,
    cfg: &VencryptConfig,
    password: &str,
    rfb_version: VncVersion,
    shared: bool,
    pixel_format: Option<PixelFormat>,
    encodings: Vec<VncEncoding>,
) -> Result<VncClient, VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    match sub {
        SubAuth::None => {}
        SubAuth::VncAuth => {
            // Standard VNC DES challenge/response; the SecurityResult is read below.
            let auth = AuthHelper::read(&mut stream, password).await?;
            auth.write(&mut stream).await?;
            stream.flush().await?;
        }
        SubAuth::Plain => {
            let user = cfg.username.as_bytes();
            let pass = password.as_bytes();
            stream.write_u32(user.len() as u32).await?;
            stream.write_u32(pass.len() as u32).await?;
            stream.write_all(user).await?;
            stream.write_all(pass).await?;
            stream.flush().await?;
        }
    }

    // SecurityResult (RFB 7.1.3): U32, 0 = OK. RFB 3.8 appends a reason string on
    // failure.
    let result = stream.read_u32().await?;
    if result != 0 {
        if let VncVersion::RFB38 = rfb_version {
            let len = stream.read_u32().await?;
            let mut buf = vec![0u8; len as usize];
            stream.read_exact(&mut buf).await?;
            return Err(VncError::Vencrypt(format!(
                "VeNCrypt authentication failed: {}",
                String::from_utf8_lossy(&buf)
            )));
        }
        return Err(VncError::WrongPassword);
    }

    VncClient::new(stream, shared, pixel_format, encodings).await
}

/// Wrap `stream` in a rustls client TLS session per `cfg.verify`.
async fn tls_handshake<S>(stream: S, cfg: &VencryptConfig) -> Result<TlsStream<S>, VncError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let config = build_client_config(&cfg.verify)?;
    let connector = TlsConnector::from(Arc::new(config));
    let name = server_name(&cfg.server_name)?;
    connector
        .connect(name, stream)
        .await
        .map_err(|e| VncError::Tls(format!("VeNCrypt TLS handshake failed: {e}")))
}

/// Build a rustls [`ClientConfig`] for the requested verification mode.
///
/// The provider is pinned to aws-lc-rs explicitly: the tree resolves both
/// aws-lc-rs and ring, so there is no unambiguous process-default provider and
/// `ClientConfig::builder()` would panic.
fn build_client_config(verify: &TlsVerify) -> Result<ClientConfig, VncError> {
    let builder = ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| VncError::Tls(format!("TLS config error: {e}")))?;

    match verify {
        TlsVerify::Roots => {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Ok(builder.with_root_certificates(roots).with_no_client_auth())
        }
        TlsVerify::CaPem(pem) => {
            let mut roots = RootCertStore::empty();
            let mut reader = std::io::BufReader::new(pem.as_slice());
            for cert in rustls_pemfile::certs(&mut reader) {
                let cert = cert.map_err(|e| VncError::Tls(format!("invalid CA PEM: {e}")))?;
                roots
                    .add(cert)
                    .map_err(|e| VncError::Tls(format!("invalid CA certificate: {e}")))?;
            }
            if roots.is_empty() {
                return Err(VncError::Tls(
                    "CA PEM contained no certificates".to_string(),
                ));
            }
            Ok(builder.with_root_certificates(roots).with_no_client_auth())
        }
        TlsVerify::Insecure => Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerifier::new()))
            .with_no_client_auth()),
    }
}

fn server_name(host: &str) -> Result<ServerName<'static>, VncError> {
    ServerName::try_from(host.to_string())
        .map_err(|e| VncError::Tls(format!("invalid TLS server name '{host}': {e}")))
}

/// A [`ServerCertVerifier`] that accepts any certificate, backing [`TlsVerify::Insecure`].
#[derive(Debug)]
struct NoVerifier {
    schemes: Vec<SignatureScheme>,
}

impl NoVerifier {
    fn new() -> Self {
        Self {
            schemes: aws_lc_rs::default_provider()
                .signature_verification_algorithms
                .supported_schemes(),
        }
    }
}

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.schemes.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_auth_maps_each_subtype() {
        assert_eq!(sub_auth(PLAIN), SubAuth::Plain);
        assert_eq!(sub_auth(TLS_PLAIN), SubAuth::Plain);
        assert_eq!(sub_auth(X509_PLAIN), SubAuth::Plain);
        assert_eq!(sub_auth(TLS_VNC), SubAuth::VncAuth);
        assert_eq!(sub_auth(X509_VNC), SubAuth::VncAuth);
        assert_eq!(sub_auth(TLS_NONE), SubAuth::None);
        assert_eq!(sub_auth(X509_NONE), SubAuth::None);
    }

    #[test]
    fn only_plain_skips_tls() {
        assert!(!needs_tls(PLAIN));
        for t in [TLS_NONE, TLS_VNC, TLS_PLAIN, X509_NONE, X509_VNC, X509_PLAIN] {
            assert!(needs_tls(t), "{t} should use TLS");
        }
    }

    #[test]
    fn selection_prefers_vnc_without_username() {
        // All X509 variants offered, no username → X509Vnc wins.
        let offered = [X509_NONE, X509_VNC, X509_PLAIN];
        assert_eq!(select_subtype(&offered, false), Some(X509_VNC));
    }

    #[test]
    fn selection_prefers_plain_with_username() {
        let offered = [X509_NONE, X509_VNC, X509_PLAIN];
        assert_eq!(select_subtype(&offered, true), Some(X509_PLAIN));
    }

    #[test]
    fn selection_excludes_anonymous_tls_subtypes() {
        // Only the anonymous-TLS sub-types are offered → nothing selectable.
        let offered = [TLS_NONE, TLS_VNC, TLS_PLAIN];
        assert_eq!(select_subtype(&offered, false), None);
        assert_eq!(select_subtype(&offered, true), None);
    }

    #[test]
    fn selection_falls_back_to_plain() {
        assert_eq!(select_subtype(&[PLAIN], false), Some(PLAIN));
        // X509 is preferred over bare Plain when both are on offer.
        assert_eq!(select_subtype(&[PLAIN, X509_VNC], false), Some(X509_VNC));
    }

    #[test]
    fn selection_none_when_nothing_supported() {
        assert_eq!(select_subtype(&[], false), None);
        assert_eq!(select_subtype(&[999, 1000], false), None);
    }

    #[test]
    fn insecure_verifier_builds() {
        // Exercises the aws-lc-rs provider + custom-verifier config path.
        assert!(build_client_config(&TlsVerify::Insecure).is_ok());
    }

    #[test]
    fn roots_verifier_builds() {
        assert!(build_client_config(&TlsVerify::Roots).is_ok());
    }

    #[test]
    fn empty_ca_pem_is_rejected() {
        let err = build_client_config(&TlsVerify::CaPem(b"not a cert".to_vec()));
        assert!(err.is_err());
    }

    #[test]
    fn server_name_accepts_host_and_ip() {
        assert!(server_name("vnc.example.com").is_ok());
        assert!(server_name("127.0.0.1").is_ok());
        assert!(server_name("not a valid name").is_err());
    }
}
