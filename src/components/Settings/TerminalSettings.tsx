import { AppSettings } from "@/types/connection";
import { LineEnding } from "@/types/terminal";
import { DEFAULT_LINE_ENDING, LINE_ENDING_OPTIONS } from "@/utils/lineEndings";
import { Select, Toggle } from "@/components/ui";
import { DEFAULT_SCROLLBACK } from "@/components/Terminal/terminalDefaults";
import { DefaultNumberInput } from "./DefaultNumberInput";
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
  { value: RIGHT_CLICK_PLATFORM_DEFAULT, label: "Platform default" },
  { value: "contextMenu", label: "Context menu" },
  { value: "quickAction", label: "Quick copy/paste" },
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
            label="Default horizontal scrolling"
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
            label="Scrollback buffer"
            hint="Number of lines kept in the terminal scrollback (100–1 000 000). Larger values consume more memory — roughly 1–2 MB per 10 000 lines of typical output."
          >
            <DefaultNumberInput
              min={100}
              max={1000000}
              value={settings.scrollbackBuffer}
              defaultValue={DEFAULT_SCROLLBACK}
              onChange={(v) => onChange({ ...settings, scrollbackBuffer: v })}
              data-testid="settings-scrollback-buffer"
            />
          </SettingsField>
        )}
        {show("cursorStyle") && (
          <SettingsField label="Cursor style" hint="Terminal cursor shape.">
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
          <SettingsField label="Cursor blink" hint="Whether the terminal cursor blinks.">
            <Toggle
              checked={settings.cursorBlink ?? true}
              onCheckedChange={(checked) => onChange({ ...settings, cursorBlink: checked })}
            />
          </SettingsField>
        )}
        {show("defaultLineEnding") && (
          <SettingsField
            label="Line ending"
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
            label="Right-click behavior"
            hint="Context menu shows the full right-click menu. Quick copy/paste copies selected text or pastes if nothing is selected. Default: Context menu on macOS/Linux, Quick copy/paste on Windows."
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
        {show("terminalCommandDecorations") && (
          <SettingsField
            label="Command status marks"
            hint="Show a thin green (success) or red (failure) mark next to each finished command's prompt. Requires shell integration (OSC 133 command marks); has no effect in shells that do not emit them."
          >
            <Toggle
              data-testid="settings-terminal-command-decorations"
              checked={settings.terminalCommandDecorations ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, terminalCommandDecorations: checked })
              }
            />
          </SettingsField>
        )}
        {show("terminalInlineImages") && (
          <SettingsField
            label="Inline images"
            hint="Render images sent by the shell (SIXEL and the iTerm2 inline image protocol, e.g. img2sixel, imgcat). Oversized images are dropped and each terminal's image memory is capped; images are not kept across reconnects."
          >
            <Toggle
              data-testid="settings-terminal-inline-images"
              checked={settings.terminalInlineImages ?? true}
              onCheckedChange={(checked) =>
                onChange({ ...settings, terminalInlineImages: checked })
              }
            />
          </SettingsField>
        )}
        {show("combineEmoji") && (
          <SettingsField
            label="Combine emoji (experimental)"
            hint="Show emoji sequences (families, skin tones, flags) as one double-width glyph. Some shells count the parts separately, which can make the cursor drift on lines with such emoji. Applies to new output."
          >
            <Toggle
              data-testid="settings-terminal-combine-emoji"
              checked={settings.combineEmoji ?? false}
              onCheckedChange={(checked) => onChange({ ...settings, combineEmoji: checked })}
            />
          </SettingsField>
        )}
        {show("askOpenSavedFileInTab") && (
          <SettingsField
            label="Open saved file in tab"
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
      </div>
      <SyntaxHighlightingSettings
        settings={settings}
        onChange={onChange}
        visibleFields={visibleFields}
      />
    </>
  );
}
