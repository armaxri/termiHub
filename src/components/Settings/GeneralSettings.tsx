import { useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { KeyPathInput } from "./KeyPathInput";

const SHELL_LABELS: Record<string, string> = {
  bash: "Bash",
  zsh: "Zsh",
  cmd: "Command Prompt",
  powershell: "PowerShell",
  gitbash: "Git Bash",
  fish: "Fish",
  nushell: "Nushell",
  custom: "Custom",
};

function getShellLabel(shell: ShellType, defaultShell: ShellType): string {
  const distro = getWslDistroName(shell);
  let label: string;
  if (distro !== null) {
    label = `WSL: ${distro}`;
  } else {
    label = SHELL_LABELS[shell] ?? shell;
  }
  return shell === defaultShell ? `${label} (platform default)` : label;
}

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function GeneralSettings({ settings, onChange, visibleFields }: GeneralSettingsProps) {
  const [availableShells, setAvailableShells] = useState<ShellType[]>([]);
  const platformDefaultShell = useAppStore((s) => s.defaultShell);

  useEffect(() => {
    detectAvailableShells().then(setAvailableShells);
  }, []);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <>
      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">General</h3>

        {show("defaultUser") && (
          <label className="settings-form__field">
            <span className="settings-form__label">Default User</span>
            <input
              type="text"
              value={settings.defaultUser ?? ""}
              onChange={(e) => onChange({ ...settings, defaultUser: e.target.value || undefined })}
              placeholder="e.g. admin"
            />
            <span className="settings-form__hint">
              Default username pre-filled for new SSH connections.
            </span>
          </label>
        )}

        {show("defaultSshKeyPath") && (
          <div className="settings-form__field">
            <span className="settings-form__label">Default SSH Key Path</span>
            <KeyPathInput
              value={settings.defaultSshKeyPath ?? ""}
              onChange={(value) => onChange({ ...settings, defaultSshKeyPath: value || undefined })}
              placeholder="~/.ssh/id_ed25519"
              testIdPrefix="general-settings"
            />
            <span className="settings-form__hint">
              Default private key path for SSH key authentication.
            </span>
          </div>
        )}

        {show("defaultShell") && (
          <label className="settings-form__field">
            <span className="settings-form__label">Default Shell</span>
            <select
              value={settings.defaultShell ?? ""}
              onChange={(e) => onChange({ ...settings, defaultShell: e.target.value || undefined })}
            >
              <option value="">
                Platform default (
                {getShellLabel(platformDefaultShell, platformDefaultShell).replace(
                  " (platform default)",
                  ""
                )}
                )
              </option>
              {availableShells.map((shell) => (
                <option key={shell} value={shell}>
                  {getShellLabel(shell, platformDefaultShell)}
                </option>
              ))}
            </select>
            <span className="settings-form__hint">
              Default shell for new local terminal sessions.
            </span>
          </label>
        )}

        {show("experimentalFeaturesEnabled") && (
          <div className="settings-form__field">
            <span className="settings-form__label">Allow Experimental Features</span>
            <label className="settings-panel__toggle">
              <input
                type="checkbox"
                checked={settings.experimentalFeaturesEnabled ?? false}
                onChange={(e) =>
                  onChange({ ...settings, experimentalFeaturesEnabled: e.target.checked })
                }
                data-testid="settings-experimental-features"
              />
              <span className="settings-panel__toggle-slider" />
            </label>
            <span className="settings-form__hint settings-form__hint--warning">
              Enables hidden features under active development. Experimental features may change,
              break, or be removed at any time without notice.
            </span>
          </div>
        )}
      </div>

      {(show("defaultShellIntegration") || show("defaultX11Forwarding")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">SSH Defaults</h3>

          {show("defaultShellIntegration") && (
            <div className="settings-form__field">
              <span className="settings-form__label">Shell Integration by Default</span>
              <label className="settings-panel__toggle">
                <input
                  type="checkbox"
                  checked={settings.defaultShellIntegration ?? true}
                  onChange={(e) =>
                    onChange({ ...settings, defaultShellIntegration: e.target.checked })
                  }
                  data-testid="settings-default-shell-integration"
                />
                <span className="settings-panel__toggle-slider" />
              </label>
              <span className="settings-form__hint">
                Pre-enable Shell Integration (OSC 7 CWD tracking) for new SSH connections.
              </span>
            </div>
          )}

          {show("defaultX11Forwarding") && (
            <div className="settings-form__field">
              <span className="settings-form__label">X11 Forwarding by Default</span>
              <label className="settings-panel__toggle">
                <input
                  type="checkbox"
                  checked={settings.defaultX11Forwarding ?? true}
                  onChange={(e) =>
                    onChange({ ...settings, defaultX11Forwarding: e.target.checked })
                  }
                  data-testid="settings-default-x11-forwarding"
                />
                <span className="settings-panel__toggle-slider" />
              </label>
              <span className="settings-form__hint">
                Pre-enable X11 Forwarding for new SSH connections.
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
