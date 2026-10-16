//! Map parsed MobaXterm sessions onto termiHub connection settings (#4850).
//!
//! Field positions follow the community-documented `.mxtsessions` layout
//! (index 0 of the `%` block is the session type). The SSH, RDP and VNC
//! positions match the open-source Sessionator generator
//! (`src/Formats/MobaXterm/{SSH,RDP,VNC}.php`); the serial positions are a
//! best-effort reading that has not been checked against MobaXterm itself.
//!
//! | Type | Code | Fields used |
//! |------|------|-------------|
//! | SSH | 0 | 1 host, 2 port, 3 user (`<default>` = none), 7 login command, 8/9/10/15 gateway hosts/ports/users/keys (`__PIPE__` lists), 14 key path, 19/20/21/22 proxy type/host/port/user |
//! | Telnet | 1 | 1 host, 2 port |
//! | RDP | 4 | 1 host, 2 port, 3 user, 13/14/15/18 SSH gateway hosts/ports/users/keys, 20 RD Gateway |
//! | VNC | 5 | 1 host, 2 port, 5/6/7/8 SSH gateway hosts/ports/users/keys, 13/14/15/16 proxy type/host/port/user |
//! | FTP | 6 | 1 host, 2 port, 3 user |
//! | SFTP | 7 | 1 host, 2 port, 3 user |
//! | Serial | 8 | 2 speed, 3 data bits, 4 parity, 5 stop bits, 6 flow control, 8 port description |
//! | Shell | 10 | 3 start directory |
//! | WSL | 14 | 1 distribution |
//!
//! What termiHub has a counterpart for is mapped: SSH gateways become the SSH
//! jump-host chain, a single VNC or RDP SSH gateway becomes that connection's
//! SSH tunnel, and the SSH login command becomes the SSH initial command. The
//! rest stays a preview note: termiHub SSH connections have no outbound network
//! proxy, RDP has no RD Gateway, and the VNC / RDP tunnel is single-hop.
//!
//! Rsh (2), XDMCP (3), File (9), Browser (11), Mosh (12) and S3 (13) have no
//! termiHub counterpart and are skipped with a reason. Passwords are never
//! read: MobaXterm keeps them in its own vault, not in these fields.

use serde_json::{json, Map, Value};

use crate::connection::config::TerminalOptions;

use super::appearance::map_appearance;
use super::parser::{decode_escapes, RawSession};
use super::placeholders::{expand_path, PlaceholderEnv};

/// A session mapped to a termiHub connection, or the reason it was skipped.
#[derive(Debug, Clone)]
pub struct Mapped {
    /// Human label of the MobaXterm session type (`"SSH"`, `"Serial"`, …).
    pub session_type: String,
    /// One-line target summary for the preview (`user@host:port`, `COM3 @ 9600`).
    pub target: String,
    /// The outcome: a connection to create, or why there is none.
    pub outcome: Outcome,
    /// Non-fatal remarks (settings that were not carried over, guesses made).
    pub notes: Vec<String>,
    /// Per-connection terminal options from the terminal block (#4854).
    pub terminal_options: Option<TerminalOptions>,
}

/// What a session turns into.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Create a termiHub connection of `connection_type` with `settings`.
    Import {
        connection_type: &'static str,
        settings: Value,
    },
    /// Do not import; the reason is shown in the preview.
    Skip(String),
}

/// Human label for a MobaXterm session-type code.
pub fn type_label(code: u32) -> String {
    match code {
        0 => "SSH",
        1 => "Telnet",
        2 => "Rsh",
        3 => "XDMCP",
        4 => "RDP",
        5 => "VNC",
        6 => "FTP",
        7 => "SFTP",
        8 => "Serial",
        9 => "File",
        10 => "Shell",
        11 => "Browser",
        12 => "Mosh",
        13 => "S3",
        14 => "WSL",
        _ => return format!("Type {code}"),
    }
    .to_string()
}

/// Accumulates the settings object and notes for one session.
struct Builder<'a> {
    params: &'a [String],
    settings: Map<String, Value>,
    notes: Vec<String>,
}

impl<'a> Builder<'a> {
    fn new(params: &'a [String]) -> Self {
        Self {
            params,
            settings: Map::new(),
            notes: Vec::new(),
        }
    }

    /// Field `idx`, escape-decoded and trimmed; `None` when absent or empty.
    fn field(&self, idx: usize) -> Option<String> {
        let raw = self.params.get(idx)?;
        let value = decode_escapes(raw.trim());
        (!value.is_empty()).then_some(value)
    }

    /// Raw (still-encoded) field `idx`, for `__PIPE__` list splitting.
    fn raw(&self, idx: usize) -> &str {
        self.params.get(idx).map(|s| s.trim()).unwrap_or("")
    }

    /// Field `idx` as a port; falls back to `default` (with a note when the
    /// field held something that is not a valid port).
    fn port(&mut self, idx: usize, default: u16) -> u16 {
        match self.field(idx) {
            None => default,
            Some(v) => match v.parse::<u16>() {
                Ok(p) if p > 0 => p,
                _ => {
                    self.notes
                        .push(format!("Invalid port \"{v}\"; using {default}."));
                    default
                }
            },
        }
    }

    /// A username field, treating MobaXterm's `<default>` marker as empty.
    fn username(&mut self, idx: usize) -> Option<String> {
        let user = self.field(idx)?;
        if user == "<default>" {
            self.notes.push(
                "Uses MobaXterm's default username, which is not stored; set one after import."
                    .to_string(),
            );
            return None;
        }
        Some(user)
    }

    fn set(&mut self, key: &str, value: Value) {
        self.settings.insert(key.to_string(), value);
    }

    fn import(self, connection_type: &'static str, label: &str, target: String) -> Mapped {
        Mapped {
            session_type: label.to_string(),
            target,
            outcome: Outcome::Import {
                connection_type,
                settings: Value::Object(self.settings),
            },
            notes: self.notes,
            terminal_options: None,
        }
    }
}

fn skip(label: &str, target: String, reason: impl Into<String>) -> Mapped {
    Mapped {
        session_type: label.to_string(),
        target,
        outcome: Outcome::Skip(reason.into()),
        notes: Vec::new(),
        terminal_options: None,
    }
}

/// `user@host:port`, omitting an absent user and the protocol's default port.
fn host_target(user: Option<&str>, host: &str, port: u16, default_port: u16) -> String {
    let port = if port == default_port {
        String::new()
    } else {
        format!(":{port}")
    };
    match user {
        Some(u) => format!("{u}@{host}{port}"),
        None => format!("{host}{port}"),
    }
}

/// Map one parsed session. Never fails: anything unusable becomes a skip.
pub fn map_session(session: &RawSession, env: &PlaceholderEnv) -> Mapped {
    let Some(code) = session.type_code else {
        return skip(
            "Unknown",
            String::new(),
            "The session line is truncated or malformed.",
        );
    };
    let label = type_label(code);
    let params = session.params.as_slice();
    let mut mapped = match code {
        0 => map_ssh(params, env, &label),
        1 => map_host_port(params, &label, "telnet", 23, false),
        4 => map_rdp(params, env, &label),
        5 => map_vnc(params, env, &label),
        6 => map_host_port(params, &label, "ftp", 21, true),
        7 => map_sftp(params, &label),
        8 => map_serial(params, &session.name, &label),
        10 => map_shell(params, env, &label),
        14 => map_wsl(params, &label),
        2 | 3 | 9 | 11 | 12 | 13 => skip(
            &label,
            String::new(),
            format!("termiHub has no {label} connection type."),
        ),
        _ => skip(
            &label,
            String::new(),
            format!("Unknown MobaXterm session type {code}."),
        ),
    };
    apply_appearance(&mut mapped, &session.terminal, code);
    mapped
}

/// Carry the terminal block's appearance onto an imported session (#4854).
fn apply_appearance(mapped: &mut Mapped, terminal: &[String], code: u32) {
    let Outcome::Import {
        connection_type,
        settings,
    } = &mut mapped.outcome
    else {
        return;
    };
    let appearance = map_appearance(terminal, code, connection_type);
    if let (Some(term), Some(obj)) = (appearance.terminal_type, settings.as_object_mut()) {
        obj.insert("terminalType".to_string(), json!(term));
    }
    mapped.notes.extend(appearance.notes);
    mapped.terminal_options = appearance.options;
}

/// Host + port (+ optional user) for the simple remote types.
fn map_host_port(
    params: &[String],
    label: &str,
    connection_type: &'static str,
    default_port: u16,
    with_user: bool,
) -> Mapped {
    let mut b = Builder::new(params);
    let Some(host) = b.field(1) else {
        return skip(label, String::new(), "No host is set.");
    };
    let port = b.port(2, default_port);
    let user = if with_user { b.username(3) } else { None };
    b.set("host", json!(host));
    b.set("port", json!(port));
    if let Some(u) = &user {
        b.set("username", json!(u));
    }
    let target = host_target(user.as_deref(), &host, port, default_port);
    b.import(connection_type, label, target)
}

fn map_ssh(params: &[String], env: &PlaceholderEnv, label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let Some(host) = b.field(1) else {
        return skip(label, String::new(), "No host is set.");
    };
    let port = b.port(2, 22);
    let user = b.username(3);
    b.set("host", json!(host));
    b.set("port", json!(port));
    b.set("username", json!(user.clone().unwrap_or_default()));

    match b.field(14) {
        Some(raw_key) => {
            let key = key_path(&mut b, &raw_key, env);
            b.set("authMethod", json!("key"));
            b.set("keyPath", json!(key));
        }
        None => b.set("authMethod", json!("password")),
    }

    let hops = gateway_hops(&mut b, [8, 9, 10, 15], env);
    if !hops.is_empty() {
        b.set("proxyJump", Value::Array(hops));
    }
    // The login command runs once after the first connect, like termiHub's
    // SSH `initialCommand` (#4866) — not `onReconnectCommand`.
    if let Some(command) = b.field(7) {
        b.set("initialCommand", Value::String(command));
    }
    if let Some(note) = proxy_note(&b, [19, 20, 21, 22], "SSH connections") {
        b.notes.push(note);
    }
    let target = host_target(user.as_deref(), &host, port, 22);
    b.import("ssh", label, target)
}

/// Expand a stored key path and note an unresolvable placeholder.
fn key_path(b: &mut Builder<'_>, raw: &str, env: &PlaceholderEnv) -> String {
    let expanded = expand_path(raw, env);
    if let Some(token) = expanded.unresolved {
        b.notes.push(format!(
            "Key path placeholder {token} could not be resolved on this computer; check the path."
        ));
    }
    expanded.path
}

/// Build the jump-host chain from MobaXterm's parallel gateway lists
/// (`[hosts, ports, users, keys]` field indices, `__PIPE__`-separated).
fn gateway_hops(b: &mut Builder<'_>, idx: [usize; 4], env: &PlaceholderEnv) -> Vec<Value> {
    let split = |s: &str| -> Vec<String> {
        s.split("__PIPE__")
            .map(|p| decode_escapes(p.trim()))
            .collect()
    };
    let hosts = split(b.raw(idx[0]));
    let ports = split(b.raw(idx[1]));
    let users = split(b.raw(idx[2]));
    let keys = split(b.raw(idx[3]));
    let mut hops = Vec::new();
    for (i, host) in hosts.iter().enumerate() {
        if host.is_empty() {
            continue;
        }
        let port = ports
            .get(i)
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(22);
        let username = users
            .get(i)
            .filter(|u| u.as_str() != "<default>")
            .cloned()
            .unwrap_or_default();
        let mut hop = Map::new();
        hop.insert("host".into(), json!(host));
        hop.insert("port".into(), json!(port));
        hop.insert("username".into(), json!(username));
        match keys.get(i).filter(|k| !k.is_empty()).cloned() {
            Some(raw_key) => {
                let key = key_path(b, &raw_key, env);
                hop.insert("authMethod".into(), json!("key"));
                hop.insert("keyPath".into(), json!(key));
            }
            None => {
                hop.insert("authMethod".into(), json!("password"));
            }
        }
        hops.push(Value::Object(hop));
    }
    hops
}

/// The preview note for a MobaXterm network proxy (`[type, host, port, user]`
/// field indices), or `None` when the session uses no proxy. termiHub has no
/// outbound proxy setting for `subject` (e.g. `"SSH connections"`).
fn proxy_note(b: &Builder<'_>, idx: [usize; 4], subject: &str) -> Option<String> {
    let kind = match b.field(idx[0])?.as_str() {
        "0" => return None,
        "1" => "SOCKS4 proxy",
        "2" => "SOCKS5 proxy",
        "3" => "HTTP proxy",
        "4" => "Telnet proxy",
        "5" => "local proxy command",
        "6" => "SSH-forwarding proxy",
        "7" => "SSH proxy command",
        _ => "network proxy",
    };
    let at = match (b.field(idx[1]), b.field(idx[2])) {
        (Some(host), Some(port)) => format!(" {host}:{port}"),
        (Some(host), None) => format!(" {host}"),
        _ => String::new(),
    };
    let user = b
        .field(idx[3])
        .map(|u| format!(" (user {u})"))
        .unwrap_or_default();
    Some(format!(
        "The {kind}{at}{user} was not imported: termiHub {subject} have no network proxy setting."
    ))
}

/// `host:port → host:port` summary of a gateway chain for a preview note.
fn hops_summary(hops: &[Value]) -> String {
    hops.iter()
        .map(|h| {
            let host = h["host"].as_str().unwrap_or_default();
            match h["port"].as_u64() {
                Some(22) | None => host.to_string(),
                Some(port) => format!("{host}:{port}"),
            }
        })
        .collect::<Vec<_>>()
        .join(" → ")
}

fn map_rdp(params: &[String], env: &PlaceholderEnv, label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let Some(host) = b.field(1) else {
        return skip(label, String::new(), "No host is set.");
    };
    let port = b.port(2, 3389);
    let user = b.username(3);
    b.set("host", json!(host));
    b.set("port", json!(port));
    if let Some(u) = &user {
        b.set("username", json!(u));
    }
    let hops = gateway_hops(&mut b, [13, 14, 15, 18], env);
    apply_ssh_tunnel_gateway(&mut b, &hops, "RDP");
    if let Some(gateway) = b.field(20) {
        b.notes.push(format!(
            "The Remote Desktop Gateway {gateway} was not imported: termiHub does not support \
             RD Gateway."
        ));
    }
    let target = host_target(user.as_deref(), &host, port, 3389);
    b.import("rdp", label, target)
}

/// Map a graphical session's SSH gateways onto its **SSH Tunnel** group (VNC,
/// RDP #4865): a single gateway becomes the tunnel; a chain of several cannot
/// be expressed there and stays a note. `kind` names the type in that note.
fn apply_ssh_tunnel_gateway(b: &mut Builder<'_>, hops: &[Value], kind: &str) {
    match hops {
        [] => {}
        [hop] => {
            b.set("useSshTunnel", json!(true));
            b.set("sshHost", hop["host"].clone());
            b.set("sshPort", hop["port"].clone());
            b.set("sshUsername", hop["username"].clone());
            b.set("sshAuthMethod", hop["authMethod"].clone());
            if let Some(key) = hop.get("keyPath") {
                b.set("sshKeyPath", key.clone());
            }
        }
        _ => b.notes.push(format!(
            "The SSH gateway chain {} was not imported: termiHub's {kind} SSH tunnel uses a \
             single SSH host.",
            hops_summary(hops)
        )),
    }
}

/// VNC: a single SSH gateway maps onto termiHub's VNC SSH tunnel; a chain of
/// several gateways cannot be expressed there and stays a note.
fn map_vnc(params: &[String], env: &PlaceholderEnv, label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let Some(host) = b.field(1) else {
        return skip(label, String::new(), "No host is set.");
    };
    let port = b.port(2, 5900);
    b.set("host", json!(host));
    b.set("port", json!(port));
    let hops = gateway_hops(&mut b, [5, 6, 7, 8], env);
    apply_ssh_tunnel_gateway(&mut b, &hops, "VNC");
    if let Some(note) = proxy_note(&b, [13, 14, 15, 16], "VNC connections") {
        b.notes.push(note);
    }
    let target = host_target(None, &host, port, 5900);
    b.import("vnc", label, target)
}

fn map_sftp(params: &[String], label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let Some(host) = b.field(1) else {
        return skip(label, String::new(), "No host is set.");
    };
    let port = b.port(2, 22);
    let user = b.username(3);
    b.set("host", json!(host));
    b.set("port", json!(port));
    b.set("username", json!(user.clone().unwrap_or_default()));
    b.set("authMethod", json!("password"));
    b.notes.push(
        "Imported as an SSH connection; its file browser gives the same SFTP access.".to_string(),
    );
    let target = host_target(user.as_deref(), &host, port, 22);
    b.import("ssh", label, target)
}

/// MobaXterm's serial speed: current builds write `1` followed by the rate
/// zero-padded to six digits (`1115200`, `1009600`); older builds wrote a
/// plain rate. Anything else is not trusted.
fn serial_baud(raw: &str) -> Option<u32> {
    let digits = raw.trim();
    if !digits.chars().all(|c| c.is_ascii_digit()) || digits.is_empty() {
        return None;
    }
    let value = if digits.len() == 7 && digits.starts_with('1') {
        digits[1..].parse::<u32>().ok()?
    } else {
        digits.parse::<u32>().ok()?
    };
    (50..=4_000_000).contains(&value).then_some(value)
}

/// First token of a port description like `COM3  (USB Serial Port (COM3))`,
/// else a `COMn` found in the session name.
fn serial_port(description: Option<&str>, name: &str) -> Option<String> {
    if let Some(port) = description
        .and_then(|d| d.split_whitespace().next())
        .filter(|p| !p.is_empty())
    {
        return Some(port.to_string());
    }
    let upper = name.to_ascii_uppercase();
    let start = upper.find("COM")?;
    let digits: String = upper[start + 3..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    (!digits.is_empty()).then(|| format!("COM{digits}"))
}

fn map_serial(params: &[String], name: &str, label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let Some(port) = serial_port(b.field(8).as_deref(), name) else {
        return skip(label, String::new(), "No serial port is set.");
    };
    let baud = match b.field(2).as_deref().map(serial_baud) {
        Some(Some(rate)) => rate,
        Some(None) => {
            b.notes
                .push("The serial speed could not be read; using 115200.".to_string());
            115_200
        }
        None => 115_200,
    };
    let data_bits = match b.field(3).as_deref() {
        Some("0") => "5",
        Some("1") => "6",
        Some("2") => "7",
        _ => "8",
    };
    let parity = match b.field(4).as_deref() {
        Some("1") => "odd",
        Some("2") => "even",
        Some("0") | None => "none",
        Some(_) => {
            b.notes
                .push("Mark/space parity is not supported; using none.".to_string());
            "none"
        }
    };
    let stop_bits = match b.field(5).as_deref() {
        Some("2") => "2",
        Some("1") => {
            b.notes
                .push("1.5 stop bits are not supported; using 1.".to_string());
            "1"
        }
        _ => "1",
    };
    let flow = match b.field(6).as_deref() {
        Some("1") => "software",
        Some("2") => "hardware",
        Some("0") | None => "none",
        Some(_) => {
            b.notes
                .push("DSR/DTR flow control is not supported; using none.".to_string());
            "none"
        }
    };
    b.set("port", json!(port));
    b.set("baudRate", json!(baud.to_string()));
    b.set("dataBits", json!(data_bits));
    b.set("stopBits", json!(stop_bits));
    b.set("parity", json!(parity));
    b.set("flowControl", json!(flow));
    let target = format!("{port} @ {baud}");
    b.import("serial", label, target)
}

fn map_shell(params: &[String], env: &PlaceholderEnv, label: &str) -> Mapped {
    let mut b = Builder::new(params);
    let mut target = "Local shell".to_string();
    if let Some(dir) = b.field(3) {
        let expanded = expand_path(&dir, env);
        if let Some(token) = expanded.unresolved {
            b.notes.push(format!(
                "Start folder placeholder {token} could not be resolved; check the path."
            ));
        }
        target = format!("Local shell in {}", expanded.path);
        b.set("startingDirectory", json!(expanded.path));
    }
    b.notes.push(
        "MobaXterm's shell choice is not carried over; the default shell is used.".to_string(),
    );
    b.import("local", label, target)
}

fn map_wsl(params: &[String], label: &str) -> Mapped {
    let mut b = Builder::new(params);
    // A purely numeric value is an index into MobaXterm's own distro list,
    // which does not survive the move; fall back to the default distribution.
    match b
        .field(1)
        .filter(|d| !d.chars().all(|c| c.is_ascii_digit()))
    {
        Some(distro) => {
            b.set("distribution", json!(distro));
            let target = format!("WSL: {distro}");
            b.import("wsl", label, target)
        }
        None => {
            b.notes
                .push("No distribution name is stored; pick one after import.".to_string());
            b.import("wsl", label, "WSL".to_string())
        }
    }
}
