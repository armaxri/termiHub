import { useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";

/**
 * Settings → Plugins → the opt-in periodic plugin update check (PROD-051).
 *
 * termiHub has no plugin registry for 0.1: plugins are installed from local
 * files. A plugin may publish an HTTPS update URL; its Plugins-view entry can
 * then be checked for a newer version on demand. This toggle additionally
 * checks such plugins once a day in the background. It is **off by default**,
 * and a check only ever reports "update available" — installing still goes
 * through the normal install dialog and its confirmations.
 */
export function PluginUpdateCheckSettings() {
  const settings = useProjectedSettings();
  const enabled = settings.pluginUpdateCheckEnabled ?? false;
  const updateSettings = useAppStore((s) => s.updateSettings);

  const handleToggle = useCallback(
    (checked: boolean) => {
      void updateSettings({ ...settings, pluginUpdateCheckEnabled: checked });
    },
    [settings, updateSettings]
  );

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-plugin-update-check">
        <h3 className="settings-panel__section-title">
          <RefreshCw size={16} aria-hidden="true" /> Plugin Updates
        </h3>
        <p className="settings-panel__description">
          Plugins are installed from files; there is no plugin store yet. A plugin can publish an
          update URL, and its entry in the Plugins view then offers “Check for updates”. Updates are
          never installed automatically — you always confirm them in the install dialog.
        </p>

        <SettingsField
          label="Check for Plugin Updates Automatically"
          hint="Checks plugins that publish an update URL once a day while termiHub runs. Off by default."
        >
          <Toggle
            checked={enabled}
            onCheckedChange={handleToggle}
            data-testid="settings-plugin-update-check-enabled"
          />
        </SettingsField>
      </div>
    </div>
  );
}
