import type { JumpHostConfig } from "@/types/connection";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";

interface JumpHostEntryProps {
  /** The hop being edited. */
  hop: JumpHostConfig;
  /** Zero-based index, used to make field test ids unique within the chain. */
  index: number;
  /** Merge a partial update into this hop. */
  onChange: (patch: Partial<JumpHostConfig>) => void;
}

/** Auth methods offered for an inline jump host (mirrors the SSH auth schema). */
const AUTH_OPTIONS = [
  { value: "key", label: "SSH Key" },
  { value: "password", label: "Password" },
  { value: "agent", label: "SSH Agent" },
] as const;

/**
 * The inline connection fields for a single jump host hop (host, port,
 * username, auth method, and key path / password by method). Used both for a
 * lone jump host and inside a hop card in a multi-hop chain.
 */
export function JumpHostEntry({ hop, index, onChange }: JumpHostEntryProps) {
  const tid = (field: string) => `jump-host-${field}-${index}`;

  return (
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
          onChange={(e) => onChange({ port: e.target.value === "" ? 22 : Number(e.target.value) })}
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
  );
}
