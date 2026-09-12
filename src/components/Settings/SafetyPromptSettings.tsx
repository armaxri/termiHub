import { AppSettings } from "@/types/connection";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";

interface SafetyPromptSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

/**
 * Settings panel section for the confirmation and warning prompts that guard
 * destructive or expensive actions. Split out of the former overloaded "General"
 * category (UX-029); the three near-identical close toggles are grouped under a
 * "Close confirmations" sub-header so their differing triggers read clearly
 * (UX-030).
 */
export function SafetyPromptSettings({
  settings,
  onChange,
  visibleFields,
}: SafetyPromptSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <>
      {(show("confirmCloseTabOnShortcut") ||
        show("confirmCloseLiveSession") ||
        show("confirmCloseAttachedTab")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">Close confirmations</h3>

          {show("confirmCloseTabOnShortcut") && (
            <SettingsField
              label="Confirm before closing a tab via keyboard shortcut"
              hint="Ask for confirmation when closing a tab or tab group via keyboard shortcut."
            >
              <Toggle
                checked={settings.confirmCloseTabOnShortcut ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, confirmCloseTabOnShortcut: checked }))
                }
                data-testid="settings-confirm-close-tab-on-shortcut"
              />
            </SettingsField>
          )}

          {show("confirmCloseLiveSession") && (
            <SettingsField
              label="Confirm before closing a tab with a live session"
              hint="Ask for confirmation before closing a tab (X or middle-click) or split panel that holds a live SSH, serial, or shell session."
            >
              <Toggle
                checked={settings.confirmCloseLiveSession ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, confirmCloseLiveSession: checked }))
                }
                data-testid="settings-confirm-close-live-session"
              />
            </SettingsField>
          )}

          {show("confirmCloseAttachedTab") && (
            <SettingsField
              label="Show a one-time notice when closing a persistent-session tab"
              hint="Show a one-time notice that a persistent session keeps running in the background when its tab is closed (X or middle-click)."
            >
              <Toggle
                checked={settings.confirmCloseAttachedTab ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, confirmCloseAttachedTab: checked }))
                }
                data-testid="settings-confirm-close-attached-tab"
              />
            </SettingsField>
          )}
        </div>
      )}

      {(show("warnLargePortScan") || show("warnLargePingSweep")) && (
        <div className="settings-panel__category">
          <h3 className="settings-panel__category-title">Network operation warnings</h3>

          {show("warnLargePortScan") && (
            <SettingsField
              label="Warn Before a Large Port Scan"
              hint="Show a warning before starting a Port Scanner scan that probes a very large number of host/port combinations."
            >
              <Toggle
                checked={settings.warnLargePortScan ?? true}
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, warnLargePortScan: checked }))
                }
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
                onCheckedChange={(checked) =>
                  onChange((prev) => ({ ...prev, warnLargePingSweep: checked }))
                }
                data-testid="settings-warn-large-ping-sweep"
              />
            </SettingsField>
          )}
        </div>
      )}
    </>
  );
}
