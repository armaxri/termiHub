import { AppSettings } from "@/types/connection";
import { Select, Toggle } from "@/components/ui";
import {
  CLOSE_LIVE_SESSION_CONFIRM_CHOICES,
  DEFAULT_CLOSE_LIVE_SESSION_CONFIRM,
  resolveCloseConfirm,
  type CloseLiveSessionConfirm,
} from "@/utils/closeConfirm";
import { SettingDefaultMarker } from "./SettingDefaultMarker";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/** Visible label of each close-confirm choice, in sentence case. */
export const CLOSE_CONFIRM_LABELS: Record<CloseLiveSessionConfirm, string> = {
  always: "Always",
  shortcut: "Only for keyboard shortcuts",
  pointer: "Only for mouse closes",
  never: "Never",
};

interface SafetyPromptSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

/**
 * Settings panel section for the confirmation and warning prompts that guard
 * destructive or expensive actions. Split out of the former overloaded "General"
 * category (UX-029). The two overlapping close toggles (shortcut vs. pointer)
 * became one "Ask before closing a live session" choice, so which one wins on
 * Cmd/Ctrl+W is no longer a question (#5844).
 */
export function SafetyPromptSettings({
  settings,
  onChange,
  visibleFields,
}: SafetyPromptSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <>
      {(show("closeLiveSessionConfirm") || show("confirmCloseAttachedTab")) && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Close confirmations</SettingsSectionHeading>

          {show("closeLiveSessionConfirm") && (
            <SettingsField
              label="Ask before closing a live session"
              hint="When closing a tab, panel or group that holds a running session asks first."
              hintTestId="settings-close-live-session-confirm-hint"
              help="Keyboard shortcuts are the close-tab and close-group shortcuts (e.g. Cmd/Ctrl+W). Mouse closes are the tab X, middle-click, the Close menu item and the panel close button. Tabs with nothing running close at once, with Reopen. Unsaved editors always ask."
              helpTestId="settings-close-live-session-confirm-help"
              labelAccessory={
                <SettingDefaultMarker
                  isDefault={settings.closeLiveSessionConfirm === undefined}
                  onReset={() =>
                    onChange((prev) => ({ ...prev, closeLiveSessionConfirm: undefined }))
                  }
                  name="Ask before closing a live session"
                  defaultText={CLOSE_CONFIRM_LABELS[DEFAULT_CLOSE_LIVE_SESSION_CONFIRM]}
                  data-testid="settings-close-live-session-confirm"
                />
              }
            >
              <Select
                value={resolveCloseConfirm(settings)}
                onChange={(value) =>
                  onChange((prev) => ({
                    ...prev,
                    closeLiveSessionConfirm: value as CloseLiveSessionConfirm,
                  }))
                }
                options={CLOSE_LIVE_SESSION_CONFIRM_CHOICES.map((value) => ({
                  value,
                  label: CLOSE_CONFIRM_LABELS[value],
                }))}
                data-testid="settings-close-live-session-confirm"
              />
            </SettingsField>
          )}

          {show("confirmCloseAttachedTab") && (
            <SettingsField
              label="Show a one-time notice when closing a persistent-session tab"
              hint="Show a one-time notice that a persistent session keeps running in the background when its tab is closed (any way, including the keyboard shortcut)."
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

      {show("confirmUndoableDelete") && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Delete confirmations</SettingsSectionHeading>
          <SettingsField
            label="Confirm before deletes that can be undone"
            hint="Ask for confirmation before deleting a connection folder, a custom theme, or an idle tunnel. The Undo toast appears either way."
          >
            <Toggle
              checked={settings.confirmUndoableDelete ?? true}
              onCheckedChange={(checked) =>
                onChange((prev) => ({ ...prev, confirmUndoableDelete: checked }))
              }
              data-testid="settings-confirm-undoable-delete"
            />
          </SettingsField>
        </div>
      )}

      {(show("warnLargePortScan") || show("warnLargePingSweep")) && (
        <div className="settings-panel__category">
          <SettingsSectionHeading>Network operation warnings</SettingsSectionHeading>

          {show("warnLargePortScan") && (
            <SettingsField
              label="Warn before a large port scan"
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
              label="Warn before a large ping sweep"
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
