//! MIT-MAGIC-COOKIE-1 provisioning for the managed local X server (issue #1050).
//!
//! When termiHub starts VcXsrv it generates a per-start cookie, writes a
//! standard-format `.Xauthority` file, and launches the server with
//! `-auth <file>`. The same cookie (hex) is reported by
//! [`XServerManager`](super::manager::XServerManager) so the SSH X11 forwarder
//! injects it on the remote host (`xauth add … MIT-MAGIC-COOKIE-1 <cookie>`) —
//! replacing the Unix-only `xauth`-shelling path, which is absent on Windows.
//!
//! The `.Xauthority` entry uses `FamilyWild` so the X server loads it regardless
//! of how the (loopback TCP) client reaches it; MIT-MAGIC-COOKIE-1 then
//! authenticates purely on the cookie value.

use std::path::PathBuf;

use anyhow::Result;
use rand::RngCore;

/// MIT-MAGIC-COOKIE-1 length in bytes (→ 32 hex chars).
pub const COOKIE_LEN: usize = 16;

/// X11 authorization protocol name written into the `.Xauthority` record.
pub const AUTH_PROTOCOL_NAME: &str = "MIT-MAGIC-COOKIE-1";

/// `FamilyWild` — an `.Xauthority` entry that matches any host/transport, so the
/// X server always loads it. See X11 `Xauth`/`family` semantics.
const FAMILY_WILD: u16 = 0xFFFF;

/// Generate a fresh random 16-byte MIT-MAGIC-COOKIE-1.
pub fn generate_cookie() -> [u8; COOKIE_LEN] {
    let mut cookie = [0u8; COOKIE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut cookie);
    cookie
}

/// Lowercase-hex encoding of a cookie (32 chars for a 16-byte cookie).
pub fn cookie_to_hex(cookie: &[u8]) -> String {
    use std::fmt::Write;
    cookie.iter().fold(String::with_capacity(cookie.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Build the binary `.Xauthority` record for `display` and `cookie`.
///
/// Layout (all lengths big-endian `u16`): family, address, number (display as
/// ASCII), name (`MIT-MAGIC-COOKIE-1`), data (the raw cookie bytes).
pub fn xauthority_record(display: u32, cookie: &[u8]) -> Vec<u8> {
    fn push_sized(out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        out.extend_from_slice(bytes);
    }

    let number = display.to_string();
    let mut record = Vec::new();
    record.extend_from_slice(&FAMILY_WILD.to_be_bytes());
    push_sized(&mut record, &[]); // address (empty for FamilyWild)
    push_sized(&mut record, number.as_bytes());
    push_sized(&mut record, AUTH_PROTOCOL_NAME.as_bytes());
    push_sized(&mut record, cookie);
    record
}

/// A provisioned cookie plus the `.Xauthority` file that carries it.
#[derive(Debug, Clone)]
pub struct XAuth {
    /// Path to the written `.Xauthority` file (passed to `vcxsrv.exe -auth`).
    pub auth_file: PathBuf,
    /// Lowercase-hex cookie the remote host must present.
    pub cookie_hex: String,
}

/// Provisions cookie auth for a managed X server start.
///
/// Injected into the manager so the lifecycle logic stays filesystem-free in
/// unit tests (a fake returns a fixed cookie without touching disk).
pub trait XAuthProvider: Send + Sync {
    /// Generate a cookie and write an `.Xauthority` for `display`.
    fn provision(&self, display: u32) -> Result<XAuth>;
}

/// Real provider: writes a `.Xauthority` under a configured directory.
pub struct FileXAuthProvider {
    dir: PathBuf,
}

impl FileXAuthProvider {
    /// Create a provider that writes `.Xauthority` files under `dir`.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
}

impl XAuthProvider for FileXAuthProvider {
    fn provision(&self, display: u32) -> Result<XAuth> {
        use anyhow::Context;

        let cookie = generate_cookie();
        let record = xauthority_record(display, &cookie);

        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("failed to create auth dir: {}", self.dir.display()))?;
        let auth_file = self.dir.join(format!(".Xauthority-termihub-{display}"));
        std::fs::write(&auth_file, &record)
            .with_context(|| format!("failed to write .Xauthority: {}", auth_file.display()))?;

        Ok(XAuth {
            auth_file,
            cookie_hex: cookie_to_hex(&cookie),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal `.Xauthority` record parser for round-trip assertions.
    struct ParsedRecord {
        family: u16,
        address: Vec<u8>,
        number: String,
        name: String,
        data: Vec<u8>,
    }

    fn parse_record(bytes: &[u8]) -> ParsedRecord {
        let mut pos = 0;
        let mut read_u16 = |bytes: &[u8], pos: &mut usize| {
            let v = u16::from_be_bytes([bytes[*pos], bytes[*pos + 1]]);
            *pos += 2;
            v
        };
        let family = read_u16(bytes, &mut pos);
        let addr_len = read_u16(bytes, &mut pos) as usize;
        let address = bytes[pos..pos + addr_len].to_vec();
        pos += addr_len;
        let number_len = read_u16(bytes, &mut pos) as usize;
        let number = String::from_utf8(bytes[pos..pos + number_len].to_vec()).unwrap();
        pos += number_len;
        let name_len = read_u16(bytes, &mut pos) as usize;
        let name = String::from_utf8(bytes[pos..pos + name_len].to_vec()).unwrap();
        pos += name_len;
        let data_len = read_u16(bytes, &mut pos) as usize;
        let data = bytes[pos..pos + data_len].to_vec();
        pos += data_len;
        assert_eq!(pos, bytes.len(), "record has trailing bytes");
        ParsedRecord {
            family,
            address,
            number,
            name,
            data,
        }
    }

    #[test]
    fn generate_cookie_is_16_bytes_and_non_constant() {
        let a = generate_cookie();
        let b = generate_cookie();
        assert_eq!(a.len(), COOKIE_LEN);
        assert_ne!(a, b, "cookies must be random, not constant");
    }

    #[test]
    fn cookie_to_hex_is_32_lowercase_hex() {
        let cookie = [0x00u8, 0xff, 0x1a, 0x2b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let hex = cookie_to_hex(&cookie);
        assert_eq!(hex.len(), 32);
        assert!(hex.starts_with("00ff1a2b"));
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn xauthority_record_has_expected_layout() {
        let cookie: [u8; COOKIE_LEN] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        ];
        let record = xauthority_record(0, &cookie);
        let parsed = parse_record(&record);
        assert_eq!(parsed.family, FAMILY_WILD);
        assert!(parsed.address.is_empty());
        assert_eq!(parsed.number, "0");
        assert_eq!(parsed.name, AUTH_PROTOCOL_NAME);
        assert_eq!(parsed.data, cookie);
    }

    #[test]
    fn xauthority_record_encodes_display_number_as_ascii() {
        let cookie = [0u8; COOKIE_LEN];
        let parsed = parse_record(&xauthority_record(7, &cookie));
        assert_eq!(parsed.number, "7");
    }

    #[test]
    fn file_provider_writes_matching_xauthority() {
        let dir = tempfile::tempdir().unwrap();
        let provider = FileXAuthProvider::new(dir.path().to_path_buf());

        let auth = provider.provision(0).unwrap();
        assert!(auth.auth_file.exists(), "auth file must be written");
        assert_eq!(auth.cookie_hex.len(), 32);

        let bytes = std::fs::read(&auth.auth_file).unwrap();
        let parsed = parse_record(&bytes);
        assert_eq!(parsed.name, AUTH_PROTOCOL_NAME);
        // The file's cookie bytes match the reported hex.
        assert_eq!(cookie_to_hex(&parsed.data), auth.cookie_hex);
    }
}
