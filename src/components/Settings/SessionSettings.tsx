import { useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { useAppStore } from "@/store/appStore";
import { useNetworkToolHistoryStore } from "@/store/networkToolHistoryStore";
import { clearHttpMonitorHistory } from "@/services/networkHistoryApi";
import { resolveRestoreMode, type RestoreLastSessionMode } from "@/utils/restoreMode";
import { Button, Select, Toggle, toast } from "@/components/ui";
import { SettingsNumberInput } from "./SettingsNumberInput";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

interface SessionSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

/**
 * Settings panel section for session lifecycle: startup restore behavior and the
 * Recent Sessions history. Split out of the former overloaded "General" category
 * (UX-029) so users hunting for session/restore behavior can find it in the nav.
 */
export function SessionSettings({ settings, onChange, visibleFields }: SessionSettingsProps) {
  const historyCount = useAppStore((s) => s.sessionHistory.length);
  const clearSessionHistory = useAppStore((s) => s.clearSessionHistory);
  const clearNetworkToolHistory = useNetworkToolHistoryStore((s) => s.clear);

  // The restore-mode decision now lives in `core::restore_mode` (#2200), so the
  // dropdown value is resolved asynchronously via the `restore_resolve_mode`
  // command. Seed with the explicit mode when set (the common case, no flicker);
  // the effect below then authoritatively resolves the legacy-boolean migration.
  const explicitMode = settings.restoreLastSessionMode;
  const [restoreMode, setRestoreMode] = useState<RestoreLastSessionMode>(
    explicitMode === "never" || explicitMode === "always" ? explicitMode : "ask"
  );
  useEffect(() => {
    let active = true;
    void resolveRestoreMode(settings).then((mode) => {
      if (active) setRestoreMode(mode);
    });
    return () => {
      active = false;
    };
  }, [settings]);

  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <>
      {show("restoreLastSessionOnStartup") && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Restore</SettingsSectionHeading>

          <SettingsField
            label="Restore last session on startup"
            hint="What happens to your previous session's tabs and layout at startup."
            help="Never starts fresh; Ask offers a restore dialog; Always restores silently. Sessions that can no longer reconnect are shown in a disconnected state."
            helpTestId="settings-restore-last-session-mode-help"
          >
            <Select
              value={restoreMode}
              onChange={(value) =>
                onChange((prev) => ({
                  ...prev,
                  restoreLastSessionMode: value as "never" | "ask" | "always",
                }))
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
        </div>
      )}

      {(show("sessionHistoryEnabled") ||
        show("sessionHistoryLimit") ||
        show("showRecentSessions")) && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Session history</SettingsSectionHeading>

          {show("sessionHistoryEnabled") && (
            <SettingsField
              label="Auto-save sessions to history"
              hint="Record each session you open. Passwords are never stored."
              help="Recorded sessions can be reconnected from the Recent Sessions panel."
              helpTestId="settings-session-history-enabled-help"
            >
              <Toggle
                checked={settings.sessionHistoryEnabled ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, sessionHistoryEnabled: checked }))
                }
                data-testid="settings-session-history-enabled"
              />
            </SettingsField>
          )}

          {show("sessionHistoryLimit") && (
            <SettingsField
              label="Session history limit"
              hint="Recent sessions to keep (10–500)."
              help="When the limit is reached, the least recently used unpinned entry is removed."
              helpTestId="settings-session-history-limit-help"
            >
              <SettingsNumberInput
                unit="sessions"
                value={settings.sessionHistoryLimit ?? 50}
                onValueChange={(value) =>
                  onChange((prev) => ({
                    ...prev,
                    sessionHistoryLimit: value === "" ? undefined : value,
                  }))
                }
                min={10}
                max={500}
                data-testid="settings-session-history-limit"
              />
            </SettingsField>
          )}

          {show("showRecentSessions") && (
            <SettingsField
              label="Show recent sessions panel"
              hint="Show the Recent Sessions sidebar panel and its activity-bar icon."
            >
              <Toggle
                checked={settings.showRecentSessions ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, showRecentSessions: checked }))
                }
                data-testid="settings-show-recent-sessions"
              />
            </SettingsField>
          )}

          {show("sessionHistoryEnabled") && (
            <SettingsField
              label="Clear session history"
              hint="Remove all recorded sessions, including pinned entries."
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={historyCount === 0}
                data-testid="settings-clear-session-history"
                onClick={async () => {
                  await clearSessionHistory();
                }}
              >
                Clear all history
              </Button>
            </SettingsField>
          )}
        </div>
      )}

      {show("networkToolHistoryEnabled") && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Network tool history</SettingsSectionHeading>

          <SettingsField
            label="Record network tool history"
            hint="Keep finished network tool runs and HTTP monitor checks on this computer."
            help={
              <>
                Ping, traceroute, port scan, ping sweep, DNS, open-ports and Wake-on-LAN runs can be
                revisited, re-run and exported from each tool&apos;s History section, and each HTTP
                monitor&apos;s chart survives a stop or restart. Results can contain hostnames and
                IP addresses. The newest 50 runs per tool are kept for up to 30 days, and the newest
                1,000 checks per monitor for up to 7 days.
              </>
            }
            helpTestId="settings-network-tool-history-help"
          >
            <Toggle
              checked={settings.networkToolHistoryEnabled ?? true}
              onCheckedChange={(checked) =>
                onChange((prev) => ({ ...prev, networkToolHistoryEnabled: checked }))
              }
              data-testid="settings-network-tool-history-enabled"
            />
          </SettingsField>

          <SettingsField
            label="Clear network tool history"
            hint="Remove every recorded network tool run and HTTP monitor check."
          >
            <Button
              variant="secondary"
              size="sm"
              data-testid="settings-clear-network-tool-history"
              onClick={async () => {
                await Promise.all([clearNetworkToolHistory(), clearHttpMonitorHistory()]);
                // toast-policy: off-screen — the cleared history lives in the network tools view
                toast.success("Cleared network tool history");
              }}
            >
              Clear network tool history
            </Button>
          </SettingsField>
        </div>
      )}
    </>
  );
}
