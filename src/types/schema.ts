/**
 * TypeScript equivalents of the Rust connection schema types
 * defined in `core/src/connection/schema.rs`.
 *
 * The backend serializes these as camelCase JSON; the interfaces
 * here mirror that serialization exactly.
 */

/** Top-level settings schema containing grouped fields. */
export interface SettingsSchema {
  groups: SettingsGroup[];
}

/** A named group of related settings fields. */
export interface SettingsGroup {
  key: string;
  label: string;
  fields: SettingsField[];
}

/** A single settings field with metadata for UI rendering and validation. */
export interface SettingsField {
  key: string;
  label: string;
  description?: string;
  fieldType: FieldType;
  required: boolean;
  default?: unknown;
  placeholder?: string;
  supportsEnvExpansion?: boolean;
  supportsTildeExpansion?: boolean;
  visibleWhen?: Condition;
}

/** Conditional visibility rule: field is shown when the referenced field equals a value. */
export interface Condition {
  field: string;
  equals: unknown;
}

/** Kind of path accepted by a FilePath field. */
export type FilePathKind = "file" | "directory" | "any";

/** An option in a Select dropdown. */
export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Tagged union for field types.
 * Serialized from Rust as `{ "type": "text" }`, `{ "type": "number", "min": 0 }`, etc.
 */
export type FieldType =
  | { type: "text" }
  | { type: "password" }
  | { type: "number"; min?: number; max?: number }
  | { type: "boolean" }
  | { type: "select"; options: SelectOption[] }
  | { type: "port" }
  | { type: "filePath"; kind: FilePathKind }
  | { type: "keyValueList" }
  | { type: "objectList"; fields: SettingsField[] };

/** Capabilities declared by a connection type backend. */
export interface Capabilities {
  monitoring: boolean;
  fileBrowser: boolean;
  resize: boolean;
  persistent: boolean;
}
