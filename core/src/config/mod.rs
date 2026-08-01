use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Default SSH connect/handshake timeout (seconds) when a connection does not
/// configure its own `connectTimeoutSecs`. Bounds how long a connect to an
/// unreachable host may block before failing (#841).
///
/// The budget covers the whole connect — DNS resolution, the TCP connect, and
/// the SSH handshake all run inside it (see
/// [`crate::backends::ssh::connect_and_authenticate`]). It was raised from the
/// original 20 s (#2087): a host that resolves slowly on the first attempt of
/// the day (cold DNS, e.g. a home Raspberry Pi) could spend most of a 20 s
/// budget in resolution alone and fail before ever connecting. 45 s leaves room
/// for a slow first resolve while still failing a genuinely dead host promptly;
/// raise it further per connection via `connectTimeoutSecs`.
pub const DEFAULT_SSH_CONNECT_TIMEOUT_SECS: u64 = 45;

/// Return the user's home directory.
///
/// On Unix, reads `$HOME`. On Windows, reads `$USERPROFILE`.
pub fn home_directory() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// Expand a leading `~` or `~/` to the user's home directory.
///
/// Returns the input unchanged if it does not start with `~/` (or is not just
/// `~`), or if the home directory cannot be resolved. `~user` paths are left
/// unchanged. Unlike [`expand_config_value`], this does **not** perform
/// environment variable substitution, so it is safe for user-supplied paths
/// where a literal `$` should not be interpreted.
pub fn expand_tilde_only(path: &str) -> String {
    if path != "~" && !path.starts_with("~/") && !path.starts_with(r"~\") {
        return path.to_string();
    }
    let Some(home) = home_directory() else {
        return path.to_string();
    };
    let home = home.to_string_lossy();
    if path == "~" {
        home.into_owned()
    } else {
        format!("{}{}", home, &path[1..])
    }
}

/// Expand `${VAR}` / `$VAR` placeholders and a leading `~` in a config value.
///
/// Backed by the `shellexpand` crate. Unknown environment variables expand to
/// an empty string. Tilde expansion uses [`home_directory`]; `~user` paths
/// are left unchanged.
pub fn expand_config_value(value: &str) -> String {
    let home_dir = || home_directory().map(|p| p.to_string_lossy().into_owned());
    let lookup = |name: &str| -> Result<Option<String>, std::convert::Infallible> {
        Ok(Some(std::env::var(name).unwrap_or_default()))
    };
    // Lookup returns Infallible, so shellexpand cannot raise a LookupError here.
    shellexpand::full_with_context(value, home_dir, lookup)
        .expect("shellexpand cannot fail with Infallible lookup")
        .into_owned()
}

/// Expand `${VAR}` placeholders and `~` in an optional SSH key path, stripping
/// any surrounding quotes first — users often paste paths like `"C:\...\key"`.
fn expand_key_path(key_path: Option<String>) -> Option<String> {
    key_path.map(|s| {
        let stripped = s.trim().trim_matches('"').trim_matches('\'');
        expand_config_value(stripped)
    })
}

/// Terminal dimensions (columns x rows).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PtySize {
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        Self {
            cols: default_cols(),
            rows: default_rows(),
        }
    }
}

/// A key-value pair for environment variables.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// A Docker volume mount definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeMount {
    pub host_path: String,
    pub container_path: String,
    #[serde(default)]
    pub read_only: bool,
}

/// Unified shell session configuration.
///
/// Superset of desktop `LocalShellConfig` and agent `ShellConfig`.
/// - `shell`: shell executable path or name; `None` means auto-detect.
/// - `cols`/`rows`: terminal dimensions (defaults 80x24).
/// - `env`: additional environment variables for the shell process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    pub starting_directory: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            shell: None,
            initial_command: None,
            starting_directory: None,
            cols: default_cols(),
            rows: default_rows(),
            env: HashMap::new(),
        }
    }
}

/// Unified serial port configuration.
///
/// Shared between desktop and agent serial backends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    #[serde(default)]
    pub port: String,
    #[serde(default = "default_baud_rate", deserialize_with = "de_u32_num_or_str")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits", deserialize_with = "de_u8_num_or_str")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits", deserialize_with = "de_u8_num_or_str")]
    pub stop_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_flow_control")]
    pub flow_control: String,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: String::new(),
            baud_rate: default_baud_rate(),
            data_bits: default_data_bits(),
            stop_bits: default_stop_bits(),
            parity: default_parity(),
            flow_control: default_flow_control(),
        }
    }
}

/// Container runtime selection for Docker/Podman sessions.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContainerRuntime {
    /// Automatically detect Docker or Podman.
    #[default]
    Auto,
    /// Use Docker explicitly.
    Docker,
    /// Use Podman explicitly.
    Podman,
}

/// Unified Docker container session configuration.
///
/// Superset of desktop `DockerConfig` and agent `DockerSessionConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerConfig {
    #[serde(default)]
    pub runtime: ContainerRuntime,
    pub image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env_vars: Vec<EnvVar>,
    #[serde(default)]
    pub volumes: Vec<VolumeMount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default = "default_remove_on_exit")]
    pub remove_on_exit: bool,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for DockerConfig {
    fn default() -> Self {
        Self {
            runtime: ContainerRuntime::Auto,
            image: String::new(),
            shell: None,
            cols: default_cols(),
            rows: default_rows(),
            env_vars: Vec::new(),
            volumes: Vec::new(),
            working_directory: None,
            remove_on_exit: default_remove_on_exit(),
            env: HashMap::new(),
        }
    }
}

/// Configuration for a single jump host (bastion) hop in a `ProxyJump` chain.
///
/// Mirrors OpenSSH's `-J` / `ProxyJump` directive: a hop is itself a minimal SSH
/// connection used purely as transport to reach the next hop (or the target).
///
/// Core only uses the inline connection fields here. A hop sourced from a saved
/// connection (referenced by `connection_id`) is resolved to these inline values
/// by the desktop layer *before* the config reaches core (Phase 4) — `connection_id`
/// is carried only so the stored config round-trips.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHostConfig {
    /// Reference to a saved SSH connection ID (resolved to the inline fields by
    /// the desktop layer; unused by core).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// Per-hop connect/handshake timeout (seconds). `None` falls back to
    /// [`DEFAULT_SSH_CONNECT_TIMEOUT_SECS`], mirroring [`SshConfig`], so a slow
    /// bastion can be given a longer budget than a fast one (#951).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_timeout_secs: Option<u64>,
}

impl Default for JumpHostConfig {
    fn default() -> Self {
        Self {
            connection_id: None,
            host: String::new(),
            port: default_ssh_port(),
            username: String::new(),
            auth_method: String::new(),
            password: None,
            key_path: None,
            connect_timeout_secs: None,
        }
    }
}

impl JumpHostConfig {
    /// Build a minimal [`SshConfig`] for establishing this hop, reusing the
    /// standard connect/auth machinery. Terminal-only fields (cols/rows/shell)
    /// are irrelevant for a transport hop and left at their defaults.
    pub fn to_ssh_config(&self) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth_method.clone(),
            password: self.password.clone(),
            key_path: self.key_path.clone(),
            connect_timeout_secs: self.connect_timeout_secs,
            ..SshConfig::default()
        }
    }

    /// Return a copy with all `${VAR}` placeholders and `~` expanded in the
    /// inline connection fields.
    pub fn expand(mut self) -> Self {
        self.host = expand_config_value(&self.host);
        self.username = expand_config_value(&self.username);
        self.key_path = expand_key_path(self.key_path);
        self.password = self.password.map(|s| expand_config_value(&s));
        self
    }
}

/// Unified SSH session configuration.
///
/// Superset of desktop `SshConfig` and agent `SshSessionConfig`.
/// - `port`: defaults to 22.
/// - `cols`/`rows`: terminal dimensions (defaults 80x24).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub shell: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub enable_x11_forwarding: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_monitoring: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_file_browser: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_password: Option<bool>,
    /// Maximum time (seconds) to wait for the TCP connect + SSH handshake before
    /// failing. `None` falls back to [`DEFAULT_SSH_CONNECT_TIMEOUT_SECS`] (#841).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_timeout_secs: Option<u64>,
    /// Optional jump host (`ProxyJump`) chain, ordered outermost → innermost
    /// (`ssh -J edge,bastion` ⇒ `[edge, bastion]`). Empty means a direct
    /// connection. Accepts the legacy `jumpHosts` key for forward compatibility.
    #[serde(default, alias = "jumpHosts", skip_serializing_if = "Vec::is_empty")]
    pub proxy_jump: Vec<JumpHostConfig>,
    /// Forward the local `ssh-agent` to the target (OpenSSH `ForwardAgent`, #1699).
    /// When `true`, agent forwarding is requested on the session channel so the
    /// user's local agent keys are reachable on the final host — and, because the
    /// forwarded-agent channel rides the jump-host tunnel, end to end through the
    /// `proxy_jump` chain. Serde-defaults to `false` and is omitted when false so
    /// existing saved connections stay byte-stable, mirroring `proxy_jump` above.
    #[serde(default, skip_serializing_if = "is_false")]
    pub forward_agent: bool,
}

impl SshConfig {
    /// Connect/handshake timeout, falling back to the default when unset.
    pub fn connect_timeout(&self) -> Duration {
        Duration::from_secs(
            self.connect_timeout_secs
                .unwrap_or(DEFAULT_SSH_CONNECT_TIMEOUT_SECS),
        )
    }
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: default_ssh_port(),
            username: String::new(),
            auth_method: String::new(),
            password: None,
            key_path: None,
            shell: None,
            cols: default_cols(),
            rows: default_rows(),
            env: HashMap::new(),
            enable_x11_forwarding: false,
            enable_monitoring: None,
            enable_file_browser: None,
            save_password: None,
            connect_timeout_secs: None,
            proxy_jump: Vec::new(),
            forward_agent: false,
        }
    }
}

/// Unified WSL (Windows Subsystem for Linux) session configuration.
///
/// Windows-only. Configures a WSL distribution session with optional
/// starting directory and initial command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslConfig {
    /// WSL distribution name (e.g., `"Ubuntu"`, `"Debian"`).
    pub distribution: String,
    /// Directory to start the shell in (within the WSL filesystem).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starting_directory: Option<String>,
    /// Command to run after the shell starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_command: Option<String>,
    /// Terminal column count.
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// Terminal row count.
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Additional environment variables for the shell process.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl Default for WslConfig {
    fn default() -> Self {
        Self {
            distribution: String::new(),
            starting_directory: None,
            initial_command: None,
            cols: default_cols(),
            rows: default_rows(),
            env: HashMap::new(),
        }
    }
}

/// Unified telnet session configuration.
///
/// Shared between desktop and agent telnet backends.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConfig {
    pub host: String,
    #[serde(default = "default_telnet_port")]
    pub port: u16,
}

impl Default for TelnetConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: default_telnet_port(),
        }
    }
}

/// TLS negotiation mode for an FTP connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FtpTlsMode {
    /// Plain FTP — no encryption (credentials and data sent in cleartext).
    #[default]
    None,
    /// Explicit FTPS — connect plain, then upgrade via `AUTH TLS` (STARTTLS).
    Explicit,
    /// Implicit FTPS — TLS handshake immediately on connect (legacy, port 990).
    Implicit,
}

/// FTP data-channel mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FtpDataMode {
    /// Passive mode (default, firewall-friendly): client opens the data channel.
    #[default]
    Passive,
    /// Active mode: server connects back to the client for the data channel.
    Active,
}

/// FTP transfer representation type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FtpTransferType {
    /// Binary / image mode — bytes transferred verbatim (default).
    #[default]
    Binary,
    /// ASCII mode — line-ending translation between hosts.
    Ascii,
}

/// FTP / FTPS session configuration.
///
/// Desktop-only connection config for the `ftp` backend. File listing and
/// transfers are layered on later; this struct carries the connect-time
/// settings (server, TLS, auth, data mode).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConfig {
    /// Hostname or IP address of the FTP server.
    pub host: String,
    /// Control-channel port (21 for plain/explicit, 990 for implicit FTPS).
    #[serde(default = "default_ftp_port")]
    pub port: u16,
    /// TLS negotiation mode.
    #[serde(default)]
    pub tls_mode: FtpTlsMode,
    /// Whether to log in anonymously (username `anonymous`).
    #[serde(default)]
    pub anonymous: bool,
    /// Login username (ignored when [`anonymous`](Self::anonymous) is set).
    #[serde(default)]
    pub username: String,
    /// Login password (ignored when [`anonymous`](Self::anonymous) is set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// Data-channel mode (passive/active).
    #[serde(default)]
    pub mode: FtpDataMode,
    /// Transfer representation type (binary/ascii).
    #[serde(default)]
    pub transfer_type: FtpTransferType,
    /// Directory to change into after login (`CWD`), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_directory: Option<String>,
    /// Connect timeout in seconds.
    #[serde(default = "default_ftp_timeout_secs")]
    pub timeout_secs: u64,
    /// Idle keep-alive interval in seconds. A periodic `NOOP` is sent on the
    /// browsing control connection every `keep_alive_secs` seconds to stop
    /// servers dropping an idle connection. `0` disables keep-alive.
    #[serde(default = "default_ftp_keep_alive_secs")]
    pub keep_alive_secs: u64,
    /// When set, the plain-FTP insecure-connection warning is suppressed for
    /// this connection (the user checked "Don't warn again for this
    /// connection"). Set implicitly by the connect-time warning modal, not by
    /// the settings form, so it has no corresponding schema field.
    #[serde(default)]
    pub suppress_security_warning: bool,
}

impl Default for FtpConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: default_ftp_port(),
            tls_mode: FtpTlsMode::default(),
            anonymous: false,
            username: String::new(),
            password: None,
            mode: FtpDataMode::default(),
            transfer_type: FtpTransferType::default(),
            initial_directory: None,
            timeout_secs: default_ftp_timeout_secs(),
            keep_alive_secs: default_ftp_keep_alive_secs(),
            suppress_security_warning: false,
        }
    }
}

impl FtpConfig {
    /// Connect timeout as a [`Duration`].
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_secs)
    }

    /// Keep-alive interval as a [`Duration`], or `None` when disabled (`0`).
    ///
    /// Backends spawn a periodic `NOOP` task on this interval; returning `None`
    /// means no keep-alive task should be started.
    pub fn keep_alive_interval(&self) -> Option<Duration> {
        (self.keep_alive_secs > 0).then(|| Duration::from_secs(self.keep_alive_secs))
    }
}

// --- Expand methods ---

impl ShellConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    ///
    /// Environment-variable *values* are expanded too, so a configured value of
    /// `${HOME}/bin` resolves against the launching process's environment. Keys
    /// (variable names) are left verbatim.
    pub fn expand(mut self) -> Self {
        self.shell = self.shell.map(|s| expand_config_value(&s));
        self.starting_directory = self.starting_directory.map(|s| expand_config_value(&s));
        self.initial_command = self.initial_command.map(|s| expand_config_value(&s));
        self.env = self
            .env
            .into_iter()
            .map(|(k, v)| (k, expand_config_value(&v)))
            .collect();
        self
    }
}

impl WslConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.distribution = expand_config_value(&self.distribution);
        self.starting_directory = self.starting_directory.map(|s| expand_config_value(&s));
        self.initial_command = self.initial_command.map(|s| expand_config_value(&s));
        self
    }
}

impl TelnetConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.host = expand_config_value(&self.host);
        self
    }
}

impl SerialConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.port = expand_config_value(&self.port);
        self
    }
}

impl FtpConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.host = expand_config_value(&self.host);
        self.username = expand_config_value(&self.username);
        self.password = self.password.map(|s| expand_config_value(&s));
        self.initial_directory = self.initial_directory.map(|s| expand_config_value(&s));
        self
    }
}

impl SshConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.host = expand_config_value(&self.host);
        self.username = expand_config_value(&self.username);
        self.key_path = expand_key_path(self.key_path);
        self.password = self.password.map(|s| expand_config_value(&s));
        self.proxy_jump = self.proxy_jump.into_iter().map(|h| h.expand()).collect();
        self
    }
}

impl DockerConfig {
    /// Return a copy with all `${VAR}` placeholders and `~` expanded.
    pub fn expand(mut self) -> Self {
        self.image = expand_config_value(&self.image);
        self.shell = self.shell.map(|s| expand_config_value(&s));
        self.working_directory = self.working_directory.map(|s| expand_config_value(&s));
        for env in &mut self.env_vars {
            env.key = expand_config_value(&env.key);
            env.value = expand_config_value(&env.value);
        }
        for vol in &mut self.volumes {
            vol.host_path = expand_config_value(&vol.host_path);
            vol.container_path = expand_config_value(&vol.container_path);
        }
        self
    }
}

// --- Flexible numeric deserialization ---

/// A number that may arrive on the wire as a JSON number *or* a numeric string.
///
/// termiHub's schema-driven connection form renders the serial framing fields
/// (baud rate / data bits / stop bits) as `Select` widgets, whose chosen value
/// is emitted as a **string** (`"115200"`). Stored connection definitions,
/// agent-forwarded configs, and the `docs/remote-protocol.md` session config
/// instead carry them as JSON **numbers** (`115200`). Both must deserialize;
/// anything else — a malformed string, a boolean, a float, an array, an
/// object — is **rejected** rather than silently coerced to a default, so a
/// mis-typed framing parameter surfaces a clear error instead of quietly opening
/// the port at the wrong framing (#2351).
#[derive(Deserialize)]
#[serde(untagged)]
enum NumOrStr {
    Num(u64),
    Str(String),
}

impl NumOrStr {
    /// Resolve to a `u64`, parsing the string form and rejecting a non-numeric
    /// value. Shared core of [`de_u32_num_or_str`] and [`de_u8_num_or_str`].
    fn into_u64<E: serde::de::Error>(self) -> Result<u64, E> {
        match self {
            NumOrStr::Num(n) => Ok(n),
            NumOrStr::Str(s) => s
                .trim()
                .parse::<u64>()
                .map_err(|_| E::custom(format!("expected a number, got string {s:?}"))),
        }
    }
}

/// Deserialize a [`u32`] from a JSON number or a numeric string (see [`NumOrStr`]).
fn de_u32_num_or_str<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = NumOrStr::deserialize(deserializer)?.into_u64::<D::Error>()?;
    u32::try_from(value).map_err(|_| {
        <D::Error as serde::de::Error>::custom(format!("value {value} out of range for u32"))
    })
}

/// Deserialize a [`u8`] from a JSON number or a numeric string (see [`NumOrStr`]).
fn de_u8_num_or_str<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = NumOrStr::deserialize(deserializer)?.into_u64::<D::Error>()?;
    u8::try_from(value).map_err(|_| {
        <D::Error as serde::de::Error>::custom(format!("value {value} out of range for u8"))
    })
}

// --- Default value functions ---

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn default_baud_rate() -> u32 {
    115200
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

fn default_parity() -> String {
    "none".to_string()
}

fn default_flow_control() -> String {
    "none".to_string()
}

fn default_remove_on_exit() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

/// `skip_serializing_if` predicate for `bool` fields that default to `false`
/// (e.g. `SshConfig::forward_agent`), so an unset flag is omitted from the JSON.
fn is_false(v: &bool) -> bool {
    !*v
}

fn default_telnet_port() -> u16 {
    23
}

fn default_ftp_port() -> u16 {
    21
}

fn default_ftp_timeout_secs() -> u64 {
    30
}

fn default_ftp_keep_alive_secs() -> u64 {
    60
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- home_directory / expand_tilde_only tests ---

    #[test]
    fn home_directory_returns_some() {
        assert!(
            home_directory().is_some(),
            "expected a home directory to be resolved"
        );
    }

    #[cfg(windows)]
    #[test]
    fn home_directory_reads_user_profile_on_windows() {
        temp_env::with_var("USERPROFILE", Some(r"C:\Users\testuser"), || {
            assert_eq!(
                home_directory(),
                Some(std::path::PathBuf::from(r"C:\Users\testuser"))
            );
        });
    }

    #[cfg(windows)]
    #[test]
    fn expand_value_default_ssh_key_resolves_under_user_profile() {
        // The SSH backend's default key path "~/.ssh/id_rsa" must resolve under
        // the Windows user profile rather than being left untouched, so a
        // Windows-hosted agent finds the user's keys.
        temp_env::with_var("USERPROFILE", Some(r"C:\Users\testuser"), || {
            let expanded = expand_config_value("~/.ssh/id_rsa");
            assert!(!expanded.starts_with('~'), "got: {expanded}");
            assert!(
                expanded.contains(r"C:\Users\testuser") || expanded.contains("C:/Users/testuser"),
                "expected a USERPROFILE-rooted path, got: {expanded}"
            );
            assert!(
                expanded.ends_with(".ssh/id_rsa") || expanded.ends_with(r".ssh\id_rsa"),
                "got: {expanded}"
            );
        });
    }

    #[test]
    fn expand_tilde_only_tilde_alone() {
        let result = expand_tilde_only("~");
        assert!(!result.starts_with('~'), "got: {result}");
        assert!(!result.is_empty());
    }

    #[test]
    fn expand_tilde_only_tilde_slash() {
        let result = expand_tilde_only("~/work");
        assert!(
            result.ends_with("/work") || result.ends_with(r"\work"),
            "got: {result}"
        );
        assert!(!result.starts_with('~'));
    }

    #[test]
    fn expand_tilde_only_tilde_user_unchanged() {
        assert_eq!(expand_tilde_only("~user/foo"), "~user/foo");
    }

    #[test]
    fn expand_tilde_only_absolute_path_unchanged() {
        assert_eq!(expand_tilde_only("/usr/local"), "/usr/local");
    }

    #[test]
    fn expand_tilde_only_does_not_expand_env_vars() {
        // ${HOME} should be returned literally — this helper is for raw paths.
        assert_eq!(expand_tilde_only("${HOME}/foo"), "${HOME}/foo");
    }

    // --- expand_config_value tests ---

    #[test]
    fn expand_value_known_variable() {
        temp_env::with_var("TERMIHUB_TEST_VAR", Some("hello"), || {
            assert_eq!(expand_config_value("${TERMIHUB_TEST_VAR}"), "hello");
        });
    }

    #[test]
    fn expand_value_unknown_variable_becomes_empty() {
        temp_env::with_var_unset("TERMIHUB_NONEXISTENT_VAR_XYZ", || {
            assert_eq!(expand_config_value("${TERMIHUB_NONEXISTENT_VAR_XYZ}"), "");
        });
    }

    #[test]
    fn expand_value_multiple_placeholders() {
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_A", Some("foo")),
                ("TERMIHUB_TEST_B", Some("bar")),
            ],
            || {
                assert_eq!(
                    expand_config_value("${TERMIHUB_TEST_A}@${TERMIHUB_TEST_B}"),
                    "foo@bar"
                );
            },
        );
    }

    #[test]
    fn expand_value_no_placeholders() {
        assert_eq!(expand_config_value("plain text"), "plain text");
    }

    #[test]
    fn expand_value_mixed_env_content() {
        temp_env::with_var("TERMIHUB_TEST_USER", Some("alice"), || {
            assert_eq!(
                expand_config_value("ssh ${TERMIHUB_TEST_USER}@host"),
                "ssh alice@host"
            );
        });
    }

    #[test]
    fn expand_value_tilde_alone() {
        let result = expand_config_value("~");
        assert!(
            !result.starts_with('~'),
            "expected ~ to expand, got: {result}"
        );
        assert!(!result.is_empty());
    }

    #[test]
    fn expand_value_tilde_slash() {
        let result = expand_config_value("~/work");
        assert!(
            result.ends_with("/work") || result.ends_with(r"\work"),
            "expected path ending in /work, got: {result}"
        );
        assert!(!result.starts_with('~'));
    }

    #[test]
    fn expand_value_tilde_user_not_expanded() {
        assert_eq!(expand_config_value("~user/foo"), "~user/foo");
    }

    #[test]
    fn expand_value_absolute_path_unchanged() {
        assert_eq!(expand_config_value("/usr/local"), "/usr/local");
    }

    #[test]
    fn expand_value_env_and_tilde_combined() {
        temp_env::with_var("TERMIHUB_TEST_DIR", Some("projects"), || {
            let result = expand_config_value("~/${TERMIHUB_TEST_DIR}/app");
            assert!(!result.starts_with('~'), "tilde should be expanded");
            assert!(
                result.ends_with("/projects/app") || result.ends_with(r"\projects/app"),
                "expected path ending in /projects/app, got: {result}"
            );
        });
    }

    // --- Default value tests ---

    #[test]
    fn pty_size_default() {
        let size = PtySize::default();
        assert_eq!(size.cols, 80);
        assert_eq!(size.rows, 24);
    }

    #[test]
    fn shell_config_default() {
        let cfg = ShellConfig::default();
        assert!(cfg.shell.is_none());
        assert!(cfg.initial_command.is_none());
        assert!(cfg.starting_directory.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_default() {
        let cfg = SerialConfig::default();
        assert!(cfg.port.is_empty());
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn telnet_config_default() {
        let cfg = TelnetConfig::default();
        assert!(cfg.host.is_empty());
        assert_eq!(cfg.port, 23);
    }

    #[test]
    fn docker_config_default() {
        let cfg = DockerConfig::default();
        assert_eq!(cfg.runtime, ContainerRuntime::Auto);
        assert!(cfg.image.is_empty());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.working_directory.is_none());
        assert!(cfg.remove_on_exit);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn container_runtime_default_is_auto() {
        let rt = ContainerRuntime::default();
        assert_eq!(rt, ContainerRuntime::Auto);
    }

    #[test]
    fn container_runtime_serde_roundtrip() {
        for (rt, expected_json) in [
            (ContainerRuntime::Auto, "\"auto\""),
            (ContainerRuntime::Docker, "\"docker\""),
            (ContainerRuntime::Podman, "\"podman\""),
        ] {
            let json = serde_json::to_string(&rt).unwrap();
            assert_eq!(json, expected_json);
            let back: ContainerRuntime = serde_json::from_str(&json).unwrap();
            assert_eq!(back, rt);
        }
    }

    #[test]
    fn docker_config_missing_runtime_defaults_to_auto() {
        let json = r#"{"image": "nginx"}"#;
        let cfg: DockerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.runtime, ContainerRuntime::Auto);
    }

    #[test]
    fn wsl_config_default() {
        let cfg = WslConfig::default();
        assert!(cfg.distribution.is_empty());
        assert!(cfg.starting_directory.is_none());
        assert!(cfg.initial_command.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn ssh_config_default() {
        let cfg = SshConfig::default();
        assert!(cfg.host.is_empty());
        assert_eq!(cfg.port, 22);
        assert!(cfg.username.is_empty());
        assert!(cfg.auth_method.is_empty());
        assert!(cfg.password.is_none());
        assert!(cfg.key_path.is_none());
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
        assert!(!cfg.enable_x11_forwarding);
        assert!(cfg.enable_monitoring.is_none());
        assert!(cfg.enable_file_browser.is_none());
        assert!(cfg.save_password.is_none());
    }

    // --- Serde round-trip tests ---

    #[test]
    fn pty_size_roundtrip() {
        let size = PtySize {
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&size).unwrap();
        let back: PtySize = serde_json::from_str(&json).unwrap();
        assert_eq!(back.cols, 120);
        assert_eq!(back.rows, 40);
    }

    #[test]
    fn env_var_roundtrip() {
        let var = EnvVar {
            key: "TERM".into(),
            value: "xterm-256color".into(),
        };
        let json = serde_json::to_string(&var).unwrap();
        let back: EnvVar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.key, "TERM");
        assert_eq!(back.value, "xterm-256color");
    }

    #[test]
    fn volume_mount_roundtrip() {
        let vol = VolumeMount {
            host_path: "/host/data".into(),
            container_path: "/data".into(),
            read_only: true,
        };
        let json = serde_json::to_string(&vol).unwrap();
        let back: VolumeMount = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host_path, "/host/data");
        assert_eq!(back.container_path, "/data");
        assert!(back.read_only);
    }

    #[test]
    fn shell_config_roundtrip() {
        let cfg = ShellConfig {
            shell: Some("/bin/zsh".into()),
            initial_command: Some("ls".into()),
            starting_directory: Some("/home/user".into()),
            cols: 100,
            rows: 30,
            env: HashMap::from([("FOO".into(), "bar".into())]),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: ShellConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.shell.as_deref(), Some("/bin/zsh"));
        assert_eq!(back.initial_command.as_deref(), Some("ls"));
        assert_eq!(back.starting_directory.as_deref(), Some("/home/user"));
        assert_eq!(back.cols, 100);
        assert_eq!(back.rows, 30);
        assert_eq!(back.env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn shell_config_expand_expands_env_values() {
        temp_env::with_var("TERMIHUB_TEST_ENV_HOME", Some("/opt/home"), || {
            let cfg = ShellConfig {
                env: HashMap::from([
                    ("PATH_LIKE".into(), "${TERMIHUB_TEST_ENV_HOME}/bin".into()),
                    ("LITERAL".into(), "plain".into()),
                ]),
                ..ShellConfig::default()
            }
            .expand();
            assert_eq!(cfg.env.get("PATH_LIKE").unwrap(), "/opt/home/bin");
            assert_eq!(cfg.env.get("LITERAL").unwrap(), "plain");
        });
    }

    #[test]
    fn serial_config_roundtrip() {
        let cfg = SerialConfig {
            port: "/dev/ttyUSB0".into(),
            baud_rate: 9600,
            data_bits: 7,
            stop_bits: 2,
            parity: "even".into(),
            flow_control: "hardware".into(),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SerialConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.port, "/dev/ttyUSB0");
        assert_eq!(back.baud_rate, 9600);
        assert_eq!(back.data_bits, 7);
        assert_eq!(back.stop_bits, 2);
        assert_eq!(back.parity, "even");
        assert_eq!(back.flow_control, "hardware");
    }

    #[test]
    fn telnet_config_roundtrip() {
        let cfg = TelnetConfig {
            host: "example.com".into(),
            port: 2323,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: TelnetConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "example.com");
        assert_eq!(back.port, 2323);
    }

    #[test]
    fn docker_config_roundtrip() {
        let cfg = DockerConfig {
            runtime: ContainerRuntime::Podman,
            image: "ubuntu:22.04".into(),
            shell: Some("/bin/bash".into()),
            cols: 80,
            rows: 24,
            env_vars: vec![EnvVar {
                key: "MY_VAR".into(),
                value: "my_val".into(),
            }],
            volumes: vec![VolumeMount {
                host_path: "/tmp".into(),
                container_path: "/mnt".into(),
                read_only: false,
            }],
            working_directory: Some("/app".into()),
            remove_on_exit: false,
            env: HashMap::from([("LANG".into(), "en_US.UTF-8".into())]),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: DockerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.runtime, ContainerRuntime::Podman);
        assert_eq!(back.image, "ubuntu:22.04");
        assert_eq!(back.shell.as_deref(), Some("/bin/bash"));
        assert_eq!(back.env_vars.len(), 1);
        assert_eq!(back.volumes.len(), 1);
        assert!(!back.remove_on_exit);
        assert_eq!(back.env.get("LANG").unwrap(), "en_US.UTF-8");
    }

    #[test]
    fn wsl_config_roundtrip() {
        let cfg = WslConfig {
            distribution: "Ubuntu".into(),
            starting_directory: Some("/home/user".into()),
            initial_command: Some("ls".into()),
            cols: 100,
            rows: 30,
            env: HashMap::from([("MY_VAR".into(), "hello".into())]),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: WslConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.distribution, "Ubuntu");
        assert_eq!(back.starting_directory.as_deref(), Some("/home/user"));
        assert_eq!(back.initial_command.as_deref(), Some("ls"));
        assert_eq!(back.cols, 100);
        assert_eq!(back.rows, 30);
        assert_eq!(back.env.get("MY_VAR").unwrap(), "hello");
    }

    #[test]
    fn ssh_config_roundtrip() {
        let cfg = SshConfig {
            host: "example.com".into(),
            port: 2222,
            username: "admin".into(),
            auth_method: "key".into(),
            password: None,
            key_path: Some("/home/admin/.ssh/id_ed25519".into()),
            shell: Some("/bin/bash".into()),
            cols: 132,
            rows: 43,
            env: HashMap::new(),
            enable_x11_forwarding: true,
            enable_monitoring: Some(true),
            enable_file_browser: Some(false),
            save_password: None,
            connect_timeout_secs: Some(15),
            proxy_jump: Vec::new(),
            forward_agent: true,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "example.com");
        assert_eq!(back.port, 2222);
        assert_eq!(back.username, "admin");
        assert_eq!(back.auth_method, "key");
        assert!(back.password.is_none());
        assert_eq!(
            back.key_path.as_deref(),
            Some("/home/admin/.ssh/id_ed25519")
        );
        assert!(back.enable_x11_forwarding);
        assert_eq!(back.enable_monitoring, Some(true));
        assert_eq!(back.enable_file_browser, Some(false));
        assert!(back.save_password.is_none());
        assert_eq!(back.connect_timeout_secs, Some(15));
        assert!(back.forward_agent);
    }

    // --- agent forwarding (ForwardAgent) tests (#1699) ---

    #[test]
    fn ssh_config_forward_agent_roundtrip() {
        let cfg = SshConfig {
            forward_agent: true,
            ..SshConfig::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        // Serializes camelCase and true.
        assert!(json.contains("\"forwardAgent\":true"), "got: {json}");
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert!(back.forward_agent);
    }

    #[test]
    fn ssh_config_forward_agent_defaults_false_and_is_omitted() {
        // Default (false) is never written, keeping existing saved JSON byte-stable.
        let json = serde_json::to_string(&SshConfig::default()).unwrap();
        assert!(!json.contains("forwardAgent"), "got: {json}");
    }

    #[test]
    fn ssh_config_forward_agent_absent_deserializes_false() {
        // A saved connection from before this field existed must still load, and
        // behave exactly as before (no forwarding).
        let json = r#"{ "host": "h", "username": "u", "authMethod": "agent" }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert!(!cfg.forward_agent);
    }

    // --- jump host (ProxyJump) tests ---

    #[test]
    fn ssh_config_proxy_jump_roundtrip() {
        let cfg = SshConfig {
            host: "target.internal".into(),
            username: "deploy".into(),
            auth_method: "key".into(),
            proxy_jump: vec![JumpHostConfig {
                host: "bastion.example.com".into(),
                port: 2222,
                username: "admin".into(),
                auth_method: "key".into(),
                key_path: Some("~/.ssh/bastion".into()),
                ..Default::default()
            }],
            ..SshConfig::default()
        };
        let json = serde_json::to_string(&cfg).unwrap();
        // Field serializes camelCase.
        assert!(json.contains("\"proxyJump\""));
        let back: SshConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy_jump.len(), 1);
        assert_eq!(back.proxy_jump[0].host, "bastion.example.com");
        assert_eq!(back.proxy_jump[0].port, 2222);
        assert_eq!(back.proxy_jump[0].username, "admin");
        assert_eq!(
            back.proxy_jump[0].key_path.as_deref(),
            Some("~/.ssh/bastion")
        );
    }

    #[test]
    fn ssh_config_empty_proxy_jump_is_omitted() {
        let json = serde_json::to_string(&SshConfig::default()).unwrap();
        assert!(!json.contains("proxyJump"));
    }

    #[test]
    fn ssh_config_proxy_jump_defaults_when_absent() {
        let json = r#"{ "host": "h", "username": "u", "authMethod": "password" }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.proxy_jump.is_empty());
    }

    #[test]
    fn ssh_config_accepts_legacy_jump_hosts_alias() {
        // The earlier draft used `jumpHosts`; it must still deserialize.
        let json = r#"{
            "host": "h", "username": "u", "authMethod": "key",
            "jumpHosts": [
                { "host": "bastion", "port": 22, "username": "admin", "authMethod": "agent" }
            ]
        }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.proxy_jump.len(), 1);
        assert_eq!(cfg.proxy_jump[0].host, "bastion");
    }

    #[test]
    fn jump_host_config_port_defaults_to_22() {
        let json = r#"{ "host": "bastion", "username": "admin", "authMethod": "key" }"#;
        let hop: JumpHostConfig = serde_json::from_str(json).unwrap();
        assert_eq!(hop.port, 22);
    }

    #[test]
    fn jump_host_config_to_ssh_config_copies_connection_fields() {
        let hop = JumpHostConfig {
            host: "bastion".into(),
            port: 2200,
            username: "admin".into(),
            auth_method: "password".into(),
            password: Some("secret".into()),
            key_path: None,
            connection_id: Some("saved-id".into()),
            connect_timeout_secs: None,
        };
        let cfg = hop.to_ssh_config();
        assert_eq!(cfg.host, "bastion");
        assert_eq!(cfg.port, 2200);
        assert_eq!(cfg.username, "admin");
        assert_eq!(cfg.auth_method, "password");
        assert_eq!(cfg.password.as_deref(), Some("secret"));
    }

    #[test]
    fn jump_host_connect_timeout_defaults_when_unset() {
        // A hop with no per-hop override falls back to the default budget, so a
        // chain authored before #951 keeps its current behavior.
        let hop = JumpHostConfig {
            host: "bastion".into(),
            username: "admin".into(),
            auth_method: "agent".into(),
            ..JumpHostConfig::default()
        };
        assert_eq!(hop.connect_timeout_secs, None);
        assert_eq!(
            hop.to_ssh_config().connect_timeout(),
            Duration::from_secs(DEFAULT_SSH_CONNECT_TIMEOUT_SECS)
        );
    }

    #[test]
    fn jump_host_connect_timeout_honors_per_hop_override() {
        // A slow bastion gets a longer budget than the default; the per-hop value
        // must survive the trip through `to_ssh_config` so `connect_gateway_chain`
        // bounds the hop by it (#951).
        let hop = JumpHostConfig {
            host: "slow-bastion".into(),
            username: "admin".into(),
            auth_method: "agent".into(),
            connect_timeout_secs: Some(45),
            ..JumpHostConfig::default()
        };
        assert_eq!(
            hop.to_ssh_config().connect_timeout(),
            Duration::from_secs(45)
        );
    }

    #[test]
    fn jump_host_connect_timeout_roundtrips_and_omits_when_unset() {
        let with_timeout = JumpHostConfig {
            host: "bastion".into(),
            username: "admin".into(),
            auth_method: "agent".into(),
            connect_timeout_secs: Some(30),
            ..JumpHostConfig::default()
        };
        let json = serde_json::to_string(&with_timeout).unwrap();
        assert!(json.contains("\"connectTimeoutSecs\":30"), "json: {json}");
        let back: JumpHostConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.connect_timeout_secs, Some(30));

        // Unset must be omitted from the serialized form, matching `SshConfig`.
        let without = serde_json::to_string(&JumpHostConfig::default()).unwrap();
        assert!(!without.contains("connectTimeoutSecs"), "json: {without}");
    }

    #[test]
    fn ssh_config_expand_expands_inline_jump_hosts() {
        // SAFETY: test-only env var, single value.
        unsafe { std::env::set_var("THUB_JUMP_TEST_HOST", "bastion.expanded") };
        let cfg = SshConfig {
            host: "target".into(),
            username: "u".into(),
            auth_method: "key".into(),
            proxy_jump: vec![JumpHostConfig {
                host: "${THUB_JUMP_TEST_HOST}".into(),
                username: "admin".into(),
                auth_method: "key".into(),
                ..Default::default()
            }],
            ..SshConfig::default()
        }
        .expand();
        assert_eq!(cfg.proxy_jump[0].host, "bastion.expanded");
        unsafe { std::env::remove_var("THUB_JUMP_TEST_HOST") };
    }

    // --- camelCase field name tests ---

    #[test]
    fn shell_config_snake_case_fields() {
        let json = r#"{
            "shell": null,
            "initial_command": "echo hi",
            "starting_directory": "/tmp",
            "cols": 80,
            "rows": 24,
            "env": {}
        }"#;
        let cfg: ShellConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.initial_command.as_deref(), Some("echo hi"));
        assert_eq!(cfg.starting_directory.as_deref(), Some("/tmp"));
    }

    #[test]
    fn serial_config_camel_case_fields() {
        let json = r#"{
            "port": "COM3",
            "baudRate": 9600,
            "dataBits": 8,
            "stopBits": 1,
            "parity": "none",
            "flowControl": "none"
        }"#;
        let cfg: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, "COM3");
        assert_eq!(cfg.baud_rate, 9600);
    }

    #[test]
    fn docker_config_camel_case_fields() {
        let json = r#"{
            "image": "alpine",
            "envVars": [],
            "volumes": [],
            "workingDirectory": "/opt",
            "removeOnExit": false
        }"#;
        let cfg: DockerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.working_directory.as_deref(), Some("/opt"));
        assert!(!cfg.remove_on_exit);
    }

    #[test]
    fn wsl_config_camel_case_fields() {
        let json = r#"{
            "distribution": "Ubuntu",
            "startingDirectory": "/home/user",
            "initialCommand": "echo hi"
        }"#;
        let cfg: WslConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.distribution, "Ubuntu");
        assert_eq!(cfg.starting_directory.as_deref(), Some("/home/user"));
        assert_eq!(cfg.initial_command.as_deref(), Some("echo hi"));
    }

    #[test]
    fn ssh_config_camel_case_fields() {
        let json = r#"{
            "host": "server",
            "port": 22,
            "username": "root",
            "authMethod": "password",
            "keyPath": null,
            "enableX11Forwarding": true,
            "enableMonitoring": true,
            "enableFileBrowser": false,
            "savePassword": true
        }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.enable_x11_forwarding);
        assert_eq!(cfg.enable_monitoring, Some(true));
        assert_eq!(cfg.enable_file_browser, Some(false));
        assert_eq!(cfg.save_password, Some(true));
    }

    // --- Serde default tests (missing fields use defaults) ---

    #[test]
    fn shell_config_missing_fields_use_defaults() {
        let json = r#"{}"#;
        let cfg: ShellConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.shell.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn serial_config_missing_fields_use_defaults() {
        let json = r#"{"port": "/dev/ttyS0"}"#;
        let cfg: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.baud_rate, 115200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, "none");
        assert_eq!(cfg.flow_control, "none");
    }

    #[test]
    fn telnet_config_missing_port_uses_default() {
        let json = r#"{"host": "example.com"}"#;
        let cfg: TelnetConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.host, "example.com");
        assert_eq!(cfg.port, 23);
    }

    #[test]
    fn ftp_config_default() {
        let cfg = FtpConfig::default();
        assert!(cfg.host.is_empty());
        assert_eq!(cfg.port, 21);
        assert_eq!(cfg.tls_mode, FtpTlsMode::None);
        assert!(!cfg.anonymous);
        assert!(cfg.username.is_empty());
        assert!(cfg.password.is_none());
        assert_eq!(cfg.mode, FtpDataMode::Passive);
        assert_eq!(cfg.transfer_type, FtpTransferType::Binary);
        assert!(cfg.initial_directory.is_none());
        assert_eq!(cfg.timeout_secs, 30);
        assert_eq!(cfg.timeout(), Duration::from_secs(30));
        // Keep-alive defaults to 60s (concept: periodic NOOP, default 60s).
        assert_eq!(cfg.keep_alive_secs, 60);
        assert_eq!(cfg.keep_alive_interval(), Some(Duration::from_secs(60)));
    }

    #[test]
    fn ftp_config_keep_alive_interval_disabled_when_zero() {
        let cfg = FtpConfig {
            keep_alive_secs: 0,
            ..FtpConfig::default()
        };
        assert_eq!(
            cfg.keep_alive_interval(),
            None,
            "keep-alive of 0 must disable the NOOP task"
        );
    }

    #[test]
    fn ftp_config_keep_alive_secs_camel_case() {
        let json = r#"{"host": "ftp.example.com", "keepAliveSecs": 15}"#;
        let cfg: FtpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.keep_alive_secs, 15);
        assert_eq!(cfg.keep_alive_interval(), Some(Duration::from_secs(15)));
    }

    #[test]
    fn ftp_config_missing_fields_use_defaults() {
        // Only host provided — port/tlsMode/anonymous/timeout fall back to defaults.
        let json = r#"{"host": "ftp.example.com"}"#;
        let cfg: FtpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.host, "ftp.example.com");
        assert_eq!(cfg.port, 21);
        assert_eq!(cfg.tls_mode, FtpTlsMode::None);
        assert!(!cfg.anonymous);
        assert_eq!(cfg.mode, FtpDataMode::Passive);
        assert_eq!(cfg.transfer_type, FtpTransferType::Binary);
        assert_eq!(cfg.timeout_secs, 30);
    }

    #[test]
    fn ftp_config_camel_case_fields() {
        let json = r#"{
            "host": "ftp.example.com",
            "port": 990,
            "tlsMode": "implicit",
            "anonymous": false,
            "username": "admin",
            "password": "secret",
            "mode": "active",
            "transferType": "ascii",
            "initialDirectory": "/pub",
            "timeoutSecs": 45
        }"#;
        let cfg: FtpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, 990);
        assert_eq!(cfg.tls_mode, FtpTlsMode::Implicit);
        assert_eq!(cfg.username, "admin");
        assert_eq!(cfg.password.as_deref(), Some("secret"));
        assert_eq!(cfg.mode, FtpDataMode::Active);
        assert_eq!(cfg.transfer_type, FtpTransferType::Ascii);
        assert_eq!(cfg.initial_directory.as_deref(), Some("/pub"));
        assert_eq!(cfg.timeout_secs, 45);
    }

    #[test]
    fn ftp_config_anonymous_parse() {
        let json = r#"{"host": "ftp.example.com", "anonymous": true}"#;
        let cfg: FtpConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.anonymous);
        assert!(cfg.username.is_empty());
    }

    #[test]
    fn ftp_tls_mode_serde_values() {
        for (mode, expected) in [
            (FtpTlsMode::None, "\"none\""),
            (FtpTlsMode::Explicit, "\"explicit\""),
            (FtpTlsMode::Implicit, "\"implicit\""),
        ] {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, expected);
            let back: FtpTlsMode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, mode);
        }
    }

    #[test]
    fn ftp_config_roundtrip() {
        let cfg = FtpConfig {
            host: "ftp.example.com".into(),
            port: 21,
            tls_mode: FtpTlsMode::Explicit,
            anonymous: false,
            username: "admin".into(),
            password: Some("pw".into()),
            mode: FtpDataMode::Passive,
            transfer_type: FtpTransferType::Binary,
            initial_directory: Some("/pub".into()),
            timeout_secs: 30,
            keep_alive_secs: 60,
            suppress_security_warning: false,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"tlsMode\""));
        assert!(json.contains("\"transferType\""));
        assert!(json.contains("\"initialDirectory\""));
        let back: FtpConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "ftp.example.com");
        assert_eq!(back.tls_mode, FtpTlsMode::Explicit);
        assert_eq!(back.initial_directory.as_deref(), Some("/pub"));
    }

    #[test]
    fn ftp_config_expand_replaces_placeholders() {
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_FTP_HOST", Some("10.0.0.9")),
                ("TERMIHUB_TEST_FTP_USER", Some("deploy")),
            ],
            || {
                let cfg = FtpConfig {
                    host: "${TERMIHUB_TEST_FTP_HOST}".into(),
                    username: "${TERMIHUB_TEST_FTP_USER}".into(),
                    initial_directory: Some("~/uploads".into()),
                    ..FtpConfig::default()
                };
                let expanded = cfg.expand();
                assert_eq!(expanded.host, "10.0.0.9");
                assert_eq!(expanded.username, "deploy");
                assert!(
                    !expanded
                        .initial_directory
                        .as_ref()
                        .unwrap()
                        .starts_with('~'),
                    "tilde should be expanded in initial directory"
                );
            },
        );
    }

    #[test]
    fn docker_config_missing_fields_use_defaults() {
        let json = r#"{"image": "nginx"}"#;
        let cfg: DockerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env_vars.is_empty());
        assert!(cfg.volumes.is_empty());
        assert!(cfg.remove_on_exit);
    }

    #[test]
    fn wsl_config_missing_fields_use_defaults() {
        let json = r#"{"distribution": "Debian"}"#;
        let cfg: WslConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.distribution, "Debian");
        assert!(cfg.starting_directory.is_none());
        assert!(cfg.initial_command.is_none());
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn ssh_config_missing_optional_fields_use_defaults() {
        let json = r#"{
            "host": "h",
            "username": "u",
            "authMethod": "password"
        }"#;
        let cfg: SshConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, 22);
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
        assert!(!cfg.enable_x11_forwarding);
        assert!(cfg.env.is_empty());
    }

    // --- Expand method tests ---

    #[test]
    fn telnet_config_expand_replaces_host() {
        temp_env::with_var("TERMIHUB_TEST_TELNET_HOST", Some("10.0.0.1"), || {
            let cfg = TelnetConfig {
                host: "${TERMIHUB_TEST_TELNET_HOST}".into(),
                ..TelnetConfig::default()
            };
            let expanded = cfg.expand();
            assert_eq!(expanded.host, "10.0.0.1");
        });
    }

    #[test]
    fn serial_config_expand_replaces_port() {
        temp_env::with_var("TERMIHUB_TEST_SERIAL_PORT", Some("/dev/ttyACM0"), || {
            let cfg = SerialConfig {
                port: "${TERMIHUB_TEST_SERIAL_PORT}".into(),
                ..SerialConfig::default()
            };
            let expanded = cfg.expand();
            assert_eq!(expanded.port, "/dev/ttyACM0");
        });
    }

    #[test]
    fn ssh_config_expand_replaces_placeholders() {
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_SSH_HOST", Some("192.168.1.100")),
                ("TERMIHUB_TEST_SSH_USER", Some("deploy")),
            ],
            || {
                let cfg = SshConfig {
                    host: "${TERMIHUB_TEST_SSH_HOST}".into(),
                    username: "${TERMIHUB_TEST_SSH_USER}".into(),
                    auth_method: "key".into(),
                    key_path: Some("${HOME}/.ssh/id_rsa".into()),
                    ..SshConfig::default()
                };
                let expanded = cfg.expand();
                assert_eq!(expanded.host, "192.168.1.100");
                assert_eq!(expanded.username, "deploy");
            },
        );
    }

    #[test]
    fn ssh_config_expand_tilde_in_key_path() {
        let cfg = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "key".into(),
            key_path: Some("~/.ssh/id_ed25519".into()),
            ..SshConfig::default()
        };
        let expanded = cfg.expand();
        let key = expanded.key_path.unwrap();
        assert!(
            !key.starts_with('~'),
            "tilde should be expanded, got: {key}"
        );
        assert!(
            key.ends_with(".ssh/id_ed25519") || key.ends_with(r".ssh\id_ed25519"),
            "expected path ending in .ssh/id_ed25519, got: {key}"
        );
    }

    #[test]
    fn ssh_config_expand_strips_quotes_from_key_path() {
        let cfg = SshConfig {
            host: "example.com".into(),
            username: "user".into(),
            auth_method: "key".into(),
            key_path: Some(r#""C:\Users\me\.ssh\id_ed25519""#.into()),
            ..SshConfig::default()
        };
        let expanded = cfg.expand();
        let key = expanded.key_path.unwrap();
        assert!(!key.contains('"'), "quotes should be stripped, got: {key}");
        assert!(
            key.starts_with("C:"),
            "expected Windows path after stripping, got: {key}"
        );
    }

    #[test]
    fn docker_config_expand_replaces_placeholders() {
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_DOCKER_IMAGE", Some("myapp")),
                ("TERMIHUB_TEST_DOCKER_VAL", Some("production")),
            ],
            || {
                let cfg = DockerConfig {
                    image: "${TERMIHUB_TEST_DOCKER_IMAGE}:latest".into(),
                    shell: Some("${TERMIHUB_TEST_DOCKER_IMAGE}".into()),
                    env_vars: vec![EnvVar {
                        key: "ENV".into(),
                        value: "${TERMIHUB_TEST_DOCKER_VAL}".into(),
                    }],
                    working_directory: Some("${TERMIHUB_TEST_DOCKER_VAL}".into()),
                    ..DockerConfig::default()
                };
                let expanded = cfg.expand();
                assert_eq!(expanded.image, "myapp:latest");
                assert_eq!(expanded.shell, Some("myapp".into()));
                assert_eq!(expanded.env_vars[0].value, "production");
                assert_eq!(expanded.working_directory, Some("production".into()));
            },
        );
    }

    #[test]
    fn docker_config_expand_tilde_in_volumes() {
        let cfg = DockerConfig {
            image: "ubuntu".into(),
            volumes: vec![VolumeMount {
                host_path: "~/projects".into(),
                container_path: "/workspace".into(),
                read_only: true,
            }],
            working_directory: Some("~/work".into()),
            ..DockerConfig::default()
        };
        let expanded = cfg.expand();
        assert!(
            !expanded.volumes[0].host_path.starts_with('~'),
            "tilde should be expanded in volume host path, got: {}",
            expanded.volumes[0].host_path
        );
        assert!(
            !expanded
                .working_directory
                .as_ref()
                .unwrap()
                .starts_with('~'),
            "tilde should be expanded in working directory"
        );
    }

    #[test]
    fn wsl_config_expand_replaces_placeholders() {
        temp_env::with_vars(
            [
                ("TERMIHUB_TEST_WSL_DISTRO", Some("Ubuntu")),
                ("TERMIHUB_TEST_WSL_CMD", Some("echo hello")),
            ],
            || {
                let cfg = WslConfig {
                    distribution: "${TERMIHUB_TEST_WSL_DISTRO}".into(),
                    starting_directory: Some("~/projects".into()),
                    initial_command: Some("${TERMIHUB_TEST_WSL_CMD}".into()),
                    ..WslConfig::default()
                };
                let expanded = cfg.expand();
                assert_eq!(expanded.distribution, "Ubuntu");
                assert!(
                    !expanded
                        .starting_directory
                        .as_ref()
                        .unwrap()
                        .starts_with('~'),
                    "tilde should be expanded in starting directory"
                );
                assert_eq!(expanded.initial_command, Some("echo hello".into()));
            },
        );
    }

    // --- New ${VAR} placeholder syntax (#726) ---

    #[test]
    fn ssh_config_expand_supports_dollar_brace_syntax() {
        temp_env::with_vars(
            [
                ("TERMIHUB_NEW_SSH_HOST", Some("10.10.10.10")),
                ("TERMIHUB_NEW_SSH_USER", Some("ops")),
            ],
            || {
                let cfg = SshConfig {
                    host: "${TERMIHUB_NEW_SSH_HOST}".into(),
                    username: "${TERMIHUB_NEW_SSH_USER}".into(),
                    auth_method: "key".into(),
                    ..SshConfig::default()
                };
                let expanded = cfg.expand();
                assert_eq!(expanded.host, "10.10.10.10");
                assert_eq!(expanded.username, "ops");
            },
        );
    }

    #[test]
    fn telnet_config_expand_supports_dollar_brace_syntax() {
        temp_env::with_var("TERMIHUB_NEW_TELNET_HOST", Some("172.16.0.5"), || {
            let cfg = TelnetConfig {
                host: "${TERMIHUB_NEW_TELNET_HOST}".into(),
                ..TelnetConfig::default()
            };
            let expanded = cfg.expand();
            assert_eq!(expanded.host, "172.16.0.5");
        });
    }

    #[test]
    fn ssh_config_expand_unknown_var_becomes_empty_string() {
        temp_env::with_var_unset("TERMIHUB_DEFINITELY_UNSET_VAR_QQ", || {
            let cfg = SshConfig {
                host: "host-${TERMIHUB_DEFINITELY_UNSET_VAR_QQ}-end".into(),
                username: "user".into(),
                auth_method: "password".into(),
                ..SshConfig::default()
            };
            let expanded = cfg.expand();
            assert_eq!(expanded.host, "host--end");
        });
    }

    #[test]
    fn docker_config_expand_supports_dollar_brace_syntax() {
        temp_env::with_var("TERMIHUB_NEW_DOCKER_IMG", Some("alpine"), || {
            let cfg = DockerConfig {
                image: "${TERMIHUB_NEW_DOCKER_IMG}:3".into(),
                ..DockerConfig::default()
            };
            let expanded = cfg.expand();
            assert_eq!(expanded.image, "alpine:3");
        });
    }

    #[test]
    fn ssh_connect_timeout_default_is_forgiving() {
        // Raised from 20 s (#2087) so a slow-first-resolve host (cold DNS) has
        // room to connect within the budget instead of failing at 20 s of which
        // most was DNS. Comfortably above the original 20 s.
        assert_eq!(DEFAULT_SSH_CONNECT_TIMEOUT_SECS, 45);
    }

    #[test]
    fn ssh_connect_timeout_defaults_when_unset() {
        let cfg = SshConfig::default();
        assert_eq!(cfg.connect_timeout_secs, None);
        assert_eq!(
            cfg.connect_timeout(),
            Duration::from_secs(DEFAULT_SSH_CONNECT_TIMEOUT_SECS)
        );
    }

    #[test]
    fn ssh_connect_timeout_honours_override() {
        let cfg = SshConfig {
            connect_timeout_secs: Some(5),
            ..SshConfig::default()
        };
        assert_eq!(cfg.connect_timeout(), Duration::from_secs(5));
    }

    // --- SerialConfig flexible numeric deserialization (#2351) ---

    #[test]
    fn serial_config_deserializes_numeric_framing_fields() {
        // The canonical wire form: JSON numbers (stored/agent-forwarded configs,
        // docs/remote-protocol.md). These must be honoured, never dropped to a
        // default.
        let cfg: SerialConfig = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": 9600,
            "dataBits": 7,
            "stopBits": 2,
            "parity": "even",
            "flowControl": "hardware",
        }))
        .expect("numeric framing fields should deserialize");
        assert_eq!(cfg.baud_rate, 9600);
        assert_eq!(cfg.data_bits, 7);
        assert_eq!(cfg.stop_bits, 2);
    }

    #[test]
    fn serial_config_deserializes_string_framing_fields() {
        // The schema form's `Select` widgets emit numeric strings; these must
        // still parse to the same values.
        let cfg: SerialConfig = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": "9600",
            "dataBits": "7",
            "stopBits": "2",
        }))
        .expect("string framing fields should deserialize");
        assert_eq!(cfg.baud_rate, 9600);
        assert_eq!(cfg.data_bits, 7);
        assert_eq!(cfg.stop_bits, 2);
    }

    #[test]
    fn serial_config_absent_framing_fields_use_defaults() {
        let cfg: SerialConfig = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
        }))
        .expect("absent framing fields should fall back to defaults");
        assert_eq!(cfg.baud_rate, default_baud_rate());
        assert_eq!(cfg.data_bits, default_data_bits());
        assert_eq!(cfg.stop_bits, default_stop_bits());
    }

    #[test]
    fn serial_config_rejects_malformed_baud_string() {
        // Regression for #2351: a malformed value must error, not silently
        // default to 115200.
        let result: Result<SerialConfig, _> = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": "fast",
        }));
        assert!(result.is_err(), "malformed baud string must be rejected");
    }

    #[test]
    fn serial_config_rejects_non_numeric_baud_type() {
        // A boolean (or any non-number, non-numeric-string) must error.
        let result: Result<SerialConfig, _> = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
            "baudRate": true,
        }));
        assert!(result.is_err(), "boolean baud rate must be rejected");
    }

    #[test]
    fn serial_config_rejects_out_of_range_data_bits() {
        // 999 does not fit in a u8; must error rather than wrap or default.
        let result: Result<SerialConfig, _> = serde_json::from_value(serde_json::json!({
            "port": "/dev/ttyUSB0",
            "dataBits": 999,
        }));
        assert!(result.is_err(), "out-of-range data bits must be rejected");
    }
}
