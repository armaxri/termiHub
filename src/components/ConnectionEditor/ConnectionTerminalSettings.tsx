import { useAppStore } from "@/store/appStore";
import { TerminalOptions } from "@/types/terminal";

interface ConnectionTerminalSettingsProps {
  options: TerminalOptions;
  onChange: (options: TerminalOptions) => void;
}

export function ConnectionTerminalSettings({
  options,
  onChange,
}: ConnectionTerminalSettingsProps) {
  const globalSettings = useAppStore((s) => s.settings);

  const globalFontFamily =
    globalSettings.fontFamily || "MesloLGS Nerd Font Mono, Cascadia Code, ...";
  const globalFontSize = globalSettings.fontSize ?? 14;
  const globalScrollback = globalSettings.scrollbackBuffer ?? 5000;
  const globalCursorStyle = globalSettings.cursorStyle ?? "block";
  const globalCursorBlink = globalSettings.cursorBlink ?? true;
  const globalHorizontalScrolling = globalSettings.defaultHorizontalScrolling ?? false;

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Terminal</h3>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Family</span>
        <input
          type="text"
          value={options.fontFamily ?? ""}
          onChange={(e) =>
            onChange({ ...options, fontFamily: e.target.value || undefined })
          }
          placeholder={`Use global default (${globalFontFamily})`}
        />
        <span className="settings-form__hint">
          Leave empty to use the global setting.
        </span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Size</span>
        <input
          type="number"
          min={8}
          max={72}
          value={options.fontSize ?? ""}
          onChange={(e) => {
            const val = parseInt(e.target.value);
            onChange({ ...options, fontSize: isNaN(val) ? undefined : val });
          }}
          placeholder={`Use global default (${globalFontSize})`}
        />
        <span className="settings-form__hint">
          Leave empty to use the global setting.
        </span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Scrollback Buffer</span>
        <input
          type="number"
          min={100}
          max={100000}
          value={options.scrollbackBuffer ?? ""}
          onChange={(e) => {
            const val = parseInt(e.target.value);
            onChange({
              ...options,
              scrollbackBuffer: isNaN(val) ? undefined : val,
            });
          }}
          placeholder={`Use global default (${globalScrollback})`}
        />
        <span className="settings-form__hint">
          Number of lines kept in scrollback (100-100,000). Leave empty for global default.
        </span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Cursor Style</span>
        <select
          value={options.cursorStyle ?? ""}
          onChange={(e) =>
            onChange({
              ...options,
              cursorStyle: (e.target.value as "block" | "underline" | "bar") || undefined,
            })
          }
        >
          <option value="">Use global default ({globalCursorStyle})</option>
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </select>
      </label>

      <div className="settings-form__field settings-form__field--row">
        <label className="settings-panel__toggle">
          <input
            type="checkbox"
            checked={options.cursorBlink ?? globalCursorBlink}
            onChange={(e) =>
              onChange({ ...options, cursorBlink: e.target.checked })
            }
          />
          <span className="settings-panel__toggle-slider" />
        </label>
        <div>
          <span className="settings-form__label">Cursor Blink</span>
          <span className="settings-form__hint">
            Whether the terminal cursor blinks.
            {options.cursorBlink != null && (
              <button
                type="button"
                className="settings-form__hint-action"
                onClick={() => onChange({ ...options, cursorBlink: undefined })}
              >
                Reset to global default
              </button>
            )}
          </span>
        </div>
      </div>

      <div className="settings-form__field settings-form__field--row">
        <label className="settings-panel__toggle">
          <input
            type="checkbox"
            checked={options.horizontalScrolling ?? globalHorizontalScrolling}
            onChange={(e) =>
              onChange({ ...options, horizontalScrolling: e.target.checked })
            }
          />
          <span className="settings-panel__toggle-slider" />
        </label>
        <div>
          <span className="settings-form__label">Horizontal Scrolling</span>
          <span className="settings-form__hint">
            Enable horizontal scrolling for this connection.
            {options.horizontalScrolling != null && (
              <button
                type="button"
                className="settings-form__hint-action"
                onClick={() =>
                  onChange({ ...options, horizontalScrolling: undefined })
                }
              >
                Reset to global default
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
