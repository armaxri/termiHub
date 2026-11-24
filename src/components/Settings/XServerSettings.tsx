import { AppSettings } from "@/types/connection";
import { getPlatform, type Platform } from "@/utils/platform";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

interface XServerSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
  /** Host platform. Defaults to the detected one; injected by tests (#5844). */
  platform?: Platform;
}

/**
 * What "Provide X server automatically" does on each platform (#5844). Only
 * the current platform's line is shown, never a dump of all three.
 */
export const PROVIDE_X_SERVER_HINTS: Record<Platform, string> = {
  windows: "Download and start VcXsrv when an X11 session needs it.",
  macos: "Start XQuartz when an X11 session needs it, and offer to install it if missing.",
  linux: "Use your desktop's X server, with a hint when none can be reached.",
};

/** Shown under "Stop X server when idle" while its parent is off. */
export const STOP_X_SERVER_INACTIVE_HINT =
  "Only applies while termiHub provides the X server. Turn that on above to change it.";

/**
 * Whether "Provide X server automatically" is on. Unset follows the platform
 * default the backend uses (`resolve_provide_automatically`): on for Windows,
 * off elsewhere.
 */
export function providesXServer(settings: AppSettings, platform: Platform): boolean {
  return settings.provideXServerAutomatically ?? platform === "windows";
}

/**
 * Settings panel section for the automatically-managed local X server used for
 * X11 forwarding. Split out of the former overloaded "General" category (UX-029)
 * so X-server behavior is discoverable in the nav.
 *
 * "Stop X server when idle" only matters for a server termiHub started, so it
 * sits nested under "Provide X server automatically" and, while that is off,
 * is disabled and shows its effective state — off — instead of a stored "on"
 * that does nothing (#5844). The stored value is kept for when it applies again.
 */
export function XServerSettings({
  settings,
  onChange,
  visibleFields,
  platform = getPlatform(),
}: XServerSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  if (!show("provideXServerAutomatically") && !show("stopXServerWhenIdle")) {
    return null;
  }

  const provides = providesXServer(settings, platform);
  const stopWhenIdle = settings.stopXServerWhenIdle ?? true;

  return (
    <div className="settings-panel__category">
      <SettingsSectionHeading>X server</SettingsSectionHeading>

      {show("provideXServerAutomatically") && (
        <SettingsField
          label="Provide X server automatically"
          hint={PROVIDE_X_SERVER_HINTS[platform]}
          hintTestId="settings-provide-x-server-hint"
        >
          <Toggle
            checked={provides}
            onCheckedChange={(checked) =>
              onChange((prev) => ({ ...prev, provideXServerAutomatically: checked }))
            }
            data-testid="settings-provide-x-server"
          />
        </SettingsField>
      )}

      {show("stopXServerWhenIdle") && (
        <div className="settings-panel__nested" data-testid="settings-stop-x-server-idle-row">
          <SettingsField
            label="Stop X server when idle"
            hint={
              provides
                ? "Shut the X server termiHub started down once no connection uses it."
                : STOP_X_SERVER_INACTIVE_HINT
            }
            hintTestId="settings-stop-x-server-idle-hint"
          >
            <Toggle
              checked={provides && stopWhenIdle}
              disabled={!provides}
              onCheckedChange={(checked) =>
                onChange((prev) => ({ ...prev, stopXServerWhenIdle: checked }))
              }
              data-testid="settings-stop-x-server-idle"
            />
          </SettingsField>
        </div>
      )}
    </div>
  );
}
