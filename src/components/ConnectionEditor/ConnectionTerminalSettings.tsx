import { useAppStore } from "@/store/appStore";
import { TerminalOptions, LineEnding } from "@/types/terminal";
import { DEFAULT_LINE_ENDING, LINE_ENDING_OPTIONS, lineEndingLabel } from "@/utils/lineEndings";
import { Input, NumberInput, Select, Toggle } from "@/components/ui";

interface ConnectionTerminalSettingsProps {
  options: TerminalOptions;
  onChange: (options: TerminalOptions) => void;
}

/**
 * Sentinel for the "use global default" option. Radix Select reserves the empty
 * string to clear the selection, so an explicit non-empty value is required and
 * mapped back to `undefined` (inherit the global setting) at the call site.
 */
const GLOBAL_DEFAULT = "__global__";

export function ConnectionTerminalSettings({ options, onChange }: ConnectionTerminalSettingsProps) {
  const globalSettings = useAppStore((s) => s.settings);

  const globalFontFamily =
    globalSettings.fontFamily || "MesloLGS Nerd Font Mono, Cascadia Code, ...";
  const globalFontSize = globalSettings.fontSize ?? 14;
  const globalScrollback = globalSettings.scrollbackBuffer ?? 10000;
  const globalCursorStyle = globalSettings.cursorStyle ?? "block";
  const globalCursorBlink = globalSettings.cursorBlink ?? true;
  const globalHorizontalScrolling = globalSettings.defaultHorizontalScrolling ?? false;
  const globalLineEnding = globalSettings.defaultLineEnding ?? DEFAULT_LINE_ENDING;

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Terminal</h3>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Family</span>
        <Input
          type="text"
          value={options.fontFamily ?? ""}
          onChange={(e) => onChange({ ...options, fontFamily: e.target.value || undefined })}
          placeholder={`Use global default (${globalFontFamily})`}
        />
        <span className="settings-form__hint">Leave empty to use the global setting.</span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Font Size</span>
        <NumberInput
          min={8}
          max={72}
          value={options.fontSize ?? ""}
          onValueChange={(v) => onChange({ ...options, fontSize: v === "" ? undefined : v })}
          placeholder={`Use global default (${globalFontSize})`}
        />
        <span className="settings-form__hint">Leave empty to use the global setting.</span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Scrollback Buffer</span>
        <NumberInput
          min={100}
          max={1000000}
          value={options.scrollbackBuffer ?? ""}
          onValueChange={(v) =>
            onChange({ ...options, scrollbackBuffer: v === "" ? undefined : v })
          }
          placeholder={`Use global default (${globalScrollback})`}
        />
        <span className="settings-form__hint">
          Number of lines kept in scrollback (100–1 000 000). Leave empty for global default. Larger
          values consume more memory — roughly 1–2 MB per 10 000 lines of typical output.
        </span>
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Cursor Style</span>
        <Select
          value={options.cursorStyle ?? GLOBAL_DEFAULT}
          onChange={(v) =>
            onChange({
              ...options,
              cursorStyle: v === GLOBAL_DEFAULT ? undefined : (v as "block" | "underline" | "bar"),
            })
          }
          options={[
            { value: GLOBAL_DEFAULT, label: `Use global default (${globalCursorStyle})` },
            { value: "block", label: "Block" },
            { value: "underline", label: "Underline" },
            { value: "bar", label: "Bar" },
          ]}
          aria-label="Cursor Style"
        />
      </label>

      <label className="settings-form__field">
        <span className="settings-form__label">Line Ending (Enter &amp; Paste)</span>
        <Select
          value={options.lineEnding ?? GLOBAL_DEFAULT}
          onChange={(v) =>
            onChange({
              ...options,
              lineEnding: v === GLOBAL_DEFAULT ? undefined : (v as LineEnding),
            })
          }
          options={[
            {
              value: GLOBAL_DEFAULT,
              label: `Use global default (${lineEndingLabel(globalLineEnding)})`,
            },
            ...LINE_ENDING_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
          ]}
          aria-label="Line Ending (Enter & Paste)"
        />
        <span className="settings-form__hint">
          Sequence sent on Enter and used to normalize pasted text for this connection.
        </span>
      </label>

      <div className="settings-form__field">
        <span className="settings-form__label">Cursor Blink</span>
        <Toggle
          checked={options.cursorBlink ?? globalCursorBlink}
          onCheckedChange={(v) => onChange({ ...options, cursorBlink: v })}
          aria-label="Cursor Blink"
        />
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

      <div className="settings-form__field">
        <span className="settings-form__label">Horizontal Scrolling</span>
        <Toggle
          checked={options.horizontalScrolling ?? globalHorizontalScrolling}
          onCheckedChange={(v) => onChange({ ...options, horizontalScrolling: v })}
          aria-label="Horizontal Scrolling"
        />
        <span className="settings-form__hint">
          Enable horizontal scrolling for this connection.
          {options.horizontalScrolling != null && (
            <button
              type="button"
              className="settings-form__hint-action"
              onClick={() => onChange({ ...options, horizontalScrolling: undefined })}
            >
              Reset to global default
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
