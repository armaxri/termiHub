import "./SettingsPanel.css";

interface SettingsPanelProps {
  isVisible: boolean;
}

/**
 * Settings tab content.
 */
export function SettingsPanel({ isVisible }: SettingsPanelProps) {
  return (
    <div className={`settings-panel ${isVisible ? "" : "settings-panel--hidden"}`}>
      <div className="settings-panel__content">No Setting Yet!</div>
    </div>
  );
}
