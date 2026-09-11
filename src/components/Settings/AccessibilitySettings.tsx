import { AppSettings } from "@/types/connection";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";

interface AccessibilitySettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

/**
 * Accessibility settings section. Surfaces assistive-technology options — today
 * the terminal screen-reader mode — under a clearly-named, discoverable category
 * rather than leaving them buried in Terminal settings (A11Y-006).
 */
export function AccessibilitySettings({
  settings,
  onChange,
  visibleFields,
}: AccessibilitySettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Accessibility</h3>
      {show("screenReaderMode") && (
        <SettingsField
          label="Screen Reader Mode"
          hint="Expose terminal output to assistive technology (screen readers such as VoiceOver, NVDA, JAWS). Adds some rendering overhead — enable only if you use a screen reader."
        >
          <Toggle
            checked={settings.screenReaderMode ?? false}
            onCheckedChange={(checked) => onChange({ ...settings, screenReaderMode: checked })}
            data-testid="settings-screen-reader-mode"
          />
        </SettingsField>
      )}
    </div>
  );
}
