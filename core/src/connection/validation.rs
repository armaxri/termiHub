//! Runtime validation of settings values against a [`SettingsSchema`].
//!
//! Use [`validate_settings`] to check a `serde_json::Value` against a schema.
//! Validation respects [`Condition`] rules: fields hidden by `visible_when`
//! are skipped.

use super::schema::*;

/// A single validation error for a settings field.
#[derive(Debug, Clone)]
pub struct ValidationError {
    /// Dot-path to the field (e.g., `"host"`, `"volumes.0.hostPath"`).
    pub field: String,
    /// Human-readable error message.
    pub message: String,
}

/// Validate a settings JSON value against a schema.
///
/// Returns a list of all validation errors. An empty list means the
/// settings are valid. Respects `visible_when` conditions: hidden fields
/// are not validated.
pub fn validate_settings(
    schema: &SettingsSchema,
    settings: &serde_json::Value,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    for group in &schema.groups {
        for field in &group.fields {
            validate_field(field, settings, &mut errors);
        }
    }
    errors
}

fn validate_field(
    field: &SettingsField,
    parent: &serde_json::Value,
    errors: &mut Vec<ValidationError>,
) {
    // Check visibility condition against the parent object.
    if let Some(condition) = &field.visible_when {
        let condition_value = parent.get(&condition.field);
        match condition_value {
            Some(v) if *v == condition.equals => {} // visible — continue
            _ => return,                            // hidden — skip
        }
    }

    let value = parent.get(&field.key);

    // Required check.
    if field.required {
        match value {
            None | Some(serde_json::Value::Null) => {
                errors.push(ValidationError {
                    field: field.key.clone(),
                    message: format!("{} is required", field.label),
                });
                return;
            }
            Some(serde_json::Value::String(s)) if s.is_empty() => {
                errors.push(ValidationError {
                    field: field.key.clone(),
                    message: format!("{} must not be empty", field.label),
                });
                return;
            }
            _ => {}
        }
    }

    // Type-specific validation (only if a value is present).
    if let Some(val) = value {
        if !val.is_null() {
            validate_field_type(&field.key, &field.label, &field.field_type, val, errors);
        }
    }
}

fn validate_field_type(
    key: &str,
    label: &str,
    field_type: &FieldType,
    value: &serde_json::Value,
    errors: &mut Vec<ValidationError>,
) {
    match field_type {
        FieldType::Text | FieldType::Password => {
            if !value.is_string() {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a string"),
                });
            }
        }
        FieldType::Number { min, max } => {
            if let Some(n) = value.as_f64() {
                if let Some(min_val) = min {
                    if n < *min_val {
                        errors.push(ValidationError {
                            field: key.to_string(),
                            message: format!("{label} must be at least {min_val}"),
                        });
                    }
                }
                if let Some(max_val) = max {
                    if n > *max_val {
                        errors.push(ValidationError {
                            field: key.to_string(),
                            message: format!("{label} must be at most {max_val}"),
                        });
                    }
                }
            } else {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a number"),
                });
            }
        }
        FieldType::Boolean => {
            if !value.is_boolean() {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a boolean"),
                });
            }
        }
        FieldType::Select { options } => {
            if let Some(s) = value.as_str() {
                if !options.iter().any(|o| o.value == s) {
                    errors.push(ValidationError {
                        field: key.to_string(),
                        message: format!("{label} must be one of the available options"),
                    });
                }
            } else {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a string"),
                });
            }
        }
        FieldType::Port => {
            if let Some(n) = value.as_f64() {
                let n = n as i64;
                if !(1..=65535).contains(&n) {
                    errors.push(ValidationError {
                        field: key.to_string(),
                        message: format!("{label} must be between 1 and 65535"),
                    });
                }
            } else {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a number"),
                });
            }
        }
        FieldType::FilePath { .. } => {
            if !value.is_string() {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be a string"),
                });
            }
        }
        FieldType::KeyValueList => {
            if let Some(arr) = value.as_array() {
                for (i, item) in arr.iter().enumerate() {
                    if item.get("key").and_then(|v| v.as_str()).is_none() {
                        errors.push(ValidationError {
                            field: format!("{key}.{i}.key"),
                            message: "Key must be a non-null string".to_string(),
                        });
                    }
                    if item.get("value").and_then(|v| v.as_str()).is_none() {
                        errors.push(ValidationError {
                            field: format!("{key}.{i}.value"),
                            message: "Value must be a non-null string".to_string(),
                        });
                    }
                }
            } else {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be an array"),
                });
            }
        }
        FieldType::ObjectList { fields } => {
            if let Some(arr) = value.as_array() {
                for (i, item) in arr.iter().enumerate() {
                    for sub_field in fields {
                        let mut sub_errors = Vec::new();
                        validate_field(sub_field, item, &mut sub_errors);
                        for mut err in sub_errors {
                            err.field = format!("{key}.{i}.{}", err.field);
                            errors.push(err);
                        }
                    }
                }
            } else {
                errors.push(ValidationError {
                    field: key.to_string(),
                    message: format!("{label} must be an array"),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: build a minimal schema with one group and the given fields.
    fn schema_with_fields(fields: Vec<SettingsField>) -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                key: "test".to_string(),
                label: "Test".to_string(),
                fields,
            }],
        }
    }

    /// Helper: build a required text field.
    fn required_text(key: &str) -> SettingsField {
        SettingsField {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            field_type: FieldType::Text,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        }
    }

    #[test]
    fn required_field_missing() {
        let schema = schema_with_fields(vec![required_text("host")]);
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "host");
        assert!(errors[0].message.contains("required"));
    }

    #[test]
    fn required_field_null() {
        let schema = schema_with_fields(vec![required_text("host")]);
        let settings = serde_json::json!({"host": null});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("required"));
    }

    #[test]
    fn required_field_empty_string() {
        let schema = schema_with_fields(vec![required_text("host")]);
        let settings = serde_json::json!({"host": ""});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must not be empty"));
    }

    #[test]
    fn required_field_present() {
        let schema = schema_with_fields(vec![required_text("host")]);
        let settings = serde_json::json!({"host": "example.com"});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn optional_field_missing_ok() {
        let mut field = required_text("host");
        field.required = false;
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn text_field_wrong_type() {
        let schema = schema_with_fields(vec![required_text("host")]);
        let settings = serde_json::json!({"host": 42});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a string"));
    }

    #[test]
    fn number_below_min() {
        let field = SettingsField {
            key: "rate".to_string(),
            label: "Rate".to_string(),
            description: None,
            field_type: FieldType::Number {
                min: Some(1.0),
                max: Some(100.0),
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"rate": 0});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("at least"));
    }

    #[test]
    fn number_above_max() {
        let field = SettingsField {
            key: "rate".to_string(),
            label: "Rate".to_string(),
            description: None,
            field_type: FieldType::Number {
                min: None,
                max: Some(100.0),
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"rate": 200});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("at most"));
    }

    #[test]
    fn number_within_range() {
        let field = SettingsField {
            key: "rate".to_string(),
            label: "Rate".to_string(),
            description: None,
            field_type: FieldType::Number {
                min: Some(1.0),
                max: Some(100.0),
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"rate": 50});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn number_wrong_type() {
        let field = SettingsField {
            key: "rate".to_string(),
            label: "Rate".to_string(),
            description: None,
            field_type: FieldType::Number {
                min: None,
                max: None,
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"rate": "fast"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a number"));
    }

    #[test]
    fn boolean_wrong_type() {
        let field = SettingsField {
            key: "enabled".to_string(),
            label: "Enabled".to_string(),
            description: None,
            field_type: FieldType::Boolean,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"enabled": "yes"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a boolean"));
    }

    #[test]
    fn boolean_valid() {
        let field = SettingsField {
            key: "enabled".to_string(),
            label: "Enabled".to_string(),
            description: None,
            field_type: FieldType::Boolean,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"enabled": true});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn select_invalid_option() {
        let field = SettingsField {
            key: "auth".to_string(),
            label: "Auth".to_string(),
            description: None,
            field_type: FieldType::Select {
                options: vec![
                    SelectOption {
                        value: "key".to_string(),
                        label: "Key".to_string(),
                    },
                    SelectOption {
                        value: "password".to_string(),
                        label: "Password".to_string(),
                    },
                ],
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"auth": "token"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("available options"));
    }

    #[test]
    fn select_valid_option() {
        let field = SettingsField {
            key: "auth".to_string(),
            label: "Auth".to_string(),
            description: None,
            field_type: FieldType::Select {
                options: vec![SelectOption {
                    value: "key".to_string(),
                    label: "Key".to_string(),
                }],
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"auth": "key"});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn select_wrong_type() {
        let field = SettingsField {
            key: "auth".to_string(),
            label: "Auth".to_string(),
            description: None,
            field_type: FieldType::Select {
                options: vec![SelectOption {
                    value: "key".to_string(),
                    label: "Key".to_string(),
                }],
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"auth": 123});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a string"));
    }

    #[test]
    fn port_below_range() {
        let field = SettingsField {
            key: "port".to_string(),
            label: "Port".to_string(),
            description: None,
            field_type: FieldType::Port,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"port": 0});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("between 1 and 65535"));
    }

    #[test]
    fn port_above_range() {
        let field = SettingsField {
            key: "port".to_string(),
            label: "Port".to_string(),
            description: None,
            field_type: FieldType::Port,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"port": 70000});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("between 1 and 65535"));
    }

    #[test]
    fn port_valid() {
        let field = SettingsField {
            key: "port".to_string(),
            label: "Port".to_string(),
            description: None,
            field_type: FieldType::Port,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"port": 22});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn port_wrong_type() {
        let field = SettingsField {
            key: "port".to_string(),
            label: "Port".to_string(),
            description: None,
            field_type: FieldType::Port,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"port": "ssh"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a number"));
    }

    #[test]
    fn file_path_wrong_type() {
        let field = SettingsField {
            key: "path".to_string(),
            label: "Path".to_string(),
            description: None,
            field_type: FieldType::FilePath {
                kind: FilePathKind::File,
            },
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"path": 42});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a string"));
    }

    #[test]
    fn visible_when_condition_not_met_skips_validation() {
        let fields = vec![
            SettingsField {
                key: "auth".to_string(),
                label: "Auth".to_string(),
                description: None,
                field_type: FieldType::Select {
                    options: vec![
                        SelectOption {
                            value: "key".to_string(),
                            label: "Key".to_string(),
                        },
                        SelectOption {
                            value: "password".to_string(),
                            label: "Password".to_string(),
                        },
                    ],
                },
                required: true,
                default: None,
                placeholder: None,
                supports_env_expansion: false,
                supports_tilde_expansion: false,
                visible_when: None,
            },
            SettingsField {
                key: "password".to_string(),
                label: "Password".to_string(),
                description: None,
                field_type: FieldType::Password,
                required: true,
                default: None,
                placeholder: None,
                supports_env_expansion: false,
                supports_tilde_expansion: false,
                visible_when: Some(Condition {
                    field: "auth".to_string(),
                    equals: serde_json::json!("password"),
                }),
            },
        ];
        let schema = schema_with_fields(fields);

        // auth=key → password field is hidden → no error for missing password
        let settings = serde_json::json!({"auth": "key"});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn visible_when_condition_met_validates_field() {
        let fields = vec![
            SettingsField {
                key: "auth".to_string(),
                label: "Auth".to_string(),
                description: None,
                field_type: FieldType::Select {
                    options: vec![SelectOption {
                        value: "password".to_string(),
                        label: "Password".to_string(),
                    }],
                },
                required: true,
                default: None,
                placeholder: None,
                supports_env_expansion: false,
                supports_tilde_expansion: false,
                visible_when: None,
            },
            SettingsField {
                key: "password".to_string(),
                label: "Password".to_string(),
                description: None,
                field_type: FieldType::Password,
                required: true,
                default: None,
                placeholder: None,
                supports_env_expansion: false,
                supports_tilde_expansion: false,
                visible_when: Some(Condition {
                    field: "auth".to_string(),
                    equals: serde_json::json!("password"),
                }),
            },
        ];
        let schema = schema_with_fields(fields);

        // auth=password → password field is visible → required error
        let settings = serde_json::json!({"auth": "password"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "password");
        assert!(errors[0].message.contains("required"));
    }

    #[test]
    fn key_value_list_valid() {
        let field = SettingsField {
            key: "env".to_string(),
            label: "Env".to_string(),
            description: None,
            field_type: FieldType::KeyValueList,
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({
            "env": [
                {"key": "FOO", "value": "bar"},
                {"key": "BAZ", "value": "qux"}
            ]
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn key_value_list_missing_key() {
        let field = SettingsField {
            key: "env".to_string(),
            label: "Env".to_string(),
            description: None,
            field_type: FieldType::KeyValueList,
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({
            "env": [{"value": "bar"}]
        });
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "env.0.key");
    }

    #[test]
    fn key_value_list_not_array() {
        let field = SettingsField {
            key: "env".to_string(),
            label: "Env".to_string(),
            description: None,
            field_type: FieldType::KeyValueList,
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"env": "not-an-array"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be an array"));
    }

    #[test]
    fn object_list_recursive_validation() {
        let field = SettingsField {
            key: "volumes".to_string(),
            label: "Volumes".to_string(),
            description: None,
            field_type: FieldType::ObjectList {
                fields: vec![
                    SettingsField {
                        key: "hostPath".to_string(),
                        label: "Host Path".to_string(),
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
                ],
            },
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({
            "volumes": [
                {"hostPath": "/data"},
                {"hostPath": "/logs", "containerPath": "/var/log"}
            ]
        });
        let errors = validate_settings(&schema, &settings);
        // First item missing containerPath, second item has both fields.
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "volumes.0.containerPath");
    }

    #[test]
    fn object_list_not_array() {
        let field = SettingsField {
            key: "volumes".to_string(),
            label: "Volumes".to_string(),
            description: None,
            field_type: FieldType::ObjectList { fields: vec![] },
            required: false,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"volumes": "not-an-array"});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be an array"));
    }

    #[test]
    fn complex_valid_settings() {
        let schema = SettingsSchema {
            groups: vec![
                SettingsGroup {
                    key: "connection".to_string(),
                    label: "Connection".to_string(),
                    fields: vec![
                        required_text("host"),
                        SettingsField {
                            key: "port".to_string(),
                            label: "Port".to_string(),
                            description: None,
                            field_type: FieldType::Port,
                            required: true,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                        SettingsField {
                            key: "enabled".to_string(),
                            label: "Enabled".to_string(),
                            description: None,
                            field_type: FieldType::Boolean,
                            required: true,
                            default: None,
                            placeholder: None,
                            supports_env_expansion: false,
                            supports_tilde_expansion: false,
                            visible_when: None,
                        },
                    ],
                },
                SettingsGroup {
                    key: "auth".to_string(),
                    label: "Auth".to_string(),
                    fields: vec![SettingsField {
                        key: "password".to_string(),
                        label: "Password".to_string(),
                        description: None,
                        field_type: FieldType::Password,
                        required: false,
                        default: None,
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    }],
                },
            ],
        };
        let settings = serde_json::json!({
            "host": "example.com",
            "port": 22,
            "enabled": true,
            "password": "secret"
        });
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn multiple_errors_reported() {
        let schema = schema_with_fields(vec![required_text("host"), required_text("username")]);
        let settings = serde_json::json!({});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 2);
    }

    #[test]
    fn null_value_for_optional_non_required_field_ok() {
        let mut field = required_text("host");
        field.required = false;
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"host": null});
        let errors = validate_settings(&schema, &settings);
        assert!(errors.is_empty());
    }

    #[test]
    fn password_field_wrong_type() {
        let field = SettingsField {
            key: "pass".to_string(),
            label: "Pass".to_string(),
            description: None,
            field_type: FieldType::Password,
            required: true,
            default: None,
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        };
        let schema = schema_with_fields(vec![field]);
        let settings = serde_json::json!({"pass": 123});
        let errors = validate_settings(&schema, &settings);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("must be a string"));
    }
}
