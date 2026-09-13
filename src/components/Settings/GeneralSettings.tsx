import { useCallback, useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { ShellType } from "@/types/terminal";
import { detectAvailableShells } from "@/utils/shell-detection";
import { getWslDistroName } from "@/utils/shell-detection";
import { useAppStore } from "@/store/appStore";
import { isWindows } from "@/utils/platform";
import { shouldOfferGitBashSetup } from "@/utils/gitBashSetup";
import { Select, SelectItem, Toggle, toast } from "@/components/ui";
import { GitBashSetupDialog } from "@/components/OpenConnections/GitBashSetupDialog";
import { setFileLogLevel, getLogFilePath } from "@/services/api";
import { frontendError } from "@/utils/frontendLog";
import { KeyPathInput } from "./KeyPathInput";
import { SettingsField } from "./SettingsField";

/** Human-readable labels for the file-log verbosity levels (OBS-009). */
const LOG_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  error: "Error",
  warn: "Warning",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
};

type FileLogLevel = NonNullable<AppSettings["fileLogLevel"]>;

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

/**
 * A settings change: either the full replacement document or a functional updater
 * `(prev) => next`. The updater form lets a handler read the latest state at apply
 * time rather than spreading a captured render snapshot, so two edits fired
 * back-to-back before a re-render don't clobber each other (#2680).
 */
export type SettingsUpdate = AppSettings | ((prev: AppSettings) => AppSettings);

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

export function GeneralSettings({ settings, onChange, visibleFields }: GeneralSettingsProps) {
  const [availableShells, setAvailableShells] = useState<ShellType[]>([]);
  const [gitBashSetupOpen, setGitBashSetupOpen] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const platformDefaultShell = useAppStore((s) => s.defaultShell);

  // Resolve the log file location once so the control can point a user/supporter
  // straight at the file to read or attach to a bug report (OBS-011).
  useEffect(() => {
    getLogFilePath()
      .then(setLogFilePath)
      .catch(() => setLogFilePath(null));
  }, []);

  // Changing the log level both persists it (through the normal settings
  // document, via onChange) and applies it live to the running app (OBS-009).
  const handleLogLevelChange = useCallback(
    (value: FileLogLevel) => {
      onChange((prev) => ({ ...prev, fileLogLevel: value }));
      setFileLogLevel(value)
        .then(() => toast.success(`Log verbosity set to ${LOG_LEVEL_LABELS[value] ?? value}`))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          frontendError("general_settings", `failed to set log level: ${message}`);
          toast.error(`Failed to change log verbosity: ${message}`);
        });
    },
    [onChange]
  );

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
              onChange={(e) =>
                onChange((prev) => ({ ...prev, defaultUser: e.target.value || undefined }))
              }
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
              onChange={(value) =>
                onChange((prev) => ({ ...prev, defaultSshKeyPath: value || undefined }))
              }
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
                onChange((prev) => ({
                  ...prev,
                  defaultShell: value === PLATFORM_DEFAULT_SHELL ? undefined : value,
                }));
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

        {show("experimentalFeaturesEnabled") && (
          <SettingsField
            label="Allow Experimental Features"
            hint="Enables hidden features under active development. Experimental features may change, break, or be removed at any time without notice."
            hintVariant="warning"
          >
            <Toggle
              checked={settings.experimentalFeaturesEnabled ?? false}
              onCheckedChange={(checked) =>
                onChange((prev) => ({ ...prev, experimentalFeaturesEnabled: checked }))
              }
              data-testid="settings-experimental-features"
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
                  onChange((prev) => ({ ...prev, defaultShellIntegration: checked }))
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
                  onChange((prev) => ({ ...prev, defaultX11Forwarding: checked }))
                }
                data-testid="settings-default-x11-forwarding"
              />
            </SettingsField>
          )}
        </div>
      )}

      {show("fileLogLevel") && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">Diagnostics</h3>

          <SettingsField
            label="Log File Verbosity"
            hint={
              "How much detail termiHub writes to its log file. Raise it to Debug when reporting a bug, then attach or paste the file. " +
              "Info is the default; changes apply immediately and persist across restarts. " +
              (logFilePath ? `Log file: ${logFilePath}. ` : "") +
              "The TERMIHUB_FILE_LOG environment variable overrides this at startup."
            }
          >
            <Select
              value={settings.fileLogLevel ?? "info"}
              onChange={(value) => handleLogLevelChange(value as FileLogLevel)}
              options={[
                { value: "off", label: "Off" },
                { value: "error", label: "Error" },
                { value: "warn", label: "Warning" },
                { value: "info", label: "Info (default)" },
                { value: "debug", label: "Debug" },
                { value: "trace", label: "Trace" },
              ]}
              aria-label="Log file verbosity"
              data-testid="settings-file-log-level"
            />
          </SettingsField>
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
