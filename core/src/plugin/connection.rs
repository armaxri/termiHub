//! Adapter that presents a native plugin backend as a
//! [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Every native plugin runs out of process, in its own sandboxed
//! `termihub-plugin-runner` (ADR-19): the host loader ([`super::host`]) starts
//! the runner and keeps a [`SandboxedPluginHandle`] to it.
//! [`PluginConnectionType`] wraps that handle so a plugin-provided terminal
//! backend slots into the same
//! [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry) and
//! session machinery as the built-in backends (local shell, SSH, telnet, …).
//!
//! # Output
//!
//! The runner's reader thread delivers a session's output straight into the
//! [`OutputSender`] the terminal layer subscribed through
//! [`subscribe_output`](crate::connection::ConnectionType::subscribe_output);
//! no forwarding thread is needed.
//!
//! # Scope
//!
//! This is the *load-and-register* adapter (#1995), wired through to session
//! creation (#1999): the plugin's declared `configSchema` is translated into the
//! type's [`SettingsSchema`](crate::connection::SettingsSchema) (see
//! [`config_schema_to_settings_schema`]) so the existing `DynamicForm` renders the
//! config form with no bespoke UI, and the raw settings JSON is forwarded to the
//! plugin verbatim at connect time.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use termihub_plugin_api::PluginError;

use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SelectOption,
    SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use super::capabilities::ConnectionPolicy;
use super::sandbox::{BridgeGrant, SandboxedPluginHandle, SandboxedSession};
use super::security::{PermissionError, PermissionSet};
use super::PluginPermission;

use crate::output::OUTPUT_CHANNEL_CAPACITY;
use tokio_util::sync::CancellationToken;

/// A [`ConnectionType`] backed by a native plugin backend, served by the
/// plugin's sandboxed runner process (#4182, ADR-19).
///
/// Holds the plugin's [`SandboxedPluginHandle`] (which keeps the runner
/// reachable and respawns it after an idle reap) for as long as this session is
/// alive.
pub struct PluginConnectionType {
    /// The active runner session, `None` until [`connect`](ConnectionType::connect).
    backend: Option<SandboxedSession>,
    connection_type: String,
    display_name: String,
    /// The form schema the frontend renders for this type, derived from the
    /// plugin's declared `configSchema` at load time.
    settings_schema: SettingsSchema,
    /// The permissions this plugin was granted, carried so host-mediated
    /// capabilities (filesystem path resolution, network, …) can enforce them
    /// per session (concept §13).
    permissions: PermissionSet,
    /// The host-side connection policy (concurrent-connection ceiling + connect
    /// timeout) the host enforces on this session's capability-bridge requests
    /// (#2028). Defaults to [`ConnectionPolicy::default`]; the host derives it
    /// from the plugin's manifest via [`with_connection_policy`](Self::with_connection_policy).
    connection_policy: ConnectionPolicy,
    /// The plugin-level user settings JSON delivered to every session of this
    /// plugin at connect (PLG-008) — the manifest `settings` with the user's
    /// stored overrides applied. Defaults to `"{}"` (no settings); the host
    /// resolves it once at load time via
    /// [`with_plugin_settings`](Self::with_plugin_settings).
    plugin_settings_json: String,
    /// Current output sink; swapped by
    /// [`subscribe_output`](ConnectionType::subscribe_output). The runner's
    /// reader thread reads the latest value for every output frame.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    /// The plugin's runner. Declared last, so a live session is retired before
    /// this connection's reference to the runner is released (the `Drop` impl
    /// keeps that order when it hands the session to the blocking pool, #4499).
    handle: Arc<SandboxedPluginHandle>,
}

impl PluginConnectionType {
    /// Build a fresh, unconnected connection of the given plugin type, served
    /// by the plugin runner behind `handle` and scoped to the plugin's granted
    /// `permissions`.
    ///
    /// `settings_schema` is the form schema derived from the plugin's manifest
    /// `configSchema` (see [`config_schema_to_settings_schema`]); the host derives
    /// it once at load time and clones it into every instance the factory makes.
    #[must_use]
    pub fn new(
        handle: Arc<SandboxedPluginHandle>,
        connection_type: String,
        display_name: String,
        settings_schema: SettingsSchema,
        permissions: PermissionSet,
    ) -> Self {
        Self {
            handle,
            connection_type,
            display_name,
            settings_schema,
            permissions,
            connection_policy: ConnectionPolicy::default(),
            plugin_settings_json: "{}".to_string(),
            backend: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the plugin-level user settings delivered to every session of this
    /// type at connect (PLG-008).
    ///
    /// The host resolves the effective settings — the manifest `settings`
    /// defaults overlaid with the user's stored overrides — once at load time
    /// (see [`resolve_plugin_settings_json`](super::resolve_plugin_settings_json))
    /// and applies them to every session the factory makes, so a declared
    /// setting like `defaultNamespace` reaches the backend. Without this call the
    /// default `"{}"` (no settings) is delivered, so an old plugin is unaffected.
    #[must_use]
    pub fn with_plugin_settings(mut self, settings_json: String) -> Self {
        self.plugin_settings_json = settings_json;
        self
    }

    /// Set the host-side [`ConnectionPolicy`] for sessions of this type (#2028).
    ///
    /// The host derives the policy from the plugin's manifest `connectionPolicy`
    /// once at load time and applies it to every session the factory makes, so a
    /// plugin's declared concurrency ceiling and connect timeout are enforced on
    /// the capability bridge. Without this call the [`ConnectionPolicy::default`]
    /// remains in force.
    #[must_use]
    pub fn with_connection_policy(mut self, policy: ConnectionPolicy) -> Self {
        self.connection_policy = policy;
        self
    }

    /// The permission set this plugin session was granted.
    #[must_use]
    pub fn permissions(&self) -> &PermissionSet {
        &self.permissions
    }

    /// Require that this plugin holds `permission` before a host-mediated
    /// capability acts on its behalf. Returns [`PermissionError::Denied`]
    /// otherwise (e.g. a backend without `network` cannot open connections).
    pub fn require_permission(&self, permission: PluginPermission) -> Result<(), PermissionError> {
        self.permissions.require(permission)
    }

    /// Resolve and authorize a plugin-supplied filesystem path against this
    /// plugin's declared scope, rejecting paths outside it (concept §13). This is
    /// the guard a host-mediated filesystem bridge routes plugin paths through.
    pub fn resolve_scoped_path(&self, requested: &Path) -> Result<PathBuf, PermissionError> {
        self.permissions.check_path(requested)
    }
}

/// Translate a plugin's declared JSON-Schema `configSchema` into the
/// [`SettingsSchema`] the dynamic connection form renders.
///
/// The subset termiHub's form understands is mapped: a top-level object whose
/// `properties` each become a [`SettingsField`] in a single "Configuration"
/// group, in the schema's own key order. A property's `type` maps to a
/// [`FieldType`] (`boolean` → toggle, `number`/`integer` → number with
/// `minimum`/`maximum` bounds, a string `enum` → select, a `"password"` format
/// hint → masked input); everything else degrades to a plain text field so no
/// declared setting is ever unreachable. `title`, `description`, `default`, and
/// the object's `required` list flow through. A schema with no usable
/// `properties` yields an empty schema (the raw settings JSON is still forwarded
/// to the plugin verbatim).
#[must_use]
pub fn config_schema_to_settings_schema(schema: &serde_json::Value) -> SettingsSchema {
    let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
        return SettingsSchema { groups: vec![] };
    };
    let required: HashSet<&str> = schema
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();

    let fields: Vec<SettingsField> = props
        .iter()
        .map(|(key, spec)| SettingsField {
            key: key.clone(),
            label: spec
                .get("title")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| humanize_key(key)),
            description: spec
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            help_text: None,
            field_type: field_type_from_spec(spec),
            required: required.contains(key.as_str()),
            default: spec.get("default").cloned(),
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        })
        .collect();

    if fields.is_empty() {
        return SettingsSchema { groups: vec![] };
    }
    SettingsSchema {
        groups: vec![SettingsGroup {
            collapsed: false,
            key: "config".to_string(),
            label: "Configuration".to_string(),
            fields,
        }],
    }
}

/// Map a single JSON-Schema property spec to a [`FieldType`].
fn field_type_from_spec(spec: &serde_json::Value) -> FieldType {
    // A string `enum` renders as a dropdown of its values.
    if let Some(values) = spec.get("enum").and_then(|e| e.as_array()) {
        let options: Vec<SelectOption> = values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|s| SelectOption {
                value: s.to_string(),
                label: s.to_string(),
            })
            .collect();
        if !options.is_empty() {
            return FieldType::Select { options };
        }
    }
    match spec.get("type").and_then(serde_json::Value::as_str) {
        Some("boolean") => FieldType::Boolean,
        Some("number") | Some("integer") => FieldType::Number {
            min: spec.get("minimum").and_then(serde_json::Value::as_f64),
            max: spec.get("maximum").and_then(serde_json::Value::as_f64),
        },
        // A secret (#4289): `format: "password"`, or the standard JSON-Schema
        // `writeOnly: true`. Either one routes the value to the credential store.
        Some("string") if is_secret_spec(spec) => FieldType::Password,
        // `string` and anything unrecognised become a plain text field.
        _ => FieldType::Text,
    }
}

/// Whether a string property spec declares a secret value.
fn is_secret_spec(spec: &serde_json::Value) -> bool {
    spec.get("format").and_then(serde_json::Value::as_str) == Some("password")
        || spec.get("writeOnly").and_then(serde_json::Value::as_bool) == Some(true)
}

/// Turn a property key (`echoPrefix`, `default_namespace`) into a human label
/// (`Echo Prefix`, `Default Namespace`) for when the schema declares no `title`.
fn humanize_key(key: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;
    for ch in key.chars() {
        if ch == '_' || ch == '-' || ch == ' ' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            prev_lower = false;
            continue;
        }
        // A lower→upper boundary starts a new camelCase word.
        if ch.is_ascii_uppercase() && prev_lower && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(ch);
        prev_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
        .iter()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The error a cancelled connect ends with (the same text as an SSH cancel).
fn cancelled() -> SessionError {
    SessionError::SpawnFailed("Connection cancelled".to_string())
}

/// Everything a plugin connect needs, owned, so it can run on the blocking
/// pool (#4323).
struct CreateRequest {
    handle: Arc<SandboxedPluginHandle>,
    config_json: String,
    settings_json: String,
    output_tx: Arc<Mutex<Option<OutputSender>>>,
    grant: BridgeGrant,
    cancel: Option<CancellationToken>,
}

impl CreateRequest {
    fn is_cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    }

    /// Acquire the runner and create the session in it. Blocking.
    fn run(self) -> Result<SandboxedSession, SessionError> {
        // The runner holds the session's services and bridge; output arrives
        // on the runner's reader thread, straight into `output_tx`.
        let plugin = self.handle.acquire().map_err(map_plugin_error)?;
        // A cancel during the (re)spawn: create nothing.
        if self.is_cancelled() {
            return Err(cancelled());
        }
        let session = SandboxedSession::create(
            plugin,
            &self.config_json,
            &self.settings_json,
            &self.handle.data_dir(),
            Arc::clone(&self.output_tx),
            self.grant.clone(),
        )
        .map_err(map_plugin_error)?;
        if self.is_cancelled() {
            // Cancelled while the plugin was connecting: nobody awaits this
            // session any more, so close it in the runner now.
            drop(session);
            return Err(cancelled());
        }
        Ok(session)
    }
}

impl Drop for PluginConnectionType {
    /// Close a still-live session without blocking the dropping thread (#4499).
    ///
    /// Closing waits (bounded by the 2 s request deadline) for the runner's
    /// `Close` reply. A connection dropped on a Tokio worker without an awaited
    /// [`disconnect`](ConnectionType::disconnect), for example by a teardown
    /// path that only removes the session entry, would hold that worker for the
    /// whole wait. When a runtime is current the session is handed to the
    /// blocking pool instead, together with a reference to the runner, so the
    /// ADR-19 order is kept there: the session retires before that runner
    /// reference is released. Without a runtime (a plain thread), it closes
    /// inline as before.
    fn drop(&mut self) {
        let Some(session) = self.backend.take() else {
            return;
        };
        // Stop delivering output to the old subscriber, as `disconnect` does.
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let handle = Arc::clone(&self.handle);
                // Not awaited: the close finishes in the background. If the
                // runtime is already shutting down the task never runs, and the
                // closure (with the session) is dropped right here instead.
                drop(runtime.spawn_blocking(move || {
                    drop(session);
                    drop(handle);
                }));
            }
            Err(_) => drop(session),
        }
    }
}

/// Map a plugin-side error to the session-error the terminal layer understands.
fn map_plugin_error(err: PluginError) -> SessionError {
    match err {
        PluginError::ChannelClosed | PluginError::NotAlive => {
            SessionError::NotRunning(err.to_string())
        }
        PluginError::InvalidConfig(_) => SessionError::InvalidConfig(err.to_string()),
        other => SessionError::SpawnFailed(other.to_string()),
    }
}

#[async_trait::async_trait]
impl ConnectionType for PluginConnectionType {
    fn type_id(&self) -> &str {
        &self.connection_type
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn settings_schema(&self) -> SettingsSchema {
        // Derived from the plugin's manifest `configSchema` at load time; the raw
        // settings JSON is still forwarded to the plugin verbatim at connect.
        self.settings_schema.clone()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: true,
            persistent: false,
            terminal: true,
            // Plugin connections have no built-in port-forwarding mechanism.
            tunneling: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        self.connect_cancellable(settings, None).await
    }

    /// Connect off the async workers, abortable via `cancel` (#4323).
    ///
    /// Acquiring the runner (which may respawn it: up to the Hello deadline)
    /// and waiting for the plugin's `create_backend` (up to the 30 s create
    /// deadline) are blocking, so they run on the blocking pool and the
    /// worker only awaits the join. Cancelling the token returns at once.
    ///
    /// The runner serves plugin calls on one thread, so a `create_backend`
    /// already in progress cannot be interrupted. The abandoned wait stays on
    /// the blocking pool and keeps the call counted as in flight, so the
    /// create deadline and the hang verdict (ADR-19, #4184) are unchanged and
    /// a user's Cancel is never mistaken for a hang. When the plugin answers,
    /// the session it created is closed in the runner, so nothing is leaked.
    async fn connect_cancellable(
        &mut self,
        settings: serde_json::Value,
        cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        if self.backend.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(cancelled());
        }

        let config_json = serde_json::to_string(&settings)
            .map_err(|e| SessionError::InvalidConfig(format!("settings not serializable: {e}")))?;

        let request = CreateRequest {
            handle: Arc::clone(&self.handle),
            config_json,
            settings_json: self.plugin_settings_json.clone(),
            output_tx: Arc::clone(&self.output_tx),
            // The session's bridge calls are answered by the host under this
            // session's permissions and connection policy (#4183).
            grant: BridgeGrant::new(self.permissions.clone(), self.connection_policy),
            cancel: cancel.clone(),
        };
        let mut create = tokio::task::spawn_blocking(move || request.run());

        let joined = match cancel {
            Some(token) => tokio::select! {
                biased;
                joined = &mut create => joined,
                () = token.cancelled() => {
                    // The blocking side sees the same token and closes the
                    // session once the runner answers; it is not awaited.
                    return Err(cancelled());
                }
            },
            None => create.await,
        };
        let backend = joined.map_err(|e| {
            SessionError::SpawnFailed(format!("the plugin connect task failed: {e}"))
        })??;
        self.backend = Some(backend);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(mut backend) = self.backend.take() {
            // Best-effort graceful close (bounded by the 2 s request deadline),
            // off the async workers (#4323). The session is retired in the
            // runner when it drops at the end of the closure regardless.
            let _ = tokio::task::spawn_blocking(move || {
                let _ = backend.close();
            })
            .await;
        }
        // Stop delivering output to the old subscriber.
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.backend
            .as_ref()
            .is_some_and(SandboxedSession::is_alive)
    }

    fn plugin_exit_cause(&self) -> Option<super::sandbox::RunnerExitCause> {
        self.backend.as_ref()?.exit_cause()
    }

    fn plugin_runner_alive(&self) -> Option<bool> {
        Some(self.backend.as_ref()?.runner_alive())
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        backend.write_input(data).map_err(map_plugin_error)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        backend.resize(cols, rows).map_err(map_plugin_error)
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_key_splits_camel_and_snake() {
        assert_eq!(humanize_key("echoPrefix"), "Echo Prefix");
        assert_eq!(humanize_key("default_namespace"), "Default Namespace");
        assert_eq!(humanize_key("pod-name"), "Pod Name");
        assert_eq!(humanize_key("host"), "Host");
        assert_eq!(humanize_key("apiVersion2"), "Api Version2");
    }

    #[test]
    fn empty_or_shapeless_schema_yields_no_groups() {
        // No `properties` at all.
        assert!(
            config_schema_to_settings_schema(&serde_json::json!({ "type": "object" }))
                .groups
                .is_empty()
        );
        // `properties` present but empty.
        assert!(config_schema_to_settings_schema(
            &serde_json::json!({ "type": "object", "properties": {} })
        )
        .groups
        .is_empty());
        // Not an object at all.
        assert!(
            config_schema_to_settings_schema(&serde_json::json!("nonsense"))
                .groups
                .is_empty()
        );
    }

    #[test]
    fn maps_property_types_to_field_types() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "host": { "type": "string", "title": "Host", "description": "Server host" },
                "port": { "type": "integer", "minimum": 1, "maximum": 65535, "default": 22 },
                "secure": { "type": "boolean", "default": true },
                "secret": { "type": "string", "format": "password" },
                "mode": { "type": "string", "enum": ["fast", "safe"] }
            },
            "required": ["host", "port"]
        });
        let out = config_schema_to_settings_schema(&schema);
        assert_eq!(out.groups.len(), 1);
        let group = &out.groups[0];
        assert_eq!(group.key, "config");
        // serde_json orders object keys alphabetically: host, mode, port, secret, secure.
        let by_key = |k: &str| group.fields.iter().find(|f| f.key == k).unwrap();

        let host = by_key("host");
        assert_eq!(host.label, "Host");
        assert_eq!(host.description.as_deref(), Some("Server host"));
        assert!(host.required);
        assert!(matches!(host.field_type, FieldType::Text));

        let port = by_key("port");
        assert!(port.required);
        assert_eq!(port.default, Some(serde_json::json!(22)));
        match &port.field_type {
            FieldType::Number { min, max } => {
                assert_eq!(*min, Some(1.0));
                assert_eq!(*max, Some(65535.0));
            }
            other => panic!("expected Number, got {other:?}"),
        }

        assert!(matches!(by_key("secure").field_type, FieldType::Boolean));
        assert!(!by_key("secure").required);
        assert!(matches!(by_key("secret").field_type, FieldType::Password));

        match &by_key("mode").field_type {
            FieldType::Select { options } => {
                let vals: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                assert_eq!(vals, vec!["fast", "safe"]);
            }
            other => panic!("expected Select, got {other:?}"),
        }
    }

    #[test]
    fn plugin_declared_secrets_are_classified_as_secrets() {
        // A plugin declares a secret with `format: "password"` or the standard
        // JSON-Schema `writeOnly: true`, under any key (#4289).
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "apiToken": { "type": "string", "writeOnly": true },
                "pin": { "type": "string", "format": "password" },
                "host": { "type": "string" }
            }
        });
        let out = config_schema_to_settings_schema(&schema);
        assert_eq!(
            crate::connection::secrets::schema_secret_keys(&out),
            vec!["apiToken".to_string(), "pin".to_string()]
        );
    }

    #[test]
    fn label_falls_back_to_humanized_key_without_title() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "echoPrefix": { "type": "string" } }
        });
        let out = config_schema_to_settings_schema(&schema);
        assert_eq!(out.groups[0].fields[0].label, "Echo Prefix");
    }
}
