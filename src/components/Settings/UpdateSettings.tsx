import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { setUpdateAutoCheck } from "@/services/api";
import { useAppInfo } from "@/hooks/useAppInfo";
import { frontendLog } from "@/utils/frontendLog";
import { safeOpenExternal } from "@/utils/safeOpenExternal";
import { resolveUiLocale } from "@/utils/locale";
import { formatBuildDate } from "@/utils/formatters";
import { Button, RadioGroup, Spinner, StatusDot, Tooltip, toast } from "@/components/ui";
import { errorMessage } from "@/utils/errorMessage";
import {
  capitalize,
  describeDevelopBuild,
  isDevelopUpdate,
} from "@/components/UpdateNotification/developUpdate";
import { AppUpdateInstallActions } from "@/components/UpdateNotification/AppUpdateInstallActions";
import { isInAppUpdate, releasePageHint } from "@/components/UpdateNotification/installRoute";
import "./UpdateSettings.css";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

interface UpdateSettingsProps {
  visibleFields?: Set<string>;
}

function formatCheckTime(iso?: string): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString(resolveUiLocale());
  } catch {
    return iso;
  }
}

/** Settings page section for update configuration and status. */
export function UpdateSettings({ visibleFields }: UpdateSettingsProps) {
  const updateCheckState = useAppStore((s) => s.updateCheckState);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const failureReason = useAppStore((s) => s.updateCheckFailureReason);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const clearSkippedUpdateVersion = useAppStore((s) => s.clearSkippedUpdateVersion);
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [savingAutoCheck, setSavingAutoCheck] = useState(false);
  const appInfo = useAppInfo();
  // Commit time of this build (#5652); empty when unknown or unparseable, which
  // hides the row rather than rendering "Invalid Date".
  const buildDate = formatBuildDate(appInfo?.buildCommitTime);

  const autoCheck = settings.updates?.autoCheck ?? true;
  const lastCheckTime = settings.updates?.lastCheckTime;
  const skippedVersion = settings.updates?.skippedVersion;

  const isChecking = updateCheckState === "checking";
  const isDevelop = isDevelopUpdate(updateInfo);
  // The backend says so explicitly (#5651) — never inferred from other fields.
  const notChecked = updateInfo?.outcome === "notChecking";
  const showUpdateActions = updateCheckState === "available" && updateInfo?.available === true;
  // In place through the signed updater where it applies (#5758); otherwise
  // the downloads page, with a hint when the reason is worth knowing.
  const inApp = showUpdateActions && isInAppUpdate(updateInfo);
  const installHint = showUpdateActions ? releasePageHint(updateInfo?.releasePageReason) : null;

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  const handleAutoCheckToggle = async (enabled: boolean) => {
    setSavingAutoCheck(true);
    try {
      await setUpdateAutoCheck(enabled);
      const newSettings = {
        ...settings,
        updates: { ...settings.updates, autoCheck: enabled },
      };
      await updateSettings(newSettings);
    } catch (err) {
      frontendLog("update", `Failed to save auto-check preference: ${errorMessage(err)}`);
    } finally {
      setSavingAutoCheck(false);
    }
  };

  const handleOpenDownloads = async () => {
    if (!updateInfo?.releaseUrl) return;
    try {
      const opened = await safeOpenExternal(updateInfo.releaseUrl);
      if (!opened) {
        throw new Error("Could not open the downloads page in your browser.");
      }
    } catch (err) {
      frontendLog("update", `Failed to open release URL: ${errorMessage(err)}`);
      throw err;
    }
  };

  // The single home for build info now that the per-page footer is gone (#5561):
  // one click copies version and commit for a bug report.
  const handleCopyBuildInfo = async () => {
    if (!appInfo) return;
    // The copied text keeps the raw UTC commit time: unambiguous in a bug report
    // whatever the reader's locale or time zone (#5652).
    const commitTime = buildDate && appInfo.buildCommitTime;
    const build = commitTime ? `${appInfo.gitHash}, commit time ${commitTime}` : appInfo.gitHash;
    const text = `termiHub v${appInfo.version}${appInfo.isDev ? " [DEV]" : ""} (${build})`;
    try {
      // Tauri clipboard plugin: navigator.clipboard rejects on macOS/WKWebView
      // when the window is not focused (#4327).
      await writeText(text);
      toast.success("Build info copied to clipboard");
    } catch (err) {
      const message = errorMessage(err);
      frontendLog("update", `Failed to copy build info: ${message}`);
      toast.error(`Failed to copy build info: ${message}`);
      throw err;
    }
  };

  const handleClearSkipped = async () => {
    await clearSkippedUpdateVersion();
  };

  if (!show("updateAutoCheck") && !show("updateStatus")) return null;

  return (
    <div className="settings-panel__category" data-testid="update-settings">
      <SettingsSectionHeading>Updates</SettingsSectionHeading>

      {show("updateStatus") && (
        <div className="settings-panel__section">
          <div className="update-settings__info-table">
            <div className="update-settings__row">
              <span className="update-settings__label">Current version</span>
              <span data-testid="update-current-version">
                {appInfo ? `v${appInfo.version}` : "—"}
              </span>
            </div>
            <div className="update-settings__row">
              <span className="update-settings__label">Build</span>
              <span
                className="update-settings__build-hash"
                data-testid="update-build-hash"
                title="Git commit hash"
              >
                {appInfo ? appInfo.gitHash : "—"}
              </span>
              {appInfo && (
                <Tooltip content="Copy version and build">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Copy size={12} />}
                    onClick={handleCopyBuildInfo}
                    aria-label="Copy version and build"
                    data-testid="update-copy-build-info"
                  />
                </Tooltip>
              )}
            </div>
            {buildDate && (
              <div className="update-settings__row">
                <span className="update-settings__label">Build date</span>
                <span data-testid="update-build-date" title="Commit time of this build">
                  {buildDate}
                </span>
              </div>
            )}

            <div className="update-settings__row">
              <span className="update-settings__label">
                {isDevelop ? "Latest develop build" : "Latest version"}
              </span>
              <span>
                {updateCheckState === "available" && updateInfo?.available && isDevelop ? (
                  <span className="update-settings__available" data-testid="update-latest-version">
                    <StatusDot tone="notice" size="sm" className="update-indicator__dot" />
                    {capitalize(describeDevelopBuild(updateInfo))}
                  </span>
                ) : updateCheckState === "available" && updateInfo?.available ? (
                  <span className="update-settings__available" data-testid="update-latest-version">
                    <StatusDot
                      tone={updateInfo.isSecurity ? "error" : "notice"}
                      size="sm"
                      className="update-indicator__dot"
                    />
                    v{updateInfo.latestVersion}
                    {updateInfo.isSecurity && (
                      <span className="update-settings__security-badge">Security</span>
                    )}
                  </span>
                ) : updateCheckState === "up-to-date" && notChecked ? (
                  <span data-testid="update-latest-version">Not checked for this build</span>
                ) : updateCheckState === "up-to-date" && lastCheckTime ? (
                  <span className="update-settings__up-to-date" data-testid="update-latest-version">
                    Up to date
                  </span>
                ) : updateCheckState === "error" ? (
                  <span
                    className="update-settings__error"
                    data-testid="update-latest-version"
                    title={failureReason ?? undefined}
                  >
                    Check failed
                  </span>
                ) : isChecking ? (
                  <span data-testid="update-latest-version">Checking…</span>
                ) : (
                  // "Up to date" is only claimed after a completed, timestamped
                  // check (#5615); before that the page says so honestly.
                  <span data-testid="update-latest-version">
                    {lastCheckTime ? "Not checked since launch" : "Not checked yet"}
                  </span>
                )}
              </span>
            </div>

            <div className="update-settings__row">
              <span className="update-settings__label">Last checked</span>
              <span data-testid="update-last-checked">{formatCheckTime(lastCheckTime)}</span>
            </div>
          </div>

          <div className="update-settings__actions">
            <Button
              variant="secondary"
              size="sm"
              icon={isChecking ? <Spinner size="xs" label={null} /> : <RefreshCw size={12} />}
              onClick={() => checkForUpdates(true)}
              disabled={isChecking}
              data-testid="update-check-now"
            >
              {isChecking ? "Checking…" : "Check now"}
            </Button>
            {inApp && <AppUpdateInstallActions testIdPrefix="update-install" />}
            {showUpdateActions && (
              <Button
                variant={inApp ? "secondary" : "primary"}
                size="sm"
                onClick={handleOpenDownloads}
                data-testid="update-open-downloads"
              >
                {isDevelop ? "Open download page" : "Open downloads page"}
              </Button>
            )}
          </div>
          {installHint && (
            <p className="update-settings__install-hint" data-testid="update-install-hint">
              {installHint}
            </p>
          )}
        </div>
      )}

      {show("updateAutoCheck") && (
        <div className="settings-panel__section">
          <SettingsSectionHeading id="update-auto-check-title">
            Auto-check for updates
          </SettingsSectionHeading>
          <RadioGroup
            variant="cards"
            className="settings-panel__radio-group"
            value={autoCheck ? "on" : "off"}
            onValueChange={(v) => {
              if (!savingAutoCheck) void handleAutoCheckToggle(v === "on");
            }}
            disabled={savingAutoCheck}
            aria-labelledby="update-auto-check-title"
            data-testid="update-auto-check-group"
            options={[
              {
                value: "on",
                label: "On startup",
                description: "Check for updates on startup and every 24 hours while running.",
                "data-testid": "update-auto-check-on",
              },
              {
                value: "off",
                label: "Never",
                description: (
                  <>Disable automatic checks. Use &ldquo;Check now&rdquo; to check manually.</>
                ),
                "data-testid": "update-auto-check-off",
              },
            ]}
          />
        </div>
      )}

      {skippedVersion && (
        <div className="settings-panel__section">
          <div className="update-settings__row">
            <span className="update-settings__label">Skipped version</span>
            <span className="update-settings__skipped-row">
              v{skippedVersion}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClearSkipped}
                data-testid="update-clear-skipped"
              >
                Clear
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
