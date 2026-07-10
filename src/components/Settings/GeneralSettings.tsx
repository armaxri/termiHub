import { useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { isWindows } from "@/utils/platform";
import { Select, SelectItem, Toggle } from "@/components/ui";
import { KeyPathInput } from "./KeyPathInput";

/** Sentinel value for the "platform default" shell option (Radix Select forbids empty-string item values). */
const PLATFORM_DEFAULT_SHELL = "__platform_default__";

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
              data-testid="settings-default-user"
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
          <div className="settings-form__field">
            <span className="settings-form__label">Default Shell</span>
            <Select
              aria-label="Default Shell"
              data-testid="settings-default-shell"
              value={settings.defaultShell ?? PLATFORM_DEFAULT_SHELL}
              onChange={(value) =>
                onChange({
                  ...settings,
                  defaultShell: value === PLATFORM_DEFAULT_SHELL ? undefined : value,
                })
              }
            >
              <SelectItem value={PLATFORM_DEFAULT_SHELL}>
                Platform default (
                {getShellLabel(platformDefaultShell, platformDefaultShell).replace(
                  " (platform default)",
                  ""
                )}
                )
              </SelectItem>
              {availableShells.map((shell) => (
                <SelectItem key={shell} value={shell}>
                  {getShellLabel(shell, platformDefaultShell)}
                </SelectItem>
              ))}
            </Select>
            <span className="settings-form__hint">
              Default shell for new local terminal sessions.
            </span>
          </div>
        )}

        {show("confirmCloseTabOnShortcut") && (
          <div className="settings-form__field">
            <span className="settings-form__label">Confirm Close Tab on Shortcut</span>
            <Toggle
              aria-label="Confirm Close Tab on Shortcut"
              checked={settings.confirmCloseTabOnShortcut ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, confirmCloseTabOnShortcut: checked })
              }
              data-testid="settings-confirm-close-tab-on-shortcut"
            />
            <span className="settings-form__hint">
              Ask for confirmation when closing a tab or tab group via keyboard shortcut. The X
              button on tabs is unaffected.
            </span>
          </div>
        )}

        {show("experimentalFeaturesEnabled") && (
          <div className="settings-form__field">
            <span className="settings-form__label">Allow Experimental Features</span>
            <Toggle
              aria-label="Allow Experimental Features"
              checked={settings.experimentalFeaturesEnabled ?? false}
              onCheckedChange={(checked) =>
                onChange({ ...settings, experimentalFeaturesEnabled: checked })
              }
              data-testid="settings-experimental-features"
            />
            <span className="settings-form__hint settings-form__hint--warning">
              Enables hidden features under active development. Experimental features may change,
              break, or be removed at any time without notice.
            </span>
          </div>
        )}

        {show("restoreLastSessionOnStartup") && (
          <div className="settings-form__field">
            <span className="settings-form__label">Restore Last Session on Startup</span>
            <Toggle
              aria-label="Restore Last Session on Startup"
              checked={settings.restoreLastSessionOnStartup ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, restoreLastSessionOnStartup: checked })
              }
              data-testid="settings-restore-last-session"
            />
            <span className="settings-form__hint">
              Reopen the tabs and panel layout from your previous session when the app starts.
              Sessions that can no longer reconnect are shown in a disconnected state.
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
              <Toggle
                aria-label="Shell Integration by Default"
                checked={settings.defaultShellIntegration ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, defaultShellIntegration: checked })
                }
                data-testid="settings-default-shell-integration"
              />
              <span className="settings-form__hint">
                Pre-enable Shell Integration (OSC 7 CWD tracking) for new SSH connections.
              </span>
            </div>
          )}

          {show("defaultX11Forwarding") && (
            <div className="settings-form__field">
              <span className="settings-form__label">X11 Forwarding by Default</span>
              <Toggle
                aria-label="X11 Forwarding by Default"
                checked={settings.defaultX11Forwarding ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, defaultX11Forwarding: checked })
                }
                data-testid="settings-default-x11-forwarding"
              />
              <span className="settings-form__hint">
                Pre-enable X11 Forwarding for new SSH connections.
              </span>
            </div>
          )}
        </div>
      )}

      {(show("provideXServerAutomatically") || show("stopXServerWhenIdle")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">X Server</h3>

          {show("provideXServerAutomatically") && (
            <div className="settings-form__field">
              <span className="settings-form__label">Provide X Server Automatically</span>
              <Toggle
                aria-label="Provide X Server Automatically"
                checked={settings.provideXServerAutomatically ?? isWindows()}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, provideXServerAutomatically: checked })
                }
                data-testid="settings-provide-x-server"
              />
              <span className="settings-form__hint">
                Windows: download &amp; run VcXsrv automatically. macOS/Linux: use the
                detected/guided server.
              </span>
            </div>
          )}

          {show("stopXServerWhenIdle") && (
            <div className="settings-form__field">
              <span className="settings-form__label">Stop X Server When Idle</span>
              <Toggle
                aria-label="Stop X Server When Idle"
                checked={settings.stopXServerWhenIdle ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, stopXServerWhenIdle: checked })
                }
                data-testid="settings-stop-x-server-idle"
              />
              <span className="settings-form__hint">
                Shut the managed X server down once no connection is using it.
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
