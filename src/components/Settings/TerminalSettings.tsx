import { AppSettings } from "@/types/connection";
import { LineEnding } from "@/types/terminal";
import { DEFAULT_LINE_ENDING, LINE_ENDING_OPTIONS } from "@/utils/lineEndings";
import { Select, Toggle } from "@/components/ui";
import { DEFAULT_SCROLLBACK } from "@/components/Terminal/terminalDefaults";
import { DefaultNumberInput, formatSettingNumber, isAtDefault } from "./DefaultNumberInput";
import { SettingDefaultMarker } from "./SettingDefaultMarker";
import type { SelectOption } from "@/components/ui";
import { SettingsField } from "./SettingsField";
import { SyntaxHighlightingSettings } from "./SyntaxHighlightingSettings";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

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
        <SettingsSectionHeading>Terminal</SettingsSectionHeading>
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
            hint="Lines kept in the terminal scrollback (100–1000000)."
            help="Larger values use more memory: roughly 1–2 MB per 10000 lines of typical output."
            helpTestId="settings-scrollback-buffer-help"
            hintTestId="settings-scrollback-buffer-hint"
            labelAccessory={
              <SettingDefaultMarker
                isDefault={isAtDefault(settings.scrollbackBuffer, DEFAULT_SCROLLBACK)}
                onReset={() => onChange({ ...settings, scrollbackBuffer: undefined })}
                name="Scrollback buffer"
                defaultText={formatSettingNumber(DEFAULT_SCROLLBACK)}
                data-testid="settings-scrollback-buffer"
              />
            }
          >
            <DefaultNumberInput
              min={100}
              max={1000000}
              unit="lines"
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
            hint="What Enter sends. Each connection can override it."
            help="Pasted text is converted to the same line ending, so Windows CRLF does not insert blank lines on Unix shells and serial devices."
            hintTestId="settings-line-ending-hint"
            helpTestId="settings-line-ending-help"
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
            hint="What a right-click in the terminal does."
            help="Context menu shows the full right-click menu. Quick copy/paste copies selected text or pastes if nothing is selected. Default: Context menu on macOS and Linux, Quick copy/paste on Windows."
            hintTestId="settings-right-click-behavior-hint"
            helpTestId="settings-right-click-behavior-help"
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
        {show("terminalInlineImages") && (
          <SettingsField
            label="Inline images"
            hint="Show images that programs like imgcat print in the terminal."
            help="Supports SIXEL and the iTerm2 inline image protocol (img2sixel, imgcat). Oversized images are dropped and each terminal's image memory is capped; images are not kept across reconnects."
            hintTestId="settings-terminal-inline-images-hint"
            helpTestId="settings-terminal-inline-images-help"
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
            hint="One emoji for families, skin tones and flags. May make the cursor drift."
            help="Some shells count the parts of such an emoji separately, which can make the cursor drift on lines that contain one. Applies to new output."
            hintTestId="settings-terminal-combine-emoji-hint"
            helpTestId="settings-terminal-combine-emoji-help"
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
            hint="After saving terminal output to a file, offer to open it in a tab."
            help="When off, the file is saved without asking and is not opened."
            hintTestId="settings-ask-open-saved-file-in-tab-hint"
            helpTestId="settings-ask-open-saved-file-in-tab-help"
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
        {(show("terminalCommandDecorations") || show("defaultShellIntegration")) && (
          <CommandMarksSettings settings={settings} onChange={onChange} show={show} />
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

/** The command-marks hint in plain words (#5846): no protocol names. */
const COMMAND_MARKS_HINT = "Works with bash, zsh, fish and PowerShell once the shell hook is on.";

/** The details behind the "?" — the protocol name lives only here (#5846). */
const COMMAND_MARKS_HELP =
  "A thin mark beside each finished command's prompt: green means the command succeeded, red that it failed. The shell must report its commands (OSC 133); termiHub's shell hook does that for local, SSH and WSL shells.";

interface CommandMarksSettingsProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  show: (field: string) => boolean;
}

/**
 * Terminal ▸ Command marks (#5633): the two command-mark settings in one place.
 * "Show command marks" draws the marks; the nested shell-hook default makes new
 * sessions' shells emit them in the first place.
 */
function CommandMarksSettings({ settings, onChange, show }: CommandMarksSettingsProps) {
  return (
    <div className="settings-panel__subsection" data-testid="settings-command-marks">
      <h4 className="settings-panel__subsection-title">Command marks</h4>
      {show("terminalCommandDecorations") && (
        <SettingsField
          label="Show command marks"
          hint={COMMAND_MARKS_HINT}
          help={COMMAND_MARKS_HELP}
          hintTestId="settings-terminal-command-decorations-hint"
          helpTestId="settings-terminal-command-decorations-help"
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
      {show("defaultShellIntegration") && (
        <div className="settings-panel__nested">
          <SettingsField
            label="Add shell hook to new sessions automatically"
            hint="Turn the shell hook on for new local, SSH and WSL connections."
            help="Off by default because the hook sends one line of shell code when a session starts. Each connection can still turn it on or off."
            hintTestId="settings-default-shell-integration-hint"
            helpTestId="settings-default-shell-integration-help"
          >
            <Toggle
              data-testid="settings-default-shell-integration"
              checked={settings.defaultShellIntegration ?? false}
              onCheckedChange={(checked) =>
                onChange({ ...settings, defaultShellIntegration: checked })
              }
            />
          </SettingsField>
        </div>
      )}
    </div>
  );
}
