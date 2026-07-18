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
  /** Extended help text shown in a dialog when the user clicks the ? icon. */
  helpText?: string;
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
  | { type: "serialPort" }
  | { type: "filePath"; kind: FilePathKind }
  | { type: "keyValueList" }
  | { type: "objectList"; fields: SettingsField[] }
  | { type: "notice"; severity: NoticeSeverity };

/** Visual severity of a display-only {@link FieldType} `notice` callout. */
export type NoticeSeverity = "info" | "warning";

/** Capabilities declared by a connection type backend. */
export interface Capabilities {
  monitoring: boolean;
  fileBrowser: boolean;
  resize: boolean;
  persistent: boolean;
  /**
   * Whether this connection type has an interactive terminal.
   *
   * Optional to match the wire reality: an agent or config predating this field
   * omits it, and an absent value means terminal-capable (the Rust
   * `#[serde(default = "true")]`). Only an explicit `false` marks a terminal-less
   * type (FTP), which opens directly into a browser-only tab (`"file-browser"`
   * content type) with no terminal session — the file browser lives in the
   * sidebar, driven by the tab's session id. Decide with `terminal === false`,
   * never `!terminal` (#1335).
   */
  terminal?: boolean;
}
