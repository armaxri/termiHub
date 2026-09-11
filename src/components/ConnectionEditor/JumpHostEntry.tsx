import type { JumpHostConfig } from "@/types/connection";
import type { SettingsField } from "@/types/schema";
import type { SavedConnectionOption } from "@/utils/jumpHost";
import { isFieldVisible } from "@/utils/schemaDefaults";
import { DynamicField } from "@/components/DynamicForm/DynamicField";
import { Select, SelectItem } from "@/components/ui";

interface JumpHostEntryProps {
  /** The hop being edited. */
  hop: JumpHostConfig;
  /** Zero-based index, used to make field test ids unique within the chain. */
  index: number;
  /**
   * Inline-hop fields sourced from the SSH connection schema (host, port,
   * username, auth method, key path, password) plus the per-hop connect
   * timeout — see {@link jumpHostInlineFields}. Rendered through the shared
   * {@link DynamicField} so the hop editor never hand-rolls the SSH form.
   */
  fields: SettingsField[];
  /** Merge a partial update into this hop. */
  onChange: (patch: Partial<JumpHostConfig>) => void;
  /** SSH connections selectable as a saved-connection hop (folder-path labelled). */
  savedConnections: SavedConnectionOption[];
}

/** Kebab-case test-id slug for each hop field key (stable across the migration). */
const FIELD_TEST_SLUG: Record<string, string> = {
  host: "host",
  port: "port",
  username: "username",
  authMethod: "auth-method",
  keyPath: "key-path",
  password: "password",
  connectTimeoutSecs: "connect-timeout",
};

/**
 * Read a hop field value in the shape {@link DynamicField} expects. The port
 * follows the shared `number | ""` blank-value convention (#1444): a cleared
 * port is stored as `""`, but the numeric widget wants `undefined` to render
 * blank (an empty string would coerce to `0`).
 */
function fieldValue(hop: JumpHostConfig, key: string): unknown {
  const raw = (hop as unknown as Record<string, unknown>)[key];
  if (key === "port") return raw === "" ? undefined : raw;
  return raw;
}

/**
 * Translate a {@link DynamicField} change back into a {@link JumpHostConfig}
 * patch, preserving the exact stored shape: `host`/`username`/`authMethod` are
 * non-optional strings (empty string, never `undefined`); a cleared `port` is
 * `""` (#1444); `keyPath`/`password`/`connectTimeoutSecs` clear to `undefined`.
 */
function fieldPatch(key: string, value: unknown): Partial<JumpHostConfig> {
  switch (key) {
    case "port":
      return { port: value === undefined ? "" : (value as number) };
    case "host":
      return { host: (value as string) ?? "" };
    case "username":
      return { username: (value as string) ?? "" };
    case "authMethod":
      return { authMethod: (value as string) ?? "" };
    default:
      return { [key]: value } as Partial<JumpHostConfig>;
  }
}

/**
 * The fields for a single jump host hop. A hop is configured one of two ways
 * (#940): by **referencing a saved SSH connection** (a dropdown; stored as
 * `connectionId`) or by **inline configuration** (host, port, username, auth).
 * The inline fields are rendered through the shared schema-driven
 * {@link DynamicField} against the SSH connection schema (UISF-014), so they
 * stay identical to the primary connection form — no hand-rolled inputs and no
 * locally re-declared auth-method list. The per-hop connect timeout applies to
 * both modes. Used both for a lone jump host and inside a hop card in a
 * multi-hop chain.
 */
export function JumpHostEntry({
  hop,
  index,
  fields,
  onChange,
  savedConnections,
}: JumpHostEntryProps) {
  const tid = (field: string) => `jump-host-${field}-${index}`;
  const mode: "saved" | "inline" = hop.connectionId ? "saved" : "inline";
  const noSavedAvailable = savedConnections.length === 0;
  // A referenced connection that is no longer in the list (deleted/renamed).
  const refMissing = mode === "saved" && !savedConnections.some((o) => o.id === hop.connectionId);

  // The connect timeout applies to both modes; the SSH-sourced fields are the
  // inline configuration.
  const inlineFields = fields.filter((f) => f.key !== "connectTimeoutSecs");
  const timeoutField = fields.find((f) => f.key === "connectTimeoutSecs");

  const selectSaved = () => {
    if (mode === "saved") return;
    // Default to the first available connection (the dropdown's natural value)
    // and clear inline fields so a reference doesn't carry stale config.
    onChange({ connectionId: savedConnections[0]?.id ?? "", host: "", username: "" });
  };

  const selectInline = () => {
    if (mode === "inline") return;
    onChange({ connectionId: undefined });
  };

  const renderField = (field: SettingsField) => {
    const slug = FIELD_TEST_SLUG[field.key] ?? field.key;
    return (
      <DynamicField
        key={field.key}
        field={field}
        value={fieldValue(hop, field.key)}
        onChange={(value) => onChange(fieldPatch(field.key, value))}
        testId={tid(slug)}
      />
    );
  };

  return (
    <>
      <div className="settings-form__field">
        <span className="settings-form__label">Source</span>
        <div className="jump-host__source-toggle" role="radiogroup" aria-label="Jump host source">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "saved"}
            className={`jump-host__source-opt${mode === "saved" ? " jump-host__source-opt--active" : ""}`}
            onClick={selectSaved}
            disabled={noSavedAvailable && mode !== "saved"}
            title={noSavedAvailable ? "No saved SSH connections to reference" : undefined}
            data-testid={tid("source-saved")}
          >
            Saved connection
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "inline"}
            className={`jump-host__source-opt${mode === "inline" ? " jump-host__source-opt--active" : ""}`}
            onClick={selectInline}
            data-testid={tid("source-inline")}
          >
            Inline configuration
          </button>
        </div>
      </div>

      {mode === "saved" ? (
        <div className="settings-form__field">
          <span className="settings-form__label">Connection</span>
          <Select
            value={hop.connectionId ?? ""}
            onChange={(v) => onChange({ connectionId: v })}
            aria-label="Connection"
            data-testid={tid("connection")}
          >
            {refMissing && (
              <SelectItem value={hop.connectionId ?? ""}>{hop.connectionId} (not found)</SelectItem>
            )}
            {savedConnections.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      ) : (
        inlineFields
          .filter((field) => isFieldVisible(field, hop as unknown as Record<string, unknown>))
          .map(renderField)
      )}

      {timeoutField && renderField(timeoutField)}
    </>
  );
}
