import { useState, useEffect } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/store/appStore";
import { setUpdateAutoCheck, getAppInfo, type AppInfo } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import "./UpdateSettings.css";

interface UpdateSettingsProps {
  visibleFields?: Set<string>;
}

function formatCheckTime(iso?: string): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Settings page section for update configuration and status. */
export function UpdateSettings({ visibleFields }: UpdateSettingsProps) {
  const updateCheckState = useAppStore((s) => s.updateCheckState);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const clearSkippedUpdateVersion = useAppStore((s) => s.clearSkippedUpdateVersion);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [savingAutoCheck, setSavingAutoCheck] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  const autoCheck = settings.updates?.autoCheck ?? true;
  const lastCheckTime = settings.updates?.lastCheckTime;
  const skippedVersion = settings.updates?.skippedVersion;

  const isChecking = updateCheckState === "checking";

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
      frontendLog("update", `Failed to save auto-check preference: ${err}`);
    } finally {
      setSavingAutoCheck(false);
    }
  };

  const handleOpenDownloads = () => {
    if (updateInfo?.releaseUrl) {
      openUrl(updateInfo.releaseUrl).catch((err) =>
        frontendLog("update", `Failed to open release URL: ${err}`)
      );
    }
  };

  const handleClearSkipped = async () => {
    await clearSkippedUpdateVersion();
  };

  if (!show("updateAutoCheck") && !show("updateStatus")) return null;

  return (
    <div className="settings-panel__category" data-testid="update-settings">
      <h3 className="settings-panel__category-title">Updates</h3>

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
            </div>

            <div className="update-settings__row">
              <span className="update-settings__label">Latest version</span>
              <span>
                {updateCheckState === "available" && updateInfo?.available ? (
                  <span className="update-settings__available" data-testid="update-latest-version">
                    <span
                      className={`update-indicator__dot update-indicator__dot--${updateInfo.isSecurity ? "red" : "amber"}`}
                    />
                    v{updateInfo.latestVersion}
                    {updateInfo.isSecurity && (
                      <span className="update-settings__security-badge">Security</span>
                    )}
                  </span>
                ) : updateCheckState === "up-to-date" ? (
                  <span className="update-settings__up-to-date" data-testid="update-latest-version">
                    Up to date
                  </span>
                ) : updateCheckState === "error" ? (
                  <span className="update-settings__error" data-testid="update-latest-version">
                    Check failed
                  </span>
                ) : (
                  <span data-testid="update-latest-version">—</span>
                )}
              </span>
            </div>

            <div className="update-settings__row">
              <span className="update-settings__label">Last checked</span>
              <span data-testid="update-last-checked">{formatCheckTime(lastCheckTime)}</span>
            </div>
          </div>

          <div className="update-settings__actions">
            <button
              className="settings-panel__btn"
              onClick={() => checkForUpdates(true)}
              disabled={isChecking}
              data-testid="update-check-now"
            >
              {isChecking ? (
                <Loader2 size={12} className="settings-panel__spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              {isChecking ? "Checking…" : "Check Now"}
            </button>
            {updateCheckState === "available" && updateInfo?.available && (
              <button
                className="settings-panel__btn settings-panel__btn--primary"
                onClick={handleOpenDownloads}
                data-testid="update-open-downloads"
              >
                Open Downloads Page
              </button>
            )}
          </div>
        </div>
      )}

      {show("updateAutoCheck") && (
        <div className="settings-panel__section">
          <h3 className="settings-panel__section-title">Auto-check for updates</h3>
          <div className="settings-panel__radio-group" role="radiogroup">
            <button
              role="radio"
              aria-checked={autoCheck}
              className={`settings-panel__radio-option${autoCheck ? " settings-panel__radio-option--active" : ""}`}
              onClick={() => !savingAutoCheck && handleAutoCheckToggle(true)}
              disabled={savingAutoCheck}
              data-testid="update-auto-check-on"
            >
              <div className="settings-panel__radio-option-label">On startup</div>
              <p className="settings-panel__radio-option-desc">
                Check for updates on startup and every 24 hours while running.
              </p>
            </button>
            <button
              role="radio"
              aria-checked={!autoCheck}
              className={`settings-panel__radio-option${!autoCheck ? " settings-panel__radio-option--active" : ""}`}
              onClick={() => !savingAutoCheck && handleAutoCheckToggle(false)}
              disabled={savingAutoCheck}
              data-testid="update-auto-check-off"
            >
              <div className="settings-panel__radio-option-label">Never</div>
              <p className="settings-panel__radio-option-desc">
                Disable automatic checks. Use &ldquo;Check Now&rdquo; to check manually.
              </p>
            </button>
          </div>
        </div>
      )}

      {skippedVersion && (
        <div className="settings-panel__section">
          <div className="update-settings__row">
            <span className="update-settings__label">Skipped version</span>
            <span className="update-settings__skipped-row">
              v{skippedVersion}
              <button
                className="settings-panel__btn"
                onClick={handleClearSkipped}
                data-testid="update-clear-skipped"
              >
                Clear
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
