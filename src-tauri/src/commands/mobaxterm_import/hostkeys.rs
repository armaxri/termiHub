//! MobaXterm `[SSH_Hostkeys]` reader and converter (#4852).
//!
//! MobaXterm keeps the SSH host keys a user has accepted in its ini, in PuTTY's
//! host-key cache format — one line per key:
//!
//! ```text
//! [SSH_Hostkeys]
//! ssh-ed25519@22:203.0.113.5=0x<x>,0x<y>
//! ecdsa-sha2-nistp256@22:server.example.com=nistp256,0x<x>,0x<y>
//! rsa2@2222:192.0.2.7=0x<e>,0x<n>
//! ```
//!
//! The key is `<keytype>@<port>:<host>`; the value spells the public key out as
//! hex numbers (affine curve coordinates, or RSA exponent and modulus) rather
//! than as an SSH wire blob. No crate reads this cache format (the PuTTY-format
//! crates handle `.ppk` key *files*), so this module rebuilds the SSH wire blob
//! from the numbers and hands it to [`ssh_key`](russh::keys::ssh_key) — the
//! library russh itself uses — for decoding, fingerprinting and the OpenSSH
//! encoding. Big-number arithmetic uses [`num_bigint`].
//!
//! Host keys are trust anchors, so the conversion is strict. An entry is
//! rejected (and shown as skipped in the preview) when:
//!
//! - the host is empty or contains anything outside `[A-Za-z0-9.-_:]` — in
//!   particular whitespace, commas, wildcards (`*`, `?`, `!`) or brackets, which
//!   would turn one entry into a pattern or several hosts;
//! - the port is not `1..=65535`;
//! - the key type is unknown or unsupported (`dss`, `ssh-ed448`);
//! - the value has the wrong number of fields, a field is not `0x`-prefixed hex,
//!   or an ECDSA curve prefix does not match the key type;
//! - the numbers do not form a valid key: a curve point that is not on its curve
//!   (or a degenerate one), or an RSA key with an even or tiny modulus or
//!   exponent.

use num_bigint::BigUint;
use russh::keys::ssh_key::PublicKey;
use russh::keys::HashAlg;

/// One raw `[SSH_Hostkeys]` line, split but not yet validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHostKey {
    /// The INI key exactly as written (`<keytype>@<port>:<host>`), used as the
    /// entry's stable identifier.
    pub id: String,
    /// The key value (PuTTY cache format), trimmed.
    pub value: String,
}

/// A host key converted to OpenSSH form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedHostKey {
    /// The host the key was accepted for.
    pub host: String,
    /// The SSH port the key was accepted for.
    pub port: u16,
    /// SSH algorithm name, e.g. `ssh-ed25519`.
    pub key_type: String,
    /// SHA-256 fingerprint in OpenSSH `SHA256:BASE64` form.
    pub fingerprint: String,
    /// The equivalent OpenSSH `known_hosts` line.
    pub known_hosts_line: String,
    /// The decoded key, for consulting `~/.ssh/known_hosts`.
    pub public_key: PublicKey,
}

/// Whether a section header is `[SSH_Hostkeys]` (case-insensitive).
fn is_host_key_section(name: &str) -> bool {
    name.trim().eq_ignore_ascii_case("ssh_hostkeys")
}

/// Read every line of the `[SSH_Hostkeys]` section(s) of `text`, in file order.
/// Lines without `=` or with an empty key are ignored.
pub fn parse_host_keys(text: &str) -> Vec<RawHostKey> {
    let mut out = Vec::new();
    let mut in_section = false;
    for raw_line in text.lines() {
        let trimmed = raw_line.trim_end_matches('\r').trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(section) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_section = is_host_key_section(section);
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        out.push(RawHostKey {
            id: key.to_string(),
            value: value.trim().to_string(),
        });
    }
    out
}

/// The split `<keytype>@<port>:<host>` identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyTarget {
    /// PuTTY key-type token (`rsa2`, `ssh-ed25519`, `ecdsa-sha2-nistp256`, …).
    pub type_token: String,
    /// The port, validated `1..=65535`.
    pub port: u16,
    /// The host, validated against the strict character set.
    pub host: String,
}

/// Split and validate an entry identifier. The host follows the first `:` after
/// the `@`, so an IPv6 address (`2001:db8::1`) stays whole.
pub fn parse_target(id: &str) -> Result<HostKeyTarget, String> {
    let (type_token, rest) = id
        .split_once('@')
        .ok_or_else(|| "The entry name is not <keytype>@<port>:<host>.".to_string())?;
    let (port, host) = rest
        .split_once(':')
        .ok_or_else(|| "The entry name is not <keytype>@<port>:<host>.".to_string())?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0 && port.chars().all(|c| c.is_ascii_digit()))
        .ok_or_else(|| format!("Invalid port \"{port}\"."))?;
    validate_host(host)?;
    Ok(HostKeyTarget {
        type_token: type_token.to_string(),
        port,
        host: host.to_string(),
    })
}

/// Reject a host that is empty, over-long, or contains anything but letters,
/// digits, `.`, `-`, `_` and `:` (IPv6). Whitespace, commas, wildcards and
/// brackets would make the entry a pattern or a list rather than one host.
fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("The entry has no host.".to_string());
    }
    if host.len() > 253 {
        return Err("The host name is too long.".to_string());
    }
    if let Some(bad) = host
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')))
    {
        let shown = if bad.is_whitespace() {
            "whitespace".to_string()
        } else {
            format!("\"{bad}\"")
        };
        return Err(format!(
            "The host contains {shown}, which is not allowed in a trusted host."
        ));
    }
    Ok(())
}

/// The host-key algorithms this importer converts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Rsa,
    Ed25519,
    Ecdsa(Curve),
}

/// A NIST curve with its short-Weierstrass parameters (`a = -3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Curve {
    P256,
    P384,
    P521,
}

impl Curve {
    /// SSH curve identifier (`nistp256`).
    fn name(self) -> &'static str {
        match self {
            Self::P256 => "nistp256",
            Self::P384 => "nistp384",
            Self::P521 => "nistp521",
        }
    }

    /// Field element size in bytes.
    fn field_len(self) -> usize {
        match self {
            Self::P256 => 32,
            Self::P384 => 48,
            Self::P521 => 66,
        }
    }

    /// The field prime `p`.
    fn p(self) -> BigUint {
        hex_const(match self {
            Self::P256 => "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
            Self::P384 => concat!(
                "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe",
                "ffffffff0000000000000000ffffffff"
            ),
            Self::P521 => concat!(
                "01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            ),
        })
    }

    /// The curve coefficient `b`.
    fn b(self) -> BigUint {
        hex_const(match self {
            Self::P256 => "5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
            Self::P384 => concat!(
                "b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875a",
                "c656398d8a2ed19d2a85c8edd3ec2aef"
            ),
            Self::P521 => concat!(
                "0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef1",
                "09e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b50",
                "3f00"
            ),
        })
    }
}

/// Parse a compile-time hex constant. The constants are fixed and covered by
/// the conversion tests; a (never expected) parse failure yields zero, which
/// makes every on-curve check fail closed rather than panic.
fn hex_const(hex: &str) -> BigUint {
    BigUint::parse_bytes(hex.as_bytes(), 16).unwrap_or_default()
}

impl KeyKind {
    /// Map PuTTY's key-type token to a supported kind.
    fn from_token(token: &str) -> Result<Self, String> {
        match token {
            "rsa2" => Ok(Self::Rsa),
            "ssh-ed25519" => Ok(Self::Ed25519),
            "ecdsa-sha2-nistp256" => Ok(Self::Ecdsa(Curve::P256)),
            "ecdsa-sha2-nistp384" => Ok(Self::Ecdsa(Curve::P384)),
            "ecdsa-sha2-nistp521" => Ok(Self::Ecdsa(Curve::P521)),
            "dss" => Err("DSA host keys are obsolete and not supported.".to_string()),
            "ssh-ed448" => Err("Ed448 host keys are not supported.".to_string()),
            other => Err(format!("Unknown host key type \"{other}\".")),
        }
    }

    /// SSH wire algorithm name.
    fn algorithm(self) -> &'static str {
        match self {
            Self::Rsa => "ssh-rsa",
            Self::Ed25519 => "ssh-ed25519",
            Self::Ecdsa(Curve::P256) => "ecdsa-sha2-nistp256",
            Self::Ecdsa(Curve::P384) => "ecdsa-sha2-nistp384",
            Self::Ecdsa(Curve::P521) => "ecdsa-sha2-nistp521",
        }
    }
}

/// Parse one `0x`-prefixed hex field.
fn parse_hex_field(field: &str) -> Result<BigUint, String> {
    let digits = field
        .strip_prefix("0x")
        .or_else(|| field.strip_prefix("0X"))
        .filter(|d| !d.is_empty() && d.len() <= 4096 && d.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "The key value is malformed.".to_string())?;
    BigUint::parse_bytes(digits.as_bytes(), 16).ok_or_else(|| "The key value is malformed.".into())
}

/// Split the value into exactly `count` hex numbers, after an optional (but
/// then mandatory-to-match) curve-name prefix.
fn parse_numbers(value: &str, count: usize, curve: Option<Curve>) -> Result<Vec<BigUint>, String> {
    let mut fields: Vec<&str> = value.split(',').collect();
    if let Some(curve) = curve {
        if fields.len() == count + 1 {
            if fields[0] != curve.name() {
                return Err(format!(
                    "The key's curve \"{}\" does not match its type ({}).",
                    fields[0],
                    curve.name()
                ));
            }
            fields.remove(0);
        }
    }
    if fields.len() != count {
        return Err("The key value is malformed.".to_string());
    }
    fields.into_iter().map(parse_hex_field).collect()
}

/// Append an SSH `string` (u32 length + bytes).
fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    // Bounded: every input is limited by `parse_hex_field` and the curve sizes.
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Append an SSH `mpint` of a non-negative number.
fn put_mpint(out: &mut Vec<u8>, n: &BigUint) {
    let mut bytes = if *n == BigUint::ZERO {
        Vec::new()
    } else {
        n.to_bytes_be()
    };
    if bytes.first().is_some_and(|b| b & 0x80 != 0) {
        bytes.insert(0, 0);
    }
    put_string(out, &bytes);
}

/// Big-endian bytes of `n`, left-padded to exactly `len`.
fn fixed_be(n: &BigUint, len: usize) -> Vec<u8> {
    let raw = n.to_bytes_be();
    let mut out = vec![0u8; len.saturating_sub(raw.len())];
    out.extend_from_slice(&raw);
    out
}

/// `ssh-rsa` blob from exponent and modulus.
fn rsa_blob(numbers: &[BigUint]) -> Result<Vec<u8>, String> {
    let (e, n) = (&numbers[0], &numbers[1]);
    let one = BigUint::from(1u32);
    if *e < BigUint::from(3u32) || e & &one != one || e.bits() > 64 {
        return Err("The RSA public exponent is invalid.".to_string());
    }
    if n.bits() < 1024 || n.bits() > 16384 || n & &one != one {
        return Err("The RSA modulus is invalid or too short.".to_string());
    }
    let mut blob = Vec::new();
    put_string(&mut blob, b"ssh-rsa");
    put_mpint(&mut blob, e);
    put_mpint(&mut blob, n);
    Ok(blob)
}

/// `(a - b) mod p` for `a, b < p`.
fn sub_mod(a: &BigUint, b: &BigUint, p: &BigUint) -> BigUint {
    (a + p - b) % p
}

/// `ssh-ed25519` blob from the affine point `(x, y)`, which must lie on the
/// curve `-x² + y² = 1 + d·x²·y²` over `p = 2²⁵⁵ − 19`.
fn ed25519_blob(numbers: &[BigUint]) -> Result<Vec<u8>, String> {
    let (x, y) = (&numbers[0], &numbers[1]);
    let p = (BigUint::from(1u32) << 255u32) - BigUint::from(19u32);
    if x >= &p || y >= &p {
        return Err("The Ed25519 key is not a valid curve point.".to_string());
    }
    // d = -121665 / 121666 mod p.
    let inv = BigUint::from(121_666u32).modpow(&(&p - BigUint::from(2u32)), &p);
    let d = sub_mod(&BigUint::ZERO, &(BigUint::from(121_665u32) * inv % &p), &p);
    let x2 = x * x % &p;
    let y2 = y * y % &p;
    let lhs = sub_mod(&y2, &x2, &p);
    let rhs = (BigUint::from(1u32) + d * &x2 % &p * &y2) % &p;
    // x = 0 gives (0, ±1): the identity or the order-2 point — never a key.
    if lhs != rhs || *x == BigUint::ZERO {
        return Err("The Ed25519 key is not a valid curve point.".to_string());
    }
    // RFC 8032 encoding: y little-endian, top bit = low bit of x.
    let mut enc = fixed_be(y, 32);
    enc.reverse();
    if x.bit(0) {
        enc[31] |= 0x80;
    }
    let mut blob = Vec::new();
    put_string(&mut blob, b"ssh-ed25519");
    put_string(&mut blob, &enc);
    Ok(blob)
}

/// `ecdsa-sha2-*` blob from the affine point `(x, y)`, which must lie on the
/// curve `y² = x³ − 3x + b`.
fn ecdsa_blob(curve: Curve, numbers: &[BigUint]) -> Result<Vec<u8>, String> {
    let (x, y) = (&numbers[0], &numbers[1]);
    let p = curve.p();
    let invalid = || format!("The {} key is not a valid curve point.", curve.name());
    if x >= &p || y >= &p {
        return Err(invalid());
    }
    let lhs = y * y % &p;
    let x3 = x * x % &p * x % &p;
    let rhs = (sub_mod(&x3, &(BigUint::from(3u32) * x % &p), &p) + curve.b()) % &p;
    if lhs != rhs {
        return Err(invalid());
    }
    let mut point = vec![0x04];
    point.extend(fixed_be(x, curve.field_len()));
    point.extend(fixed_be(y, curve.field_len()));
    let mut blob = Vec::new();
    put_string(&mut blob, KeyKind::Ecdsa(curve).algorithm().as_bytes());
    put_string(&mut blob, curve.name().as_bytes());
    put_string(&mut blob, &point);
    Ok(blob)
}

/// The `known_hosts` host field: `host` on port 22, `[host]:port` otherwise.
fn known_hosts_host(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Validate and convert one entry. The error is a user-facing skip reason.
pub fn convert(raw: &RawHostKey) -> Result<ConvertedHostKey, String> {
    let target = parse_target(&raw.id)?;
    let kind = KeyKind::from_token(&target.type_token)?;
    let blob = match kind {
        KeyKind::Rsa => rsa_blob(&parse_numbers(&raw.value, 2, None)?)?,
        KeyKind::Ed25519 => ed25519_blob(&parse_numbers(&raw.value, 2, None)?)?,
        KeyKind::Ecdsa(curve) => ecdsa_blob(curve, &parse_numbers(&raw.value, 2, Some(curve))?)?,
    };
    let public_key = PublicKey::from_bytes(&blob)
        .map_err(|_| "The key could not be decoded as an SSH public key.".to_string())?;
    // Defence in depth: the decoded key must be the algorithm the entry claims.
    if public_key.algorithm().as_str() != kind.algorithm() {
        return Err("The key does not match its declared type.".to_string());
    }
    let openssh = public_key
        .to_openssh()
        .map_err(|_| "The key could not be encoded in OpenSSH format.".to_string())?;
    Ok(ConvertedHostKey {
        known_hosts_line: format!(
            "{} {}",
            known_hosts_host(&target.host, target.port),
            openssh.trim()
        ),
        fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
        key_type: kind.algorithm().to_string(),
        host: target.host,
        port: target.port,
        public_key,
    })
}
