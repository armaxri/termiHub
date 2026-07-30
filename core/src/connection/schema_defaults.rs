//! Default-value resolution and visibility evaluation for settings schemas.
//!
//! Rust twin of the frontend's `src/utils/schemaDefaults.ts`. These are the
//! pure helpers used by the generic form renderer and the connection editor to
//! derive defaults, evaluate visibility conditions, and detect password-prompt
//! requirements.
//!
//! During the stateless-UI migration (#2139, Phase 0) the TypeScript version
//! stays authoritative; this port runs behind it and is proven equivalent via
//! golden-vector fixtures (`core/tests/fixtures/golden/schema_defaults/`) that
//! are extracted from the authoritative TS suite (`schemaDefaults.test.ts`), so
//! any drift between the two implementations fails a test. The convention was
//! established by the panel-tree port (#2143).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::schema::{FieldType, SettingsField, SettingsGroup, SettingsSchema};

/// Settings values keyed by field key. Mirrors the TS `Record<string, unknown>`.
type Settings = Map<String, Value>;

/// Build a default settings object from a schema.
///
/// Iterates all fields in all groups and collects `default` values into a flat
/// map. Fields without a default are omitted (the form renderer treats them as
/// empty/unset), except `objectList` and `keyValueList` fields, which default
/// to an empty array when no explicit default is set.
pub fn build_defaults(schema: &SettingsSchema) -> Settings {
    let mut result = Settings::new();
    for group in &schema.groups {
        collect_field_defaults(&group.fields, &mut result);
    }
    result
}

fn collect_field_defaults(fields: &[SettingsField], out: &mut Settings) {
    for field in fields {
        if let Some(default) = &field.default {
            out.insert(field.key.clone(), default.clone());
        }
        // For objectList / keyValueList fields, provide an empty array default
        // when none is set.
        let list_like = matches!(
            field.field_type,
            FieldType::ObjectList { .. } | FieldType::KeyValueList
        );
        if list_like && !out.contains_key(&field.key) {
            out.insert(field.key.clone(), Value::Array(Vec::new()));
        }
    }
}

/// Evaluate whether a field should be visible given the current settings values.
///
/// Returns `true` if the field has no `visibleWhen` condition, or if the
/// condition is satisfied.
pub fn is_field_visible(field: &SettingsField, settings: &Settings) -> bool {
    match &field.visible_when {
        None => true,
        Some(condition) => {
            // A missing referenced field is `undefined` in the TS original, which
            // never equals a concrete `equals` value, so the field stays hidden.
            // Present values compare by JSON value equality (order-independent for
            // scalars, which is all conditions carry in practice).
            settings
                .get(&condition.field)
                .is_some_and(|actual| *actual == condition.equals)
        }
    }
}

/// Information about a password field that should be prompted at connect time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordPromptInfo {
    /// The settings key containing the host/identifier for the prompt dialog.
    pub host_key: String,
    /// The settings key containing the username for the prompt dialog.
    pub username_key: String,
    /// The settings key where the password value lives.
    pub password_key: String,
}

/// Check whether a connection needs a password prompt at connect time.
///
/// Scans the schema for a visible [`FieldType::Password`] field whose current
/// value is empty/unset. Returns prompt info if found, or `None` if no password
/// is needed.
pub fn find_password_prompt_info(
    schema: &SettingsSchema,
    settings: &Settings,
) -> Option<PasswordPromptInfo> {
    for group in &schema.groups {
        for field in &group.fields {
            if !matches!(field.field_type, FieldType::Password) {
                continue;
            }
            if !is_field_visible(field, settings) {
                continue;
            }

            // If the password already has a non-empty string value, no prompt.
            if let Some(Value::String(value)) = settings.get(&field.key) {
                if !value.is_empty() {
                    continue;
                }
            }

            return Some(PasswordPromptInfo {
                host_key: find_field_key(schema, "host").unwrap_or_else(|| "host".to_string()),
                username_key: find_field_key(schema, "username")
                    .unwrap_or_else(|| "username".to_string()),
                password_key: field.key.clone(),
            });
        }
    }
    None
}

/// Check whether an SSH **key-auth** connection needs a passphrase prompt at
/// connect time.
///
/// [`find_password_prompt_info`] only matches a *visible* password field, but
/// the password field is hidden for key auth, so it never prompts for a key
/// passphrase. This sibling check covers key auth: it returns prompt info when
/// `authMethod == "key"` and the key is actually encrypted (`key_encrypted`),
/// regardless of any `savePassword` flag (#885). The resolved passphrase is
/// passed to the backend via the same `password` config field.
pub fn find_key_passphrase_prompt_info(
    schema: &SettingsSchema,
    settings: &Settings,
    key_encrypted: bool,
) -> Option<PasswordPromptInfo> {
    if settings.get("authMethod") != Some(&Value::String("key".to_string())) {
        return None;
    }
    if !key_encrypted {
        return None;
    }

    Some(PasswordPromptInfo {
        host_key: find_field_key(schema, "host").unwrap_or_else(|| "host".to_string()),
        username_key: find_field_key(schema, "username").unwrap_or_else(|| "username".to_string()),
        password_key: find_field_key(schema, "password").unwrap_or_else(|| "password".to_string()),
    })
}

/// Find a field key in the schema by key name.
fn find_field_key(schema: &SettingsSchema, key: &str) -> Option<String> {
    for group in &schema.groups {
        for field in &group.fields {
            if field.key == key {
                return Some(field.key.clone());
            }
        }
    }
    None
}

/// Filter out credential-related fields (`password`, `savePassword`) from a
/// schema when no credential store is configured.
///
/// When `credential_mode` is `"none"`, passwords are always prompted at connect
/// time — pre-filling or saving them in the editor is meaningless — so those
/// fields are removed from the rendered schema. Returns a clone with those
/// fields removed when the mode is `"none"`; the original is never mutated. All
/// other modes are returned unchanged.
pub fn filter_credential_fields(
    schema: &SettingsSchema,
    credential_mode: Option<&str>,
) -> SettingsSchema {
    if credential_mode != Some("none") {
        return schema.clone();
    }
    SettingsSchema {
        groups: schema
            .groups
            .iter()
            .map(|group| SettingsGroup {
                key: group.key.clone(),
                label: group.label.clone(),
                fields: group
                    .fields
                    .iter()
                    .filter(|f| f.key != "password" && f.key != "savePassword")
                    .cloned()
                    .collect(),
            })
            .collect(),
    }
}

/// Filter the `runtime` select options in a Docker connection schema based on
/// which container runtimes are actually available on the system.
///
/// Rules:
/// - `"auto"` is kept only when both Docker and Podman are available.
/// - `"docker"` is kept only when Docker is available.
/// - `"podman"` is kept only when Podman is available.
/// - If neither is available, all options are kept (fallback — the backend
///   produces a proper error when the user tries to connect).
///
/// Returns a clone with filtered options; the original is never mutated.
pub fn filter_runtime_options(
    schema: &SettingsSchema,
    docker_available: bool,
    podman_available: bool,
) -> SettingsSchema {
    // Fallback: if neither is available, don't filter anything.
    if !docker_available && !podman_available {
        return schema.clone();
    }

    SettingsSchema {
        groups: schema
            .groups
            .iter()
            .map(|group| SettingsGroup {
                key: group.key.clone(),
                label: group.label.clone(),
                fields: group
                    .fields
                    .iter()
                    .map(|field| filter_runtime_field(field, docker_available, podman_available))
                    .collect(),
            })
            .collect(),
    }
}

fn filter_runtime_field(
    field: &SettingsField,
    docker_available: bool,
    podman_available: bool,
) -> SettingsField {
    let FieldType::Select { options } = &field.field_type else {
        return field.clone();
    };
    if field.key != "runtime" {
        return field.clone();
    }

    let filtered = options
        .iter()
        .filter(|opt| match opt.value.as_str() {
            "auto" => docker_available && podman_available,
            "docker" => docker_available,
            "podman" => podman_available,
            _ => true,
        })
        .cloned()
        .collect();

    let mut cloned = field.clone();
    cloned.field_type = FieldType::Select { options: filtered };
    cloned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::schema::SelectOption;
    use serde_json::json;

    fn text_field(key: &str) -> SettingsField {
        SettingsField {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            help_text: None,
            field_type: FieldType::Text,
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        }
    }

    fn password_field(key: &str) -> SettingsField {
        SettingsField {
            field_type: FieldType::Password,
            ..text_field(key)
        }
    }

    fn settings(pairs: &[(&str, Value)]) -> Settings {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn ssh_like_schema() -> SettingsSchema {
        SettingsSchema {
            groups: vec![
                SettingsGroup {
                    key: "connection".to_string(),
                    label: "Connection".to_string(),
                    fields: vec![
                        SettingsField {
                            required: true,
                            placeholder: Some("example.com".to_string()),
                            ..text_field("host")
                        },
                        SettingsField {
                            label: "Port".to_string(),
                            field_type: FieldType::Port,
                            required: true,
                            default: Some(json!(22)),
                            ..text_field("port")
                        },
                        SettingsField {
                            required: true,
                            ..text_field("username")
                        },
                    ],
                },
                SettingsGroup {
                    key: "authentication".to_string(),
                    label: "Authentication".to_string(),
                    fields: vec![
                        SettingsField {
                            label: "Auth Method".to_string(),
                            field_type: FieldType::Select {
                                options: vec![
                                    SelectOption {
                                        value: "key".to_string(),
                                        label: "SSH Key".to_string(),
                                    },
                                    SelectOption {
                                        value: "password".to_string(),
                                        label: "Password".to_string(),
                                    },
                                    SelectOption {
                                        value: "agent".to_string(),
                                        label: "SSH Agent".to_string(),
                                    },
                                ],
                            },
                            required: true,
                            default: Some(json!("key")),
                            ..text_field("authMethod")
                        },
                        SettingsField {
                            label: "Key Path".to_string(),
                            field_type: FieldType::FilePath {
                                kind: crate::connection::schema::FilePathKind::File,
                            },
                            visible_when: Some(crate::connection::schema::Condition {
                                field: "authMethod".to_string(),
                                equals: json!("key"),
                            }),
                            ..text_field("keyPath")
                        },
                        SettingsField {
                            visible_when: Some(crate::connection::schema::Condition {
                                field: "authMethod".to_string(),
                                equals: json!("password"),
                            }),
                            ..password_field("password")
                        },
                    ],
                },
            ],
        }
    }

    // --- build_defaults ---------------------------------------------------

    #[test]
    fn build_defaults_extracts_default_values() {
        let defaults = build_defaults(&ssh_like_schema());
        assert_eq!(
            Value::Object(defaults),
            json!({ "port": 22, "authMethod": "key" })
        );
    }

    #[test]
    fn build_defaults_provides_empty_arrays_for_list_fields() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "container".to_string(),
                label: "Container".to_string(),
                fields: vec![
                    SettingsField {
                        required: true,
                        default: Some(json!("ubuntu:22.04")),
                        ..text_field("image")
                    },
                    SettingsField {
                        field_type: FieldType::KeyValueList,
                        ..text_field("envVars")
                    },
                    SettingsField {
                        field_type: FieldType::ObjectList {
                            fields: vec![text_field("hostPath")],
                        },
                        ..text_field("volumes")
                    },
                    SettingsField {
                        field_type: FieldType::Boolean,
                        default: Some(json!(true)),
                        ..text_field("removeOnExit")
                    },
                ],
            }],
        };
        assert_eq!(
            Value::Object(build_defaults(&schema)),
            json!({
                "image": "ubuntu:22.04",
                "envVars": [],
                "volumes": [],
                "removeOnExit": true
            })
        );
    }

    #[test]
    fn build_defaults_empty_when_no_defaults() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "basic".to_string(),
                label: "Basic".to_string(),
                fields: vec![text_field("host"), text_field("port")],
            }],
        };
        assert!(build_defaults(&schema).is_empty());
    }

    #[test]
    fn build_defaults_handles_empty_schema() {
        assert!(build_defaults(&SettingsSchema { groups: vec![] }).is_empty());
    }

    // --- is_field_visible -------------------------------------------------

    #[test]
    fn visible_without_condition() {
        assert!(is_field_visible(&text_field("host"), &settings(&[])));
    }

    #[test]
    fn visible_when_condition_met() {
        let field = SettingsField {
            visible_when: Some(crate::connection::schema::Condition {
                field: "authMethod".to_string(),
                equals: json!("password"),
            }),
            ..password_field("password")
        };
        assert!(is_field_visible(
            &field,
            &settings(&[("authMethod", json!("password"))])
        ));
        assert!(!is_field_visible(
            &field,
            &settings(&[("authMethod", json!("key"))])
        ));
    }

    #[test]
    fn visible_with_boolean_condition() {
        let field = SettingsField {
            visible_when: Some(crate::connection::schema::Condition {
                field: "advanced".to_string(),
                equals: json!(true),
            }),
            ..text_field("extraOption")
        };
        assert!(is_field_visible(
            &field,
            &settings(&[("advanced", json!(true))])
        ));
        assert!(!is_field_visible(
            &field,
            &settings(&[("advanced", json!(false))])
        ));
    }

    #[test]
    fn visible_with_numeric_condition() {
        let field = SettingsField {
            visible_when: Some(crate::connection::schema::Condition {
                field: "mode".to_string(),
                equals: json!(2),
            }),
            ..text_field("highPort")
        };
        assert!(is_field_visible(&field, &settings(&[("mode", json!(2))])));
        assert!(!is_field_visible(&field, &settings(&[("mode", json!(1))])));
    }

    #[test]
    fn hidden_when_referenced_field_missing() {
        let field = SettingsField {
            visible_when: Some(crate::connection::schema::Condition {
                field: "mode".to_string(),
                equals: json!("advanced"),
            }),
            ..text_field("extra")
        };
        assert!(!is_field_visible(&field, &settings(&[])));
    }

    // --- find_password_prompt_info ---------------------------------------

    #[test]
    fn password_prompt_when_visible_and_empty() {
        let result = find_password_prompt_info(
            &ssh_like_schema(),
            &settings(&[
                ("authMethod", json!("password")),
                ("host", json!("example.com")),
                ("username", json!("admin")),
            ]),
        );
        assert_eq!(
            result,
            Some(PasswordPromptInfo {
                host_key: "host".to_string(),
                username_key: "username".to_string(),
                password_key: "password".to_string(),
            })
        );
    }

    #[test]
    fn no_password_prompt_when_field_hidden() {
        assert_eq!(
            find_password_prompt_info(
                &ssh_like_schema(),
                &settings(&[("authMethod", json!("key"))])
            ),
            None
        );
    }

    #[test]
    fn no_password_prompt_when_already_set() {
        assert_eq!(
            find_password_prompt_info(
                &ssh_like_schema(),
                &settings(&[
                    ("authMethod", json!("password")),
                    ("password", json!("secret"))
                ])
            ),
            None
        );
    }

    #[test]
    fn no_password_prompt_without_password_fields() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "conn".to_string(),
                label: "Connection".to_string(),
                fields: vec![text_field("host")],
            }],
        };
        assert_eq!(find_password_prompt_info(&schema, &settings(&[])), None);
    }

    #[test]
    fn password_prompt_for_unconditional_field() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "conn".to_string(),
                label: "Connection".to_string(),
                fields: vec![
                    text_field("host"),
                    text_field("username"),
                    password_field("password"),
                ],
            }],
        };
        assert_eq!(
            find_password_prompt_info(
                &schema,
                &settings(&[("host", json!("h")), ("username", json!("u"))])
            ),
            Some(PasswordPromptInfo {
                host_key: "host".to_string(),
                username_key: "username".to_string(),
                password_key: "password".to_string(),
            })
        );
    }

    // --- find_key_passphrase_prompt_info ---------------------------------

    #[test]
    fn passphrase_prompt_for_encrypted_key() {
        let result = find_key_passphrase_prompt_info(
            &ssh_like_schema(),
            &settings(&[
                ("authMethod", json!("key")),
                ("host", json!("example.com")),
                ("username", json!("admin")),
            ]),
            true,
        );
        assert_eq!(
            result,
            Some(PasswordPromptInfo {
                host_key: "host".to_string(),
                username_key: "username".to_string(),
                password_key: "password".to_string(),
            })
        );
    }

    #[test]
    fn passphrase_prompt_ignores_save_password_flag() {
        assert!(find_key_passphrase_prompt_info(
            &ssh_like_schema(),
            &settings(&[
                ("authMethod", json!("key")),
                ("savePassword", json!(false)),
                ("host", json!("h")),
                ("username", json!("u")),
            ]),
            true,
        )
        .is_some());
    }

    #[test]
    fn no_passphrase_prompt_for_unencrypted_key() {
        assert_eq!(
            find_key_passphrase_prompt_info(
                &ssh_like_schema(),
                &settings(&[
                    ("authMethod", json!("key")),
                    ("savePassword", json!(true)),
                    ("host", json!("h")),
                    ("username", json!("u")),
                ]),
                false,
            ),
            None
        );
    }

    #[test]
    fn no_passphrase_prompt_for_password_auth() {
        assert_eq!(
            find_key_passphrase_prompt_info(
                &ssh_like_schema(),
                &settings(&[("authMethod", json!("password"))]),
                true,
            ),
            None
        );
    }

    #[test]
    fn no_passphrase_prompt_for_agent_auth() {
        assert_eq!(
            find_key_passphrase_prompt_info(
                &ssh_like_schema(),
                &settings(&[("authMethod", json!("agent"))]),
                true,
            ),
            None
        );
    }

    #[test]
    fn passphrase_prompt_falls_back_to_default_keys() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "conn".to_string(),
                label: "Connection".to_string(),
                fields: vec![text_field("foo")],
            }],
        };
        assert_eq!(
            find_key_passphrase_prompt_info(
                &schema,
                &settings(&[("authMethod", json!("key"))]),
                true,
            ),
            Some(PasswordPromptInfo {
                host_key: "host".to_string(),
                username_key: "username".to_string(),
                password_key: "password".to_string(),
            })
        );
    }

    // --- filter_credential_fields ----------------------------------------

    fn credential_schema() -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "auth".to_string(),
                label: "Authentication".to_string(),
                fields: vec![
                    SettingsField {
                        label: "Auth Method".to_string(),
                        field_type: FieldType::Select {
                            options: vec![SelectOption {
                                value: "password".to_string(),
                                label: "Password".to_string(),
                            }],
                        },
                        required: true,
                        ..text_field("authMethod")
                    },
                    SettingsField {
                        visible_when: Some(crate::connection::schema::Condition {
                            field: "authMethod".to_string(),
                            equals: json!("password"),
                        }),
                        ..password_field("password")
                    },
                    SettingsField {
                        label: "Save password".to_string(),
                        field_type: FieldType::Boolean,
                        default: Some(json!(false)),
                        ..text_field("savePassword")
                    },
                    text_field("keyPath"),
                ],
            }],
        }
    }

    fn field_keys(schema: &SettingsSchema) -> Vec<String> {
        schema.groups[0]
            .fields
            .iter()
            .map(|f| f.key.clone())
            .collect()
    }

    #[test]
    fn credential_fields_removed_when_mode_none() {
        let result = filter_credential_fields(&credential_schema(), Some("none"));
        let keys = field_keys(&result);
        assert!(!keys.contains(&"password".to_string()));
        assert!(!keys.contains(&"savePassword".to_string()));
        assert!(keys.contains(&"authMethod".to_string()));
        assert!(keys.contains(&"keyPath".to_string()));
    }

    #[test]
    fn credential_fields_kept_for_master_password() {
        let keys = field_keys(&filter_credential_fields(
            &credential_schema(),
            Some("master_password"),
        ));
        assert!(keys.contains(&"password".to_string()));
        assert!(keys.contains(&"savePassword".to_string()));
    }

    #[test]
    fn credential_fields_kept_when_mode_absent() {
        let keys = field_keys(&filter_credential_fields(&credential_schema(), None));
        assert!(keys.contains(&"password".to_string()));
        assert!(keys.contains(&"savePassword".to_string()));
    }

    #[test]
    fn filter_credential_fields_does_not_mutate_original() {
        let schema = credential_schema();
        let before = serde_json::to_value(&schema).unwrap();
        let _ = filter_credential_fields(&schema, Some("none"));
        assert_eq!(serde_json::to_value(&schema).unwrap(), before);
    }

    // --- filter_runtime_options ------------------------------------------

    fn runtime_schema() -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "container".to_string(),
                label: "Container".to_string(),
                fields: vec![
                    SettingsField {
                        default: Some(json!("ubuntu:22.04")),
                        ..text_field("image")
                    },
                    SettingsField {
                        label: "Runtime".to_string(),
                        field_type: FieldType::Select {
                            options: vec![
                                SelectOption {
                                    value: "auto".to_string(),
                                    label: "Auto".to_string(),
                                },
                                SelectOption {
                                    value: "docker".to_string(),
                                    label: "Docker".to_string(),
                                },
                                SelectOption {
                                    value: "podman".to_string(),
                                    label: "Podman".to_string(),
                                },
                            ],
                        },
                        required: true,
                        default: Some(json!("auto")),
                        ..text_field("runtime")
                    },
                ],
            }],
        }
    }

    fn runtime_option_values(schema: &SettingsSchema) -> Vec<String> {
        let field = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "runtime")
            .expect("runtime field");
        match &field.field_type {
            FieldType::Select { options } => options.iter().map(|o| o.value.clone()).collect(),
            _ => panic!("expected select"),
        }
    }

    #[test]
    fn runtime_keeps_all_options_when_both_available() {
        let result = filter_runtime_options(&runtime_schema(), true, true);
        assert_eq!(
            runtime_option_values(&result),
            vec!["auto", "docker", "podman"]
        );
    }

    #[test]
    fn runtime_docker_only() {
        let result = filter_runtime_options(&runtime_schema(), true, false);
        assert_eq!(runtime_option_values(&result), vec!["docker"]);
    }

    #[test]
    fn runtime_podman_only() {
        let result = filter_runtime_options(&runtime_schema(), false, true);
        assert_eq!(runtime_option_values(&result), vec!["podman"]);
    }

    #[test]
    fn runtime_fallback_when_neither_available() {
        let result = filter_runtime_options(&runtime_schema(), false, false);
        assert_eq!(
            runtime_option_values(&result),
            vec!["auto", "docker", "podman"]
        );
    }

    #[test]
    fn filter_runtime_options_does_not_mutate_original() {
        let schema = runtime_schema();
        let before = serde_json::to_value(&schema).unwrap();
        let _ = filter_runtime_options(&schema, true, false);
        assert_eq!(serde_json::to_value(&schema).unwrap(), before);
    }

    #[test]
    fn filter_runtime_options_leaves_non_runtime_fields_unchanged() {
        let schema = runtime_schema();
        let result = filter_runtime_options(&schema, true, false);
        assert_eq!(result.groups[0].fields[0].key, "image");
        assert_eq!(
            serde_json::to_value(&result.groups[0].fields[0]).unwrap(),
            serde_json::to_value(&schema.groups[0].fields[0]).unwrap()
        );
    }
}

/// Property-based tests for the condition-evaluation and filter invariants.
#[cfg(test)]
mod prop_tests {
    use super::*;
    use crate::connection::schema::{Condition, SelectOption};
    use proptest::prelude::*;
    use serde_json::json;

    /// A scalar JSON value of the kind a `Condition.equals` / stored setting
    /// actually carries (string, integer, or boolean).
    fn scalar_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            any::<bool>().prop_map(Value::from),
            any::<i64>().prop_map(Value::from),
            "[a-z0-9]{0,6}".prop_map(Value::from),
        ]
    }

    fn text_field(key: &str) -> SettingsField {
        SettingsField {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            help_text: None,
            field_type: FieldType::Text,
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        }
    }

    proptest! {
        /// A field with no `visible_when` is visible for any settings.
        #[test]
        fn field_without_condition_is_always_visible(
            settings in prop::collection::hash_map("[a-z]{1,4}", scalar_value(), 0..4)
        ) {
            let field = text_field("x");
            let map: Settings = settings.into_iter().collect();
            prop_assert!(is_field_visible(&field, &map));
        }

        /// A conditional field is visible exactly when the referenced setting is
        /// present and equal to `equals` — the missing field stays hidden, and a
        /// present-but-different value stays hidden.
        #[test]
        fn conditional_visibility_matches_reference_semantics(
            ref_field in "[a-z]{1,4}",
            equals in scalar_value(),
            present in any::<bool>(),
            stored in scalar_value(),
        ) {
            let field = SettingsField {
                visible_when: Some(Condition {
                    field: ref_field.clone(),
                    equals: equals.clone(),
                }),
                ..text_field("target")
            };
            let mut settings = Settings::new();
            if present {
                settings.insert(ref_field.clone(), stored.clone());
            }
            let expected = present && stored == equals;
            prop_assert_eq!(is_field_visible(&field, &settings), expected);
        }

        /// `filter_credential_fields` with any mode other than `"none"` is the
        /// identity (returns a structurally identical schema).
        #[test]
        fn non_none_credential_mode_is_identity(mode in "[a-z_]{1,12}") {
            prop_assume!(mode != "none");
            let schema = SettingsSchema {
                groups: vec![SettingsGroup {
                    key: "auth".to_string(),
                    label: "Auth".to_string(),
                    fields: vec![
                        text_field("host"),
                        SettingsField { field_type: FieldType::Password, ..text_field("password") },
                        SettingsField { default: Some(json!(false)), field_type: FieldType::Boolean, ..text_field("savePassword") },
                    ],
                }],
            };
            let filtered = filter_credential_fields(&schema, Some(mode.as_str()));
            prop_assert_eq!(
                serde_json::to_value(&filtered).unwrap(),
                serde_json::to_value(&schema).unwrap()
            );
        }

        /// `filter_runtime_options` never invents an option and is idempotent:
        /// filtering the already-filtered schema with the same availability
        /// yields the same result, and the option set is always a subset of the
        /// original.
        #[test]
        fn runtime_filter_is_subset_and_idempotent(
            docker in any::<bool>(),
            podman in any::<bool>(),
        ) {
            let schema = SettingsSchema {
                groups: vec![SettingsGroup {
                    key: "container".to_string(),
                    label: "Container".to_string(),
                    fields: vec![SettingsField {
                        label: "Runtime".to_string(),
                        field_type: FieldType::Select {
                            options: vec![
                                SelectOption { value: "auto".to_string(), label: "Auto".to_string() },
                                SelectOption { value: "docker".to_string(), label: "Docker".to_string() },
                                SelectOption { value: "podman".to_string(), label: "Podman".to_string() },
                            ],
                        },
                        required: true,
                        ..text_field("runtime")
                    }],
                }],
            };

            let once = filter_runtime_options(&schema, docker, podman);
            let twice = filter_runtime_options(&once, docker, podman);
            prop_assert_eq!(
                serde_json::to_value(&once).unwrap(),
                serde_json::to_value(&twice).unwrap()
            );

            let option_count = |s: &SettingsSchema| -> usize {
                match &s.groups[0].fields[0].field_type {
                    FieldType::Select { options } => options.len(),
                    _ => unreachable!(),
                }
            };
            prop_assert!(option_count(&once) <= option_count(&schema));
        }
    }
}
