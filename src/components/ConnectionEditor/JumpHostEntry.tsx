import type { JumpHostConfig } from "@/types/connection";
import type { SavedConnectionOption } from "@/utils/jumpHost";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";

interface JumpHostEntryProps {
  /** The hop being edited. */
  hop: JumpHostConfig;
  /** Zero-based index, used to make field test ids unique within the chain. */
  index: number;
  /** Merge a partial update into this hop. */
  onChange: (patch: Partial<JumpHostConfig>) => void;
  /** SSH connections selectable as a saved-connection hop (folder-path labelled). */
  savedConnections: SavedConnectionOption[];
}

/** Auth methods offered for an inline jump host (mirrors the SSH auth schema). */
const AUTH_OPTIONS = [
  { value: "key", label: "SSH Key" },
  { value: "password", label: "Password" },
  { value: "agent", label: "SSH Agent" },
] as const;

/**
 * The fields for a single jump host hop. A hop is configured one of two ways
 * (#940): by **referencing a saved SSH connection** (a dropdown; stored as
 * `connectionId`) or by **inline configuration** (host, port, username, auth).
 * The per-hop connect timeout applies to both. Used both for a lone jump host
 * and inside a hop card in a multi-hop chain.
 */
export function JumpHostEntry({ hop, index, onChange, savedConnections }: JumpHostEntryProps) {
  const tid = (field: string) => `jump-host-${field}-${index}`;
  const mode: "saved" | "inline" = hop.connectionId ? "saved" : "inline";
  const noSavedAvailable = savedConnections.length === 0;
  // A referenced connection that is no longer in the list (deleted/renamed).
  const refMissing = mode === "saved" && !savedConnections.some((o) => o.id === hop.connectionId);

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
          <select
            value={hop.connectionId ?? ""}
            onChange={(e) => onChange({ connectionId: e.target.value })}
            data-testid={tid("connection")}
          >
            {refMissing && <option value={hop.connectionId}>{hop.connectionId} (not found)</option>}
            {savedConnections.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="settings-form__field">
            <span className="settings-form__label">Host</span>
            <input
              type="text"
              value={hop.host}
              onChange={(e) => onChange({ host: e.target.value })}
              placeholder="bastion.example.com"
              data-testid={tid("host")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Port</span>
            <input
              type="number"
              value={hop.port}
              min={1}
              max={65535}
              onChange={(e) =>
                onChange({ port: e.target.value === "" ? 22 : Number(e.target.value) })
              }
              data-testid={tid("port")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Username</span>
            <input
              type="text"
              value={hop.username}
              onChange={(e) => onChange({ username: e.target.value })}
              placeholder="admin"
              data-testid={tid("username")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Auth Method</span>
            <select
              value={hop.authMethod}
              onChange={(e) => onChange({ authMethod: e.target.value })}
              data-testid={tid("auth-method")}
            >
              {AUTH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {hop.authMethod === "key" && (
            <div className="settings-form__field">
              <span className="settings-form__label">Key Path</span>
              <KeyPathInput
                value={hop.keyPath ?? ""}
                onChange={(v) => onChange({ keyPath: v || undefined })}
                placeholder="~/.ssh/id_ed25519"
                testIdPrefix={tid("key-path")}
              />
            </div>
          )}

          {hop.authMethod === "password" && (
            <div className="settings-form__field">
              <span className="settings-form__label">Password</span>
              <PasswordInput
                value={hop.password ?? ""}
                onChange={(e) => onChange({ password: e.target.value || undefined })}
                placeholder="Jump host password"
                data-testid={tid("password")}
              />
            </div>
          )}
        </>
      )}

      <div className="settings-form__field">
        <span className="settings-form__label">Connect Timeout (s)</span>
        <input
          type="number"
          value={hop.connectTimeoutSecs ?? ""}
          min={1}
          max={300}
          placeholder="Default (20 s)"
          onChange={(e) =>
            onChange({
              connectTimeoutSecs: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
          data-testid={tid("connect-timeout")}
        />
      </div>
    </>
  );
}
