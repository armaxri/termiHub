import { AppSettings } from "@/types/connection";

interface TerminalSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function TerminalSettings({ settings, onChange, visibleFields }: TerminalSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Terminal</h3>
      {show("defaultHorizontalScrolling") && (
        <div className="settings-form__field settings-form__field--row">
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.defaultHorizontalScrolling ?? false}
              onChange={(e) =>
                onChange({ ...settings, defaultHorizontalScrolling: e.target.checked })
              }
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <div>
            <span className="settings-form__label">Default Horizontal Scrolling</span>
            <span className="settings-form__hint">
              Enable horizontal scrolling for new terminals by default.
            </span>
          </div>
        </div>
      )}
      {show("scrollbackBuffer") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Scrollback Buffer</span>
          <input
            type="number"
            min={100}
            max={100000}
            value={settings.scrollbackBuffer ?? 5000}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              onChange({ ...settings, scrollbackBuffer: isNaN(val) ? undefined : val });
            }}
          />
          <span className="settings-form__hint">
            Number of lines kept in the terminal scrollback (100–100,000).
          </span>
        </label>
      )}
      {show("cursorStyle") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Cursor Style</span>
          <select
            value={settings.cursorStyle ?? "block"}
            onChange={(e) =>
              onChange({
                ...settings,
                cursorStyle: e.target.value as "block" | "underline" | "bar",
              })
            }
          >
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
          <span className="settings-form__hint">Terminal cursor shape.</span>
        </label>
      )}
      {show("cursorBlink") && (
        <div className="settings-form__field settings-form__field--row">
          <label className="settings-panel__toggle">
            <input
              type="checkbox"
              checked={settings.cursorBlink ?? true}
              onChange={(e) => onChange({ ...settings, cursorBlink: e.target.checked })}
            />
            <span className="settings-panel__toggle-slider" />
          </label>
          <div>
            <span className="settings-form__label">Cursor Blink</span>
            <span className="settings-form__hint">Whether the terminal cursor blinks.</span>
          </div>
        </div>
      )}
      {show("rightClickBehavior") && (
        <label className="settings-form__field">
          <span className="settings-form__label">Right-Click Behavior</span>
          <select
            value={settings.rightClickBehavior ?? ""}
            onChange={(e) =>
              onChange({
                ...settings,
                rightClickBehavior:
                  e.target.value === ""
                    ? undefined
                    : (e.target.value as "contextMenu" | "quickAction"),
              })
            }
          >
            <option value="">Platform Default</option>
            <option value="contextMenu">Context Menu</option>
            <option value="quickAction">Quick Copy/Paste</option>
          </select>
          <span className="settings-form__hint">
            Context Menu shows the full right-click menu. Quick Copy/Paste copies selected text or
            pastes if nothing is selected. Default: Context Menu on macOS/Linux, Quick Copy/Paste on
            Windows.
          </span>
        </label>
      )}
    </div>
  );
}
