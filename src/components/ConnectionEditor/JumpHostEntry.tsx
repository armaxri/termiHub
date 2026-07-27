import type { JumpHostConfig } from "@/types/connection";
import type { SavedConnectionOption } from "@/utils/jumpHost";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { Input, NumberInput, Select, SelectItem } from "@/components/ui";

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
        <>
          <div className="settings-form__field">
            <span className="settings-form__label">Host</span>
            <Input
              type="text"
              value={hop.host}
              onChange={(e) => onChange({ host: e.target.value })}
              placeholder="bastion.example.com"
              data-testid={tid("host")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Port</span>
            <NumberInput
              value={hop.port}
              min={1}
              max={65535}
              onValueChange={(v) => onChange({ port: v })}
              data-testid={tid("port")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Username</span>
            <Input
              type="text"
              value={hop.username}
              onChange={(e) => onChange({ username: e.target.value })}
              placeholder="admin"
              data-testid={tid("username")}
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Auth Method</span>
            <Select
              value={hop.authMethod}
              onChange={(v) => onChange({ authMethod: v })}
              options={AUTH_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
              aria-label="Auth Method"
              data-testid={tid("auth-method")}
            />
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
        <NumberInput
          value={hop.connectTimeoutSecs ?? ""}
          min={1}
          max={300}
          placeholder="Default (45 s)"
          onValueChange={(v) => onChange({ connectTimeoutSecs: v === "" ? undefined : v })}
          data-testid={tid("connect-timeout")}
        />
      </div>
    </>
  );
}
