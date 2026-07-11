import { useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { isWindows } from "@/utils/platform";
import { Select, SelectItem, Toggle } from "@/components/ui";
import { KeyPathInput } from "./KeyPathInput";
import { SettingsField } from "./SettingsField";

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
          <SettingsField
            label="Default User"
            hint="Default username pre-filled for new SSH connections."
          >
            <input
              type="text"
              value={settings.defaultUser ?? ""}
              onChange={(e) => onChange({ ...settings, defaultUser: e.target.value || undefined })}
              placeholder="e.g. admin"
              data-testid="settings-default-user"
            />
          </SettingsField>
        )}

        {show("defaultSshKeyPath") && (
          <SettingsField
            label="Default SSH Key Path"
            hint="Default private key path for SSH key authentication."
          >
            <KeyPathInput
              value={settings.defaultSshKeyPath ?? ""}
              onChange={(value) => onChange({ ...settings, defaultSshKeyPath: value || undefined })}
              placeholder="~/.ssh/id_ed25519"
              testIdPrefix="general-settings"
            />
          </SettingsField>
        )}

        {show("defaultShell") && (
          <SettingsField
            label="Default Shell"
            hint="Default shell for new local terminal sessions."
          >
            <Select
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
          </SettingsField>
        )}

        {show("confirmCloseTabOnShortcut") && (
          <SettingsField
            label="Confirm Close Tab on Shortcut"
            hint="Ask for confirmation when closing a tab or tab group via keyboard shortcut."
          >
            <Toggle
              checked={settings.confirmCloseTabOnShortcut ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, confirmCloseTabOnShortcut: checked })
              }
              data-testid="settings-confirm-close-tab-on-shortcut"
            />
          </SettingsField>
        )}

        {show("confirmCloseLiveSession") && (
          <SettingsField
            label="Confirm Closing a Live Session"
            hint="Ask for confirmation before closing a tab (X or middle-click) or split panel that holds a live SSH, serial, or shell session."
          >
            <Toggle
              checked={settings.confirmCloseLiveSession ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, confirmCloseLiveSession: checked })
              }
              data-testid="settings-confirm-close-live-session"
            />
          </SettingsField>
        )}

        {show("experimentalFeaturesEnabled") && (
          <SettingsField
            label="Allow Experimental Features"
            hint="Enables hidden features under active development. Experimental features may change, break, or be removed at any time without notice."
            hintVariant="warning"
          >
            <Toggle
              checked={settings.experimentalFeaturesEnabled ?? false}
              onCheckedChange={(checked) =>
                onChange({ ...settings, experimentalFeaturesEnabled: checked })
              }
              data-testid="settings-experimental-features"
            />
          </SettingsField>
        )}

        {show("restoreLastSessionOnStartup") && (
          <SettingsField
            label="Restore Last Session on Startup"
            hint="Reopen the tabs and panel layout from your previous session when the app starts. Sessions that can no longer reconnect are shown in a disconnected state."
          >
            <Toggle
              checked={settings.restoreLastSessionOnStartup ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, restoreLastSessionOnStartup: checked })
              }
              data-testid="settings-restore-last-session"
            />
          </SettingsField>
        )}
      </div>

      {(show("defaultShellIntegration") || show("defaultX11Forwarding")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">SSH Defaults</h3>

          {show("defaultShellIntegration") && (
            <SettingsField
              label="Shell Integration by Default"
              hint="Pre-enable Shell Integration (OSC 7 CWD tracking) for new SSH connections."
            >
              <Toggle
                checked={settings.defaultShellIntegration ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, defaultShellIntegration: checked })
                }
                data-testid="settings-default-shell-integration"
              />
            </SettingsField>
          )}

          {show("defaultX11Forwarding") && (
            <SettingsField
              label="X11 Forwarding by Default"
              hint="Pre-enable X11 Forwarding for new SSH connections."
            >
              <Toggle
                checked={settings.defaultX11Forwarding ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, defaultX11Forwarding: checked })
                }
                data-testid="settings-default-x11-forwarding"
              />
            </SettingsField>
          )}
        </div>
      )}

      {(show("provideXServerAutomatically") || show("stopXServerWhenIdle")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">X Server</h3>

          {show("provideXServerAutomatically") && (
            <SettingsField
              label="Provide X Server Automatically"
              hint="Windows: download & run VcXsrv automatically. macOS/Linux: use the detected/guided server."
            >
              <Toggle
                checked={settings.provideXServerAutomatically ?? isWindows()}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, provideXServerAutomatically: checked })
                }
                data-testid="settings-provide-x-server"
              />
            </SettingsField>
          )}

          {show("stopXServerWhenIdle") && (
            <SettingsField
              label="Stop X Server When Idle"
              hint="Shut the managed X server down once no connection is using it."
            >
              <Toggle
                checked={settings.stopXServerWhenIdle ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, stopXServerWhenIdle: checked })
                }
                data-testid="settings-stop-x-server-idle"
              />
            </SettingsField>
          )}
        </div>
      )}
    </>
  );
}
