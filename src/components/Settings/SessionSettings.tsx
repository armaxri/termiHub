import { useState, useEffect } from "react";
import { AppSettings } from "@/types/connection";
import { useAppStore } from "@/store/appStore";
import { resolveRestoreMode, type RestoreLastSessionMode } from "@/utils/restoreMode";
import { Button, NumberInput, Select, Toggle, toast } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";

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
          <h3 className="settings-panel__category-title">Restore</h3>

          <SettingsField
            label="Restore Last Session on Startup"
            hint="Choose how the tabs and panel layout from your previous session are handled when the app starts. Never starts fresh; Ask offers a restore dialog; Always restores silently. Sessions that can no longer reconnect are shown in a disconnected state."
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
          <h3 className="settings-panel__category-title">Session History</h3>

          {show("sessionHistoryEnabled") && (
            <SettingsField
              label="Auto-Save Sessions to History"
              hint="Record every session you open so it can be reconnected from the Recent Sessions panel. Passwords are never stored in history."
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
              label="Session History Limit"
              hint="Maximum number of recent sessions to keep (10–500). When the limit is reached, the least-recently-used unpinned entry is removed."
            >
              <NumberInput
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
              label="Show Recent Sessions Panel"
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
    </>
  );
}
