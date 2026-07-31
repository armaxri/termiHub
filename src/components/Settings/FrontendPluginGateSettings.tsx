import { useCallback } from "react";
import { ShieldAlert } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";

/**
 * Settings → Plugins → the experimental frontend-plugin gate (#2048).
 *
 * Frontend (JavaScript) plugins are injected into the main WebView and run with
 * full IPC/command access and no per-plugin permission enforcement (weak
 * isolation; enforcement tracked in #2001). For v0.1.0 their execution is gated
 * behind this explicit, default-off opt-in with a prominent trust warning, so the
 * full plugin JS surface is never active unless the user knowingly accepts it.
 * Theme-only and backend plugins are unaffected.
 *
 * Toggling this persists via `updateSettings`, which re-reconciles the injected
 * plugin scripts — enabling loads active frontend plugins, disabling tears them
 * down live.
 */
export function FrontendPluginGateSettings() {
  const settings = useProjectedSettings();
  const enabled = settings.frontendPluginsEnabled ?? false;
  const updateSettings = useAppStore((s) => s.updateSettings);

  const handleToggle = useCallback(
    (checked: boolean) => {
      void updateSettings({ ...settings, frontendPluginsEnabled: checked });
    },
    [settings, updateSettings]
  );

  return (
    <div className="settings-panel__category">
      <div className="settings-panel__section" data-testid="settings-frontend-plugin-gate">
        <h3 className="settings-panel__section-title">
          <ShieldAlert size={16} aria-hidden="true" /> Frontend Plugins (Experimental)
        </h3>
        <p className="settings-panel__description">
          Frontend plugins run untrusted JavaScript inside termiHub with full access to the app and
          your connections, and only weak isolation. Enable this only for plugins you trust. It is
          off by default and can be turned off at any time to stop all frontend-plugin code
          immediately.
        </p>

        <SettingsField
          label="Enable Frontend (JavaScript) Plugins"
          hint="Experimental. Runs plugin-provided JavaScript (protocol parsers and status-bar widgets). Theme-only and backend plugins are unaffected by this setting."
          hintVariant="warning"
        >
          <Toggle
            checked={enabled}
            onCheckedChange={handleToggle}
            data-testid="settings-frontend-plugins-enabled"
          />
        </SettingsField>
      </div>
    </div>
  );
}
