import { AppSettings } from "@/types/connection";
import { LineEnding } from "@/types/terminal";
import { DEFAULT_LINE_ENDING, LINE_ENDING_OPTIONS } from "@/utils/lineEndings";
import { NumberInput, Select, Toggle } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { SyntaxHighlightingSettings } from "./SyntaxHighlightingSettings";

/** Sentinel for the "platform default" right-click option (Radix Select forbids empty-string item values). */
const RIGHT_CLICK_PLATFORM_DEFAULT = "__platform_default__";

/** Static Select option lists, hoisted so they are not rebuilt on every render. */
const CURSOR_STYLE_OPTIONS: SelectOption[] = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Bar" },
];

const LINE_ENDING_SELECT_OPTIONS: SelectOption[] = LINE_ENDING_OPTIONS.map((opt) => ({
  value: opt.value,
  label: opt.label,
}));

const RIGHT_CLICK_OPTIONS: SelectOption[] = [
  { value: RIGHT_CLICK_PLATFORM_DEFAULT, label: "Platform Default" },
  { value: "contextMenu", label: "Context Menu" },
  { value: "quickAction", label: "Quick Copy/Paste" },
];

interface TerminalSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  visibleFields?: Set<string>;
}

export function TerminalSettings({ settings, onChange, visibleFields }: TerminalSettingsProps) {
  const show = (field: string) => !visibleFields || visibleFields.has(field);

  return (
    <>
      <div className="settings-panel__category">
        <h3 className="settings-panel__category-title">Terminal</h3>
        {show("defaultHorizontalScrolling") && (
          <SettingsField
            label="Default Horizontal Scrolling"
            hint="Enable horizontal scrolling for new terminals by default."
          >
            <Toggle
              checked={settings.defaultHorizontalScrolling ?? false}
              onCheckedChange={(checked) =>
                onChange({ ...settings, defaultHorizontalScrolling: checked })
              }
            />
          </SettingsField>
        )}
        {show("scrollbackBuffer") && (
          <SettingsField
            label="Scrollback Buffer"
            hint="Number of lines kept in the terminal scrollback (100–1 000 000). Larger values consume more memory — roughly 1–2 MB per 10 000 lines of typical output."
          >
            <NumberInput
              min={100}
              max={1000000}
              value={settings.scrollbackBuffer ?? ""}
              onValueChange={(v) =>
                onChange({ ...settings, scrollbackBuffer: v === "" ? undefined : v })
              }
            />
          </SettingsField>
        )}
        {show("cursorStyle") && (
          <SettingsField label="Cursor Style" hint="Terminal cursor shape.">
            <Select
              data-testid="settings-cursor-style"
              value={settings.cursorStyle ?? "block"}
              onChange={(value) =>
                onChange({
                  ...settings,
                  cursorStyle: value as "block" | "underline" | "bar",
                })
              }
              options={CURSOR_STYLE_OPTIONS}
            />
          </SettingsField>
        )}
        {show("cursorBlink") && (
          <SettingsField label="Cursor Blink" hint="Whether the terminal cursor blinks.">
            <Toggle
              checked={settings.cursorBlink ?? true}
              onCheckedChange={(checked) => onChange({ ...settings, cursorBlink: checked })}
            />
          </SettingsField>
        )}
        {show("defaultLineEnding") && (
          <SettingsField
            label="Line Ending (Enter & Paste)"
            hint="Sequence sent when pressing Enter and used to normalize line endings in pasted text. Prevents Windows CRLF from inserting blank lines on Unix shells and serial devices. Can be overridden per connection."
          >
            <Select
              data-testid="settings-line-ending"
              value={settings.defaultLineEnding ?? DEFAULT_LINE_ENDING}
              onChange={(value) =>
                onChange({
                  ...settings,
                  defaultLineEnding: value as LineEnding,
                })
              }
              options={LINE_ENDING_SELECT_OPTIONS}
            />
          </SettingsField>
        )}
        {show("rightClickBehavior") && (
          <SettingsField
            label="Right-Click Behavior"
            hint="Context Menu shows the full right-click menu. Quick Copy/Paste copies selected text or pastes if nothing is selected. Default: Context Menu on macOS/Linux, Quick Copy/Paste on Windows."
          >
            <Select
              data-testid="settings-right-click-behavior"
              value={settings.rightClickBehavior ?? RIGHT_CLICK_PLATFORM_DEFAULT}
              onChange={(value) =>
                onChange({
                  ...settings,
                  rightClickBehavior:
                    value === RIGHT_CLICK_PLATFORM_DEFAULT
                      ? undefined
                      : (value as "contextMenu" | "quickAction"),
                })
              }
              options={RIGHT_CLICK_OPTIONS}
            />
          </SettingsField>
        )}
        {show("askOpenSavedFileInTab") && (
          <SettingsField
            label="Open Saved File in Tab"
            hint="After saving terminal content to a file, ask whether to open it in an editor tab. When off, files are saved without prompting and are not opened."
          >
            <Toggle
              checked={settings.askOpenSavedFileInTab ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, askOpenSavedFileInTab: checked })
              }
              data-testid="settings-ask-open-saved-file-in-tab"
            />
          </SettingsField>
        )}
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
      <SyntaxHighlightingSettings
        settings={settings}
        onChange={onChange}
        visibleFields={visibleFields}
      />
    </>
  );
}
