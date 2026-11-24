import { AppSettings } from "@/types/connection";
import { Toggle } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

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
      <SettingsSectionHeading>Accessibility</SettingsSectionHeading>
      {show("screenReaderMode") && (
        <SettingsField
          label="Screen reader mode"
          hint="Let screen readers such as VoiceOver, NVDA and JAWS read terminal output."
          help="Adds some rendering overhead, so turn it on only if you use a screen reader."
          hintTestId="settings-screen-reader-mode-hint"
          helpTestId="settings-screen-reader-mode-help"
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
