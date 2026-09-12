import { AppSettings } from "@/types/connection";
import { isWindows } from "@/utils/platform";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import type { SettingsUpdate } from "./GeneralSettings";

interface XServerSettingsProps {
  settings: AppSettings;
  onChange: (update: SettingsUpdate) => void;
  visibleFields?: Set<string>;
}

/**
 * Settings panel section for the automatically-managed local X server used for
 * X11 forwarding. Split out of the former overloaded "General" category (UX-029)
 * so X-server behavior is discoverable in the nav.
 */
export function XServerSettings({ settings, onChange, visibleFields }: XServerSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  if (!show("provideXServerAutomatically") && !show("stopXServerWhenIdle")) {
    return null;
  }

  return (
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
              onChange((prev) => ({ ...prev, provideXServerAutomatically: checked }))
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
              onChange((prev) => ({ ...prev, stopXServerWhenIdle: checked }))
            }
            data-testid="settings-stop-x-server-idle"
          />
        </SettingsField>
      )}
    </div>
  );
}
