import { useCallback } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { JumpHostConfig } from "@/types/connection";
import { KeyPathInput } from "@/components/Settings/KeyPathInput";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { JumpHostPathDisplay } from "./JumpHostPathDisplay";

interface JumpHostSectionProps {
  /** Current `proxyJump` chain from the SSH connection settings. */
  value: JumpHostConfig[] | undefined;
  /** Target host of the SSH connection, shown in the connection-path summary. */
  targetHost: string | undefined;
  /** Emits the new chain, or `undefined` to remove jump-host config entirely. */
  onChange: (hops: JumpHostConfig[] | undefined) => void;
}

/** Auth methods offered for an inline jump host (mirrors the SSH auth schema). */
const AUTH_OPTIONS = [
  { value: "key", label: "SSH Key" },
  { value: "password", label: "Password" },
  { value: "agent", label: "SSH Agent" },
] as const;

/** A fresh inline hop, used when the user first enables a jump host. */
function defaultHop(): JumpHostConfig {
  return { host: "", port: 22, username: "", authMethod: "key" };
}

/**
 * "Jump Host" section of the SSH connection editor.
 *
 * Phase 2 (#923) supports a single inline hop (OpenSSH `-J` style): the target
 * is reached through one bastion configured directly here. Referencing a saved
 * connection and multi-hop chains land in a later phase; the underlying
 * `proxyJump` model is already an array, so this writes a one-element chain.
 */
export function JumpHostSection({ value, targetHost, onChange }: JumpHostSectionProps) {
  const enabled = (value?.length ?? 0) > 0;
  const hop = value?.[0];

  const toggleEnabled = useCallback(
    (checked: boolean) => {
      onChange(checked ? [defaultHop()] : undefined);
    },
    [onChange]
  );

  const updateHop = useCallback(
    (patch: Partial<JumpHostConfig>) => {
      const base = value?.[0] ?? defaultHop();
      onChange([{ ...base, ...patch }]);
    },
    [onChange, value]
  );

  return (
    <div className="settings-panel__category" data-testid="jump-host-section">
      <h3 className="settings-panel__category-title">Jump Host</h3>

      <label className="settings-form__field settings-form__field--checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
          data-testid="jump-host-enabled"
        />
        <span className="settings-form__label jump-host__toggle-label">
          <ArrowLeftRight size={13} aria-hidden />
          Connect through a jump host
        </span>
      </label>

      {enabled && hop && (
        <>
          <div className="settings-form__field">
            <span className="settings-form__label">Host</span>
            <input
              type="text"
              value={hop.host}
              onChange={(e) => updateHop({ host: e.target.value })}
              placeholder="bastion.example.com"
              data-testid="jump-host-host"
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
                updateHop({ port: e.target.value === "" ? 22 : Number(e.target.value) })
              }
              data-testid="jump-host-port"
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Username</span>
            <input
              type="text"
              value={hop.username}
              onChange={(e) => updateHop({ username: e.target.value })}
              placeholder="admin"
              data-testid="jump-host-username"
            />
          </div>

          <div className="settings-form__field">
            <span className="settings-form__label">Auth Method</span>
            <select
              value={hop.authMethod}
              onChange={(e) => updateHop({ authMethod: e.target.value })}
              data-testid="jump-host-auth-method"
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
                onChange={(v) => updateHop({ keyPath: v || undefined })}
                placeholder="~/.ssh/id_ed25519"
                testIdPrefix="jump-host-key-path"
              />
            </div>
          )}

          {hop.authMethod === "password" && (
            <div className="settings-form__field">
              <span className="settings-form__label">Password</span>
              <PasswordInput
                value={hop.password ?? ""}
                onChange={(e) => updateHop({ password: e.target.value || undefined })}
                placeholder="Jump host password"
                data-testid="jump-host-password"
              />
            </div>
          )}

          <p className="settings-form__hint">
            The target connects through this jump host (OpenSSH <code>-J</code> / ProxyJump). The
            bastion only forwards the connection — it needs TCP forwarding enabled.
          </p>

          <JumpHostPathDisplay hops={[hop.host]} target={targetHost ?? ""} />
        </>
      )}
    </div>
  );
}
