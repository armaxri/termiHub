//! Settings schema types for dynamic UI form generation.
//!
//! These types allow connection backends to declare their configuration
//! fields declaratively. The frontend renders settings forms generically
//! from these schemas, requiring zero knowledge of connection internals.

use serde::{Deserialize, Serialize};

/// Top-level settings schema containing grouped fields.
///
/// The UI renders each group as a collapsible section in the
/// connection settings form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSchema {
    /// Ordered list of field groups.
    pub groups: Vec<SettingsGroup>,
}

/// A named group of related settings fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsGroup {
    /// Machine-readable key (e.g., "connection", "authentication").
    pub key: String,
    /// Human-readable label for the group header.
    pub label: String,
    /// Fields in this group, rendered in order.
    pub fields: Vec<SettingsField>,
}

/// A single settings field with metadata for UI rendering and validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsField {
    /// Machine-readable key used as the JSON property name in settings values.
    pub key: String,
    /// Human-readable label displayed next to the input.
    pub label: String,
    /// Optional help text shown below the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The input type and any type-specific constraints.
    pub field_type: FieldType,
    /// Whether this field must have a value before connecting.
    pub required: bool,
    /// Default value used when the user hasn't set one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// Placeholder text shown in empty inputs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Whether `${env:VAR}` placeholders are expanded at connect time.
    #[serde(default)]
    pub supports_env_expansion: bool,
    /// Whether `~` is expanded to the home directory at connect time.
    #[serde(default)]
    pub supports_tilde_expansion: bool,
    /// Conditional visibility: this field is only shown when the
    /// referenced field has the specified value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_when: Option<Condition>,
}

/// Conditional visibility rule for a settings field.
///
/// The field is shown only when the field identified by [`field`](Condition::field)
/// equals [`equals`](Condition::equals).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    /// Key of the field to check.
    pub field: String,
    /// Value that the field must equal for this field to be visible.
    pub equals: serde_json::Value,
}

/// Type of a settings field, determining the UI widget and validation rules.
///
/// Serialized as a tagged enum: `{"type": "text"}`, `{"type": "number", "min": 0}`, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FieldType {
    /// Single-line text input.
    Text,
    /// Masked password input.
    Password,
    /// Numeric input with optional min/max bounds.
    Number {
        /// Minimum allowed value (inclusive).
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        /// Maximum allowed value (inclusive).
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    /// Boolean toggle / checkbox.
    Boolean,
    /// Dropdown select with predefined options.
    Select {
        /// Available choices.
        options: Vec<SelectOption>,
    },
    /// Port number input (constrained to 1..=65535).
    Port,
    /// File or directory path picker.
    FilePath {
        /// Whether to accept files, directories, or both.
        kind: FilePathKind,
    },
    /// List of key-value string pairs (e.g., environment variables).
    KeyValueList,
    /// List of objects with sub-fields (e.g., volume mounts).
    ObjectList {
        /// Fields for each object in the list.
        fields: Vec<SettingsField>,
    },
}

/// An option in a [`FieldType::Select`] dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    /// Machine-readable value stored in settings JSON.
    pub value: String,
    /// Human-readable label shown in the dropdown.
    pub label: String,
}

/// Kind of path accepted by a [`FieldType::FilePath`] field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilePathKind {
    /// Only files can be selected.
    File,
    /// Only directories can be selected.
    Directory,
    /// Either files or directories can be selected.
    Any,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_schema() -> SettingsSchema {
        SettingsSchema {
            groups: vec![
                SettingsGroup {
                    key: "connection".to_string(),
                    label: "Connection".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "host".to_string(),
                            label: "Hostname".to_string(),
                            description: Some("SSH server address".to_string()),
                            field_type: FieldType::Text,
                            required: true,
                            default: None,
                            placeholder: Some("example.com".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "port".to_string(),
                            label: "Port".to_string(),
                            description: None,
                            field_type: FieldType::Port,
                            required: true,
                            default: Some(serde_json::json!(22)),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
                SettingsGroup {
                    key: "authentication".to_string(),
                    label: "Authentication".to_string(),
                    fields: vec![
                        SettingsField {
                            key: "authMethod".to_string(),
                            label: "Auth Method".to_string(),
                            description: None,
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
                                ],
                            },
                            required: true,
                            default: Some(serde_json::json!("key")),
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "keyPath".to_string(),
                            label: "Key Path".to_string(),
                            description: None,
                            field_type: FieldType::FilePath {
                                kind: FilePathKind::File,
                            },
                            required: false,
                            default: None,
                            placeholder: Some("~/.ssh/id_rsa".to_string()),
                            supports_env_expansion: true,
                            supports_tilde_expansion: true,
                            visible_when: Some(Condition {
                                field: "authMethod".to_string(),
                                equals: serde_json::json!("key"),
                            }),
                        },
                        SettingsField {
                            key: "password".to_string(),
                            label: "Password".to_string(),
                            description: None,
                            field_type: FieldType::Password,
                            required: false,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: true,
                            supports_tilde_expansion: false,
                            visible_when: Some(Condition {
                                field: "authMethod".to_string(),
                                equals: serde_json::json!("password"),
                            }),
                        },
                    ],
                },
            ],
        }
    }

    #[test]
    fn schema_serde_roundtrip() {
        let schema = sample_schema();
        let json = serde_json::to_string(&schema).unwrap();
        let deserialized: SettingsSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.groups.len(), 2);
        assert_eq!(deserialized.groups[0].fields.len(), 2);
        assert_eq!(deserialized.groups[1].fields.len(), 3);
    }

    #[test]
    fn field_type_text_serialization() {
        let ft = FieldType::Text;
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "text"}));
    }

    #[test]
    fn field_type_number_serialization() {
        let ft = FieldType::Number {
            min: Some(0.0),
            max: Some(100.0),
        };
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"type": "number", "min": 0.0, "max": 100.0})
        );
    }

    #[test]
    fn field_type_number_without_bounds() {
        let ft = FieldType::Number {
            min: None,
            max: None,
        };
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "number"}));
    }

    #[test]
    fn field_type_select_serialization() {
        let ft = FieldType::Select {
            options: vec![SelectOption {
                value: "a".to_string(),
                label: "Option A".to_string(),
            }],
        };
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "select",
                "options": [{"value": "a", "label": "Option A"}]
            })
        );
    }

    #[test]
    fn field_type_port_serialization() {
        let ft = FieldType::Port;
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "port"}));
    }

    #[test]
    fn field_type_file_path_serialization() {
        let ft = FieldType::FilePath {
            kind: FilePathKind::Directory,
        };
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"type": "filePath", "kind": "directory"})
        );
    }

    #[test]
    fn field_type_key_value_list_serialization() {
        let ft = FieldType::KeyValueList;
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "keyValueList"}));
    }

    #[test]
    fn field_type_object_list_serialization() {
        let ft = FieldType::ObjectList {
            fields: vec![SettingsField {
                key: "name".to_string(),
                label: "Name".to_string(),
                description: None,
                field_type: FieldType::Text,
                required: true,
                default: None,
                placeholder: None,
                supports_env_expansion: false,
                supports_tilde_expansion: false,
                visible_when: None,
            }],
        };
        let json = serde_json::to_value(&ft).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(obj["type"], "objectList");
        assert!(obj["fields"].is_array());
        assert_eq!(obj["fields"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn condition_serde_roundtrip() {
        let condition = Condition {
            field: "authMethod".to_string(),
            equals: serde_json::json!("key"),
        };
        let json = serde_json::to_string(&condition).unwrap();
        let deserialized: Condition = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.field, "authMethod");
        assert_eq!(deserialized.equals, serde_json::json!("key"));
    }

    #[test]
    fn file_path_kind_variants() {
        let kinds = [
            FilePathKind::File,
            FilePathKind::Directory,
            FilePathKind::Any,
        ];
        let expected = ["\"file\"", "\"directory\"", "\"any\""];
        for (kind, exp) in kinds.iter().zip(expected.iter()) {
            let json = serde_json::to_string(kind).unwrap();
            assert_eq!(json, *exp);
        }
    }

    #[test]
    fn settings_field_optional_fields_skipped() {
        let field = SettingsField {
            key: "host".to_string(),
            label: "Host".to_string(),
            description: None,
            field_type: FieldType::Text,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let json = serde_json::to_value(&field).unwrap();
        let obj = json.as_object().unwrap();
        assert!(!obj.contains_key("description"));
        assert!(!obj.contains_key("default"));
        assert!(!obj.contains_key("placeholder"));
        assert!(!obj.contains_key("visibleWhen"));
    }

    #[test]
    fn settings_field_camel_case_keys() {
        let field = SettingsField {
            key: "keyPath".to_string(),
            label: "Key Path".to_string(),
            description: Some("Path to key".to_string()),
            field_type: FieldType::Text,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: true,
            supports_tilde_expansion: true,
            visible_when: Some(Condition {
                field: "auth".to_string(),
                equals: serde_json::json!("key"),
            }),
        };
        let json = serde_json::to_value(&field).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("fieldType"));
        assert!(obj.contains_key("supportsEnvExpansion"));
        assert!(obj.contains_key("supportsTildeExpansion"));
        assert!(obj.contains_key("visibleWhen"));
    }

    #[test]
    fn field_type_boolean_serialization() {
        let ft = FieldType::Boolean;
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "boolean"}));
    }

    #[test]
    fn field_type_password_serialization() {
        let ft = FieldType::Password;
        let json = serde_json::to_value(&ft).unwrap();
        assert_eq!(json, serde_json::json!({"type": "password"}));
    }

    #[test]
    fn nested_object_list_roundtrip() {
        let schema = SettingsSchema {
            groups: vec![SettingsGroup {
                key: "docker".to_string(),
                label: "Docker".to_string(),
                fields: vec![SettingsField {
                    key: "volumes".to_string(),
                    label: "Volumes".to_string(),
                    description: None,
                    field_type: FieldType::ObjectList {
                        fields: vec![
                            SettingsField {
                                key: "hostPath".to_string(),
                                label: "Host Path".to_string(),
                                description: None,
                                field_type: FieldType::FilePath {
                                    kind: FilePathKind::Directory,
                                },
                                required: true,
                                default: None,
                                placeholder: None,
                                supports_env_expansion: false,
                                supports_tilde_expansion: true,
                                visible_when: None,
                            },
                            SettingsField {
                                key: "containerPath".to_string(),
                                label: "Container Path".to_string(),
                                description: None,
                                field_type: FieldType::Text,
                                required: true,
                                default: None,
                                placeholder: None,
                                supports_env_expansion: false,
                                supports_tilde_expansion: false,
                                visible_when: None,
                            },
                            SettingsField {
                                key: "readOnly".to_string(),
                                label: "Read Only".to_string(),
                                description: None,
                                field_type: FieldType::Boolean,
                                required: false,
                                default: Some(serde_json::json!(false)),
                                placeholder: None,
                                supports_env_expansion: false,
                                supports_tilde_expansion: false,
                                visible_when: None,
                            },
                        ],
                    },
                    required: false,
                    default: None,
                    placeholder: None,
                    supports_env_expansion: false,
                    supports_tilde_expansion: false,
                    visible_when: None,
                }],
            }],
        };

        let json = serde_json::to_string(&schema).unwrap();
        let deserialized: SettingsSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.groups[0].fields[0].key, "volumes");
        if let FieldType::ObjectList { fields } = &deserialized.groups[0].fields[0].field_type {
            assert_eq!(fields.len(), 3);
            assert_eq!(fields[0].key, "hostPath");
        } else {
            panic!("expected ObjectList");
        }
    }
}
