import { useCallback, useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { resolveRestoreMode } from "@/utils/restoreMode";
import { isWindows } from "@/utils/platform";
import { shouldOfferGitBashSetup } from "@/utils/gitBashSetup";
import { Button, NumberInput, Select, SelectItem, Toggle, toast } from "@/components/ui";
import { GitBashSetupDialog } from "@/components/OpenConnections/GitBashSetupDialog";
import { KeyPathInput } from "./KeyPathInput";
import { SettingsField } from "./SettingsField";

/** Sentinel value for the "platform default" shell option (Radix Select forbids empty-string item values). */
const PLATFORM_DEFAULT_SHELL = "__platform_default__";

/** Sentinel value for the "Git Bash — set up…" row that launches the guided install (#1672). */
const GIT_BASH_SETUP = "__git_bash_setup__";

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
  const [gitBashSetupOpen, setGitBashSetupOpen] = useState(false);
  const platformDefaultShell = useAppStore((s) => s.defaultShell);
  const historyCount = useAppStore((s) => s.sessionHistory.length);
  const clearSessionHistory = useAppStore((s) => s.clearSessionHistory);

  const refreshShells = useCallback(() => {
    detectAvailableShells().then(setAvailableShells);
  }, []);

  useEffect(() => {
    refreshShells();
  }, [refreshShells]);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  // Windows-only: when no Unix shell is detected, offer a guided Git-for-Windows
  // install instead of silently leaving bash unavailable (#1672).
  const offerGitBashSetup = shouldOfferGitBashSetup(isWindows(), availableShells);

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
              onChange={(value) => {
                // The "set up…" row launches the guided install rather than
                // selecting a shell — leave the current default untouched.
                if (value === GIT_BASH_SETUP) {
                  setGitBashSetupOpen(true);
                  return;
                }
                onChange({
                  ...settings,
                  defaultShell: value === PLATFORM_DEFAULT_SHELL ? undefined : value,
                });
              }}
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
              {offerGitBashSetup && (
                <SelectItem value={GIT_BASH_SETUP}>Git Bash — set up…</SelectItem>
              )}
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

        {show("warnLargePortScan") && (
          <SettingsField
            label="Warn Before a Large Port Scan"
            hint="Show a warning before starting a Port Scanner scan that probes a very large number of host/port combinations."
          >
            <Toggle
              checked={settings.warnLargePortScan ?? true}
              onCheckedChange={(checked) => onChange({ ...settings, warnLargePortScan: checked })}
              data-testid="settings-warn-large-port-scan"
            />
          </SettingsField>
        )}

        {show("warnLargePingSweep") && (
          <SettingsField
            label="Warn Before a Large Ping Sweep"
            hint="Show a warning before starting a Ping Sweep across a very large number of hosts (e.g. a wide CIDR block)."
          >
            <Toggle
              checked={settings.warnLargePingSweep ?? true}
              onCheckedChange={(checked) => onChange({ ...settings, warnLargePingSweep: checked })}
              data-testid="settings-warn-large-ping-sweep"
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
            hint="Choose how the tabs and panel layout from your previous session are handled when the app starts. Never starts fresh; Ask offers a restore dialog; Always restores silently. Sessions that can no longer reconnect are shown in a disconnected state."
          >
            <Select
              value={resolveRestoreMode(settings)}
              onChange={(value) =>
                onChange({
                  ...settings,
                  restoreLastSessionMode: value as "never" | "ask" | "always",
                })
              }
              options={[
                { value: "never", label: "Never" },
                { value: "ask", label: "Ask each time" },
                { value: "always", label: "Always" },
              ]}
              aria-label="Restore last session on startup"
              data-testid="settings-restore-last-session-mode"
            />
          </SettingsField>
        )}
      </div>

      {(show("sessionHistoryEnabled") ||
        show("sessionHistoryLimit") ||
        show("showRecentSessions")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">Session History</h3>

          {show("sessionHistoryEnabled") && (
            <SettingsField
              label="Auto-Save Sessions to History"
              hint="Record every session you open so it can be reconnected from the Recent Sessions panel. Passwords are never stored in history."
            >
              <Toggle
                checked={settings.sessionHistoryEnabled ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, sessionHistoryEnabled: checked })
                }
                data-testid="settings-session-history-enabled"
              />
            </SettingsField>
          )}

          {show("sessionHistoryLimit") && (
            <SettingsField
              label="Session History Limit"
              hint="Maximum number of recent sessions to keep (10–500). When the limit is reached, the least-recently-used unpinned entry is removed."
            >
              <NumberInput
                value={settings.sessionHistoryLimit ?? 50}
                onValueChange={(value) =>
                  onChange({
                    ...settings,
                    sessionHistoryLimit: value === "" ? undefined : value,
                  })
                }
                min={10}
                max={500}
                data-testid="settings-session-history-limit"
              />
            </SettingsField>
          )}

          {show("showRecentSessions") && (
            <SettingsField
              label="Show Recent Sessions Panel"
              hint="Show the Recent Sessions sidebar panel and its activity-bar icon."
            >
              <Toggle
                checked={settings.showRecentSessions ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, showRecentSessions: checked })
                }
                data-testid="settings-show-recent-sessions"
              />
            </SettingsField>
          )}

          {show("sessionHistoryEnabled") && (
            <SettingsField
              label="Clear Session History"
              hint="Remove all recorded sessions, including pinned entries."
            >
              <Button
                variant="danger"
                size="sm"
                disabled={historyCount === 0}
                data-testid="settings-clear-session-history"
                onClick={async () => {
                  await clearSessionHistory();
                  toast.success("Cleared session history");
                }}
              >
                Clear All History
              </Button>
            </SettingsField>
          )}
        </div>
      )}

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

      <GitBashSetupDialog
        open={gitBashSetupOpen}
        onOpenChange={(open) => {
          setGitBashSetupOpen(open);
          // Re-detect on close so a just-installed Git Bash appears without an
          // app restart (#1672).
          if (!open) refreshShells();
        }}
        onInstallGuided={refreshShells}
      />
    </>
  );
}
