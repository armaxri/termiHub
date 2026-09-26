//! Conservative redaction for crash reports and exported diagnostics (OBS-010).
//!
//! Everything that can leave the machine through a diagnostics export — crash
//! reports and log files — is run through [`Redactor::redact`] first. The bias is
//! deliberately toward **over-redaction**: masking a harmless value costs a
//! little debugging context, leaking a password, token, hostname or username
//! costs the user's trust. The rules mirror the frontend `redactLogText` (OBS-008)
//! for secrets and add the identity-bearing shapes the issue calls out:
//!
//! | Shape | Replacement |
//! | --- | --- |
//! | PEM private-key block (terminated or truncated) | `[REDACTED PRIVATE KEY]` |
//! | URL userinfo and host (`ssh://user:pw@host`) | `ssh://[REDACTED]@[host]` |
//! | `Authorization:` / `Bearer …` | scheme kept, credential `[REDACTED]` |
//! | `password=` / `token: "…"` / `api_key: Some("…")` … | `[REDACTED]` |
//! | JWTs, well-known token prefixes, long high-entropy strings | `[REDACTED TOKEN]` |
//! | `host=` / `user=` style fields | `[host]` / `[user]` |
//! | the local home directory, `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` | `~` / `[user]` |
//! | the local username and hostname, anywhere | `[user]` / `[host]` |
//! | `user@host`, e-mail addresses | `[user]@[host]` |
//! | IPv4 / IPv6 (loopback and unspecified kept), MAC addresses | `[ip]` / `[mac]` |
//! | dotted host names (`build.example.com`) | `[host]` |
//!
//! File names with a known extension (`lib.rs`, `termihub.log`) and termiHub's
//! own identifiers are kept so backtraces and log lines stay useful.
//!
//! The pass is pure and idempotent: redacting already-redacted text is a no-op.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

use regex::{Captures, Regex};

/// Marker substituted for a masked secret value.
pub const REDACTED: &str = "[REDACTED]";
/// Marker substituted for a masked token-shaped secret.
pub const REDACTED_TOKEN: &str = "[REDACTED TOKEN]";
/// Marker substituted for a private-key block.
pub const REDACTED_KEY: &str = "[REDACTED PRIVATE KEY]";
/// Placeholder for a username.
pub const USER: &str = "[user]";
/// Placeholder for a host name.
pub const HOST: &str = "[host]";
/// Placeholder for an IP address.
pub const IP: &str = "[ip]";
/// Placeholder for a MAC address.
pub const MAC: &str = "[mac]";

/// Secret-bearing field names (case-insensitive, whole word). Kept in step with
/// `SECRET_KEY_PATTERN` in `src/utils/redactLogText.ts`.
const SECRET_KEYS: &str = "(?:passwords?|passphrases?|passwd|pwd|secrets?|\
tokens?|access[-_ ]?tokens?|auth[-_ ]?tokens?|id[-_ ]?tokens?|refresh[-_ ]?tokens?|\
api[-_ ]?keys?|access[-_ ]?keys?|secret[-_ ]?keys?|private[-_ ]?keys?|\
client[-_ ]?secrets?|credentials?|cookies?|otp|totp)";

/// Host-bearing field names.
const HOST_KEYS: &str = "(?:host|hostname|host[-_]name|remote[-_]host|server[-_]host)";

/// User-bearing field names.
const USER_KEYS: &str = "(?:user|username|user[-_]name|login|remote[-_]user)";

/// File extensions whose dotted names are file names, not hosts.
const FILE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "log", "toml", "txt", "md", "so", "dll",
    "dylib", "exe", "html", "css", "zip", "sh", "cmd", "ps1", "py", "lock", "yaml", "yml", "conf",
    "cfg", "ini", "pem", "pub", "key", "crt", "plist", "app", "dmg", "msi", "deb", "rpm", "xml",
    "svg", "png", "jpg", "wasm", "sock", "pid", "tmp", "bak", "old", "desktop", "service",
];

/// Dotted identifiers that are termiHub's own and never identify the user.
const ALLOWED_DOTTED: &[&str] = &["com.termihub.app", "termihub.app"];

/// Placeholder words the literal username / hostname passes must never rewrite,
/// or a second pass over redacted text would nest brackets.
const PLACEHOLDER_WORDS: &[&str] = &["user", "host", "ip", "mac", "redacted", "token"];

/// Minimum length for a literal username / hostname to be replaced everywhere.
/// Shorter values (`a`, `pi`) would shred ordinary words.
const MIN_LITERAL_LEN: usize = 3;

/// Facts about the local machine that identify the user and so must be masked
/// wherever they appear.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RedactionContext {
    /// Home directories to collapse to `~` (e.g. `/Users/alice`).
    pub home_dirs: Vec<String>,
    /// Usernames to mask as `[user]`.
    pub usernames: Vec<String>,
    /// Host names to mask as `[host]`.
    pub hostnames: Vec<String>,
}

impl RedactionContext {
    /// Gather the context from the running process: `$HOME`/`%USERPROFILE%`,
    /// `$USER`/`%USERNAME%`, and the machine's host name (plus `COMPUTERNAME`).
    pub fn from_environment() -> Self {
        let mut ctx = Self::default();
        for var in ["HOME", "USERPROFILE"] {
            if let Ok(v) = std::env::var(var) {
                push_unique(&mut ctx.home_dirs, v);
            }
        }
        for var in ["USER", "USERNAME", "LOGNAME"] {
            if let Ok(v) = std::env::var(var) {
                push_unique(&mut ctx.usernames, v);
            }
        }
        if let Some(h) = gethostname::gethostname().to_str() {
            push_unique(&mut ctx.hostnames, h.to_string());
        }
        for var in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(v) = std::env::var(var) {
                push_unique(&mut ctx.hostnames, v);
            }
        }
        // `alice-mbp.local` is also known as `alice-mbp`.
        let short: Vec<String> = ctx
            .hostnames
            .iter()
            .filter_map(|h| h.split('.').next().map(str::to_string))
            .collect();
        for s in short {
            push_unique(&mut ctx.hostnames, s);
        }
        ctx
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    let value = value.trim().to_string();
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

/// A configured redaction pass. Cheap to build; the regexes are compiled once
/// per process.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    ctx: RedactionContext,
}

impl Redactor {
    /// A redactor that also masks the given machine-specific values.
    pub fn new(ctx: RedactionContext) -> Self {
        Self { ctx }
    }

    /// A redactor for the running process ([`RedactionContext::from_environment`]).
    pub fn for_current_environment() -> Self {
        Self::new(RedactionContext::from_environment())
    }

    /// Return `text` with every recognised secret / identity shape masked.
    pub fn redact(&self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        let Some(p) = patterns() else {
            // The patterns are constants covered by tests; if they somehow failed
            // to compile, refuse to pass anything through rather than leak.
            return REDACTED.to_string();
        };
        let mut out = self.redact_literals(text);
        out = redact_secrets(p, &out);
        out = redact_identity(p, &out);
        out
    }

    /// Machine-specific literals first, before any placeholder is inserted.
    fn redact_literals(&self, text: &str) -> String {
        let mut out = text.to_string();
        // Each home dir in both separator styles, longest first, so
        // `C:\Users\alice` wins over a `\Users\alice` inside it.
        let mut homes: Vec<String> = self
            .ctx
            .home_dirs
            .iter()
            .filter(|h| h.len() >= MIN_LITERAL_LEN)
            .flat_map(|h| [h.clone(), h.replace('\\', "/"), h.replace('/', "\\")])
            .collect();
        homes.sort_by_key(|h| std::cmp::Reverse(h.len()));
        homes.dedup();
        for home in &homes {
            out = out.replace(home.as_str(), "~");
        }
        for user in &self.ctx.usernames {
            out = replace_word(&out, user, USER);
        }
        for host in &self.ctx.hostnames {
            out = replace_word(&out, host, HOST);
        }
        out
    }
}

/// Replace whole-word, case-insensitive occurrences of `needle`.
fn replace_word(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.len() < MIN_LITERAL_LEN
        || PLACEHOLDER_WORDS
            .iter()
            .any(|w| w.eq_ignore_ascii_case(needle))
    {
        return haystack.to_string();
    }
    let Ok(re) = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(needle))) else {
        return haystack.to_string();
    };
    re.replace_all(haystack, replacement).into_owned()
}

/// The compiled rule set.
struct Patterns {
    pem_block: Regex,
    pem_open: Regex,
    url: Regex,
    authorization: Regex,
    bearer: Regex,
    secret_dq: Regex,
    secret_sq: Regex,
    secret_bare: Regex,
    jwt: Regex,
    prefixed_token: Regex,
    long_token: Regex,
    host_field: Regex,
    user_field: Regex,
    home_path: Regex,
    user_at_host: Regex,
    ipv4: Regex,
    ipv6: Regex,
    mac: Regex,
    dotted_host: Regex,
}

fn patterns() -> Option<&'static Patterns> {
    static PATTERNS: OnceLock<Option<Patterns>> = OnceLock::new();
    PATTERNS.get_or_init(build_patterns).as_ref()
}

fn build_patterns() -> Option<Patterns> {
    let r = |s: &str| Regex::new(s).ok();
    let value_prefix = r#"["']?\s*[:=]\s*(?:Some\()?"#;
    Some(Patterns {
        pem_block: r(
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        )?,
        pem_open: r(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*")?,
        url: r(r#"(?i)\b([a-z][a-z0-9+.-]*://)([^\s/@\[\]"'<>]+@)?([^\s/:?#\[\]"'<>@]*)"#)?,
        authorization: r(
            r#"(?i)(\bauthorization\b["']?\s*[:=]\s*["']?)(?:(bearer|basic|digest|negotiate|token)\s+)?([^\s"',;}\])]+)"#,
        )?,
        bearer: r(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*")?,
        secret_dq: r(&format!(r#"(?i)(\b{SECRET_KEYS}\b{value_prefix})"[^"]*""#))?,
        secret_sq: r(&format!(r#"(?i)(\b{SECRET_KEYS}\b{value_prefix})'[^']*'"#))?,
        secret_bare: r(&format!(
            r#"(?i)(\b{SECRET_KEYS}\b{value_prefix})([^\s"',;}})\]]+)"#
        ))?,
        jwt: r(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")?,
        prefixed_token: r(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})",
        )?,
        long_token: r(r"[A-Za-z0-9+/=_-]{32,}")?,
        host_field: r(&format!(
            r#"(?i)(\b{HOST_KEYS}\b{value_prefix})("[^"]*"|'[^']*'|[^\s"',;}})\]]+)"#
        ))?,
        user_field: r(&format!(
            r#"(?i)(\b{USER_KEYS}\b{value_prefix})("[^"]*"|'[^']*'|[^\s"',;}})\]]+)"#
        ))?,
        home_path: r(r"(?i)(/Users/|/home/|[a-z]:\\Users\\|[a-z]:/Users/)([^/\\\s\x22'\[]+)")?,
        user_at_host: r(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*")?,
        ipv4: r(r"\d{1,3}(?:\.\d{1,3}){3}")?,
        ipv6: r(r"[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*")?,
        mac: r(r"\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b")?,
        dotted_host: r(
            r"\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[a-z]{2,24}\b",
        )?,
    })
}

/// Credentials, keys and tokens.
fn redact_secrets(p: &Patterns, text: &str) -> String {
    let mut out = p.pem_block.replace_all(text, REDACTED_KEY).into_owned();
    out = p.pem_open.replace_all(&out, REDACTED_KEY).into_owned();
    out = p.url.replace_all(&out, mask_url).into_owned();
    out = p
        .authorization
        .replace_all(&out, |c: &Captures| {
            let scheme = c
                .get(2)
                .map(|m| format!("{} ", m.as_str()))
                .unwrap_or_default();
            if c[3].starts_with('[') {
                return c[0].to_string();
            }
            format!("{}{scheme}{REDACTED}", &c[1])
        })
        .into_owned();
    out = p
        .bearer
        .replace_all(&out, format!("$1 {REDACTED}").as_str())
        .into_owned();
    out = p
        .secret_dq
        .replace_all(&out, format!("${{1}}\"{REDACTED}\"").as_str())
        .into_owned();
    out = p
        .secret_sq
        .replace_all(&out, format!("${{1}}'{REDACTED}'").as_str())
        .into_owned();
    out = p
        .secret_bare
        .replace_all(&out, |c: &Captures| {
            if c[2].starts_with('[') {
                c[0].to_string()
            } else {
                format!("{}{REDACTED}", &c[1])
            }
        })
        .into_owned();
    out = p.jwt.replace_all(&out, REDACTED_TOKEN).into_owned();
    out = p
        .prefixed_token
        .replace_all(&out, REDACTED_TOKEN)
        .into_owned();
    p.long_token
        .replace_all(&out, |c: &Captures| {
            if looks_like_secret_token(&c[0]) {
                REDACTED_TOKEN.to_string()
            } else {
                c[0].to_string()
            }
        })
        .into_owned()
}

/// Hostnames, IPs, usernames and home paths.
fn redact_identity(p: &Patterns, text: &str) -> String {
    let mut out = p
        .host_field
        .replace_all(text, |c: &Captures| masked_field(c, HOST))
        .into_owned();
    out = p
        .user_field
        .replace_all(&out, |c: &Captures| masked_field(c, USER))
        .into_owned();
    out = p
        .home_path
        .replace_all(&out, format!("${{1}}{USER}").as_str())
        .into_owned();
    out = p
        .user_at_host
        .replace_all(&out, format!("{USER}@{HOST}").as_str())
        .into_owned();
    out = p.mac.replace_all(&out, MAC).into_owned();
    out = replace_bounded(&p.ipv6, &out, |s| match s.parse::<Ipv6Addr>() {
        Ok(ip) if ip.is_loopback() || ip.is_unspecified() => None,
        Ok(_) => Some(IP.to_string()),
        Err(_) => None,
    });
    out = replace_bounded(&p.ipv4, &out, |s| match s.parse::<Ipv4Addr>() {
        Ok(ip) if ip.is_loopback() || ip.is_unspecified() => None,
        Ok(_) => Some(IP.to_string()),
        Err(_) => None,
    });
    p.dotted_host
        .replace_all(&out, |c: &Captures| {
            if is_host_name(&c[0]) {
                HOST.to_string()
            } else {
                c[0].to_string()
            }
        })
        .into_owned()
}

/// Mask a URL's userinfo (`user:pw@`) and its host, keeping the scheme and
/// loopback hosts (`localhost`, `127.0.0.1`) so local dev URLs stay readable.
fn mask_url(c: &Captures) -> String {
    let scheme = &c[1];
    let userinfo = if c.get(2).is_some() {
        format!("{REDACTED}@")
    } else {
        String::new()
    };
    let host = &c[3];
    let keep = host.is_empty()
        || host.starts_with('~')
        || host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified());
    let host = if keep { host } else { HOST };
    format!("{scheme}{userinfo}{host}")
}

/// Mask a `key=value` field value unless it is already a placeholder.
fn masked_field(c: &Captures, placeholder: &str) -> String {
    let value = &c[2];
    let inner = value.trim_matches(|ch| ch == '"' || ch == '\'');
    if inner.starts_with('[') || inner.is_empty() {
        return c[0].to_string();
    }
    let quote = if value.starts_with('"') {
        "\""
    } else if value.starts_with('\'') {
        "'"
    } else {
        ""
    };
    format!("{}{quote}{placeholder}{quote}", &c[1])
}

/// Replace regex matches that sit on a token boundary (no adjacent word char,
/// `.` or `:`) and for which `map` returns a replacement.
fn replace_bounded(re: &Regex, text: &str, map: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_iter(text) {
        let (start, end) = trim_trailing_punct(text, m.start(), m.end());
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let bounded = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if !bounded(before) || !bounded(after) || before == Some('.') {
            continue;
        }
        if let Some(rep) = map(&text[start..end]) {
            out.push_str(&text[last..start]);
            out.push_str(&rep);
            last = end;
        }
    }
    out.push_str(&text[last..]);
    out
}

/// Drop sentence punctuation (`.`, `:`) a greedy match swallowed at its end.
fn trim_trailing_punct(text: &str, start: usize, mut end: usize) -> (usize, usize) {
    while end > start {
        let s = &text[start..end];
        let drop = s.ends_with('.') || (s.ends_with(':') && !s.ends_with("::"));
        if !drop {
            break;
        }
        end -= 1;
    }
    (start, end)
}

/// Whether a long `[A-Za-z0-9+/=_-]` run is a secret rather than an identifier
/// or a path: it must mix letters and digits, must not be a UUID, and a
/// slash-separated run is treated as a path when any segment is a plain word.
fn looks_like_secret_token(s: &str) -> bool {
    let has_digit = s.chars().any(|c| c.is_ascii_digit());
    let has_alpha = s.chars().any(|c| c.is_ascii_alphabetic());
    if !has_digit || !has_alpha || is_uuid(s) {
        return false;
    }
    if s.contains('/') {
        let path_like = s.split('/').any(|seg| {
            seg.len() >= 2
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_' || c == '-')
        });
        return !path_like;
    }
    true
}

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Whether a dotted name is a host name (not a file name or our own id).
fn is_host_name(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    if ALLOWED_DOTTED.contains(&lower.as_str()) {
        return false;
    }
    let tld = lower.rsplit('.').next().unwrap_or("");
    !FILE_EXTENSIONS.contains(&tld)
}

#[cfg(test)]
#[path = "redact_tests.rs"]
mod tests;
