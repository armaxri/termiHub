//! Adapter that presents a loaded plugin backend as a
//! [`ConnectionType`](crate::connection::ConnectionType).
//!
//! The host loader ([`super::host`]) produces an
//! [`Arc<LoadedLibrary>`](super::host::LoadedLibrary) that can create backend
//! sessions over the stable plugin ABI. [`PluginConnectionType`] wraps one such
//! library so a plugin-provided terminal backend slots into the same
//! [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry) and
//! session machinery as the built-in backends (local shell, SSH, telnet, …).
//!
//! # Output bridging
//!
//! The plugin ABI delivers terminal output through a
//! [`PluginOutputSender`](termihub_plugin_api::PluginOutputSender), which the
//! host builds over a synchronous `std::sync::mpsc` channel. The
//! [`ConnectionType`](crate::connection::ConnectionType) contract instead exposes
//! an async `tokio::sync::mpsc` receiver via
//! [`subscribe_output`](crate::connection::ConnectionType::subscribe_output). A
//! small forwarding thread bridges the two — the same pattern the telnet and
//! serial backends use to move a blocking reader onto the async channel.
//!
//! # Scope
//!
//! This is the *load-and-register* adapter (#1995), now wired through to session
//! creation (#1999): the plugin's declared `configSchema` is translated into the
//! type's [`SettingsSchema`](crate::connection::SettingsSchema) (see
//! [`config_schema_to_settings_schema`]) so the existing `DynamicForm` renders the
//! config form with no bespoke UI, and the raw settings JSON is forwarded to the
//! plugin verbatim at connect time.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use termihub_plugin_api::{LoadedBackend, PluginError, PluginOutputSender};

use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SelectOption,
    SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use super::host::LoadedLibrary;

/// Channel capacity for output forwarded from the plugin to the terminal.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// A [`ConnectionType`] backed by a dynamically-loaded plugin library.
///
/// Holds an [`Arc<LoadedLibrary>`] so the plugin's code stays mapped for as long
/// as this session (and hence any [`LoadedBackend`] it created) is alive.
pub struct PluginConnectionType {
    library: Arc<LoadedLibrary>,
    connection_type: String,
    display_name: String,
    /// The form schema the frontend renders for this type, derived from the
    /// plugin's declared `configSchema` at load time.
    settings_schema: SettingsSchema,
    /// The active session backend, `None` until [`connect`](ConnectionType::connect).
    backend: Option<LoadedBackend>,
    /// Current output sink; swapped by
    /// [`subscribe_output`](ConnectionType::subscribe_output). The forwarding
    /// thread reads the latest value each iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

impl PluginConnectionType {
    /// Build a fresh, unconnected connection of the given plugin type.
    ///
    /// `settings_schema` is the form schema derived from the plugin's manifest
    /// `configSchema` (see [`config_schema_to_settings_schema`]); the host derives
    /// it once at load time and clones it into every instance the factory makes.
    #[must_use]
    pub fn new(
        library: Arc<LoadedLibrary>,
        connection_type: String,
        display_name: String,
        settings_schema: SettingsSchema,
    ) -> Self {
        Self {
            library,
            connection_type,
            display_name,
            settings_schema,
            backend: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
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
        Some("string")
            if spec.get("format").and_then(serde_json::Value::as_str) == Some("password") =>
        {
            FieldType::Password
        }
        // `string` and anything unrecognised become a plain text field.
        _ => FieldType::Text,
    }
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
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.backend.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        let config_json = serde_json::to_string(&settings)
            .map_err(|e| SessionError::InvalidConfig(format!("settings not serializable: {e}")))?;

        // Bridge the plugin's synchronous output channel onto the async terminal
        // channel. The plugin sends `Vec<u8>` on `std_tx`; the forwarding thread
        // relays each chunk to whichever `OutputSender` is currently subscribed.
        let (std_tx, std_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let output = PluginOutputSender::from_sender(std_tx);

        let backend = self
            .library
            .create_backend(&config_json, output)
            .map_err(map_plugin_error)?;

        let output_tx = Arc::clone(&self.output_tx);
        std::thread::spawn(move || {
            while let Ok(chunk) = std_rx.recv() {
                let guard = output_tx.lock().unwrap_or_else(|e| e.into_inner());
                // Deliver to the current subscriber if any; a dropped receiver or
                // no active subscription (output before the first
                // `subscribe_output`) simply drops the chunk, matching the other
                // backends. Keep draining so the plugin's sender never blocks.
                if let Some(sender) = guard.as_ref() {
                    let _ = sender.blocking_send(chunk);
                }
            }
        });

        self.backend = Some(backend);
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(backend) = self.backend.take() {
            // Best-effort graceful close; the backend drops (running its FFI
            // destructor) at the end of this scope regardless.
            let _ = backend.close();
        }
        // Dropping the sender lets the forwarding thread's `recv` end once the
        // plugin's own sender is gone.
        *self.output_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.backend.as_ref().is_some_and(LoadedBackend::is_alive)
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
    fn label_falls_back_to_humanized_key_without_title() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "echoPrefix": { "type": "string" } }
        });
        let out = config_schema_to_settings_schema(&schema);
        assert_eq!(out.groups[0].fields[0].label, "Echo Prefix");
    }
}
