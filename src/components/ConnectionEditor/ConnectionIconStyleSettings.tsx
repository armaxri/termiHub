import { useState } from "react";
import { Ban, Pipette } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { useIconSurfaces } from "@/hooks/useIconSurfaces";
import { ICON_COLOR_PALETTE, isHexIconColor, resolveIconColor } from "@/utils/connectionIconStyle";

/** Quick-pick emoji suggestions; any emoji can be typed or pasted instead. */
export const SUGGESTED_ICON_EMOJI = [
  "🚀",
  "🔥",
  "⭐",
  "🏠",
  "🏭",
  "🧪",
  "🔒",
  "🌐",
  "🐧",
  "🐳",
  "🗄️",
  "⚠️",
] as const;

export interface ConnectionIconStyleSettingsProps {
  /** Palette name, `#rrggbb`, or unset. */
  iconColor: string | undefined;
  onIconColorChange: (color: string | undefined) => void;
  /** Raw emoji input; validated by the editor's zod schema. */
  iconEmoji: string | undefined;
  onIconEmojiChange: (emoji: string | undefined) => void;
  /** Inline validation message for the emoji field. */
  iconEmojiError?: string | null;
}

/**
 * Icon colour swatches and emoji input for the connection editor's Appearance
 * tab (#5008). Swatches preview the shade the active theme will actually draw.
 */
export function ConnectionIconStyleSettings({
  iconColor,
  onIconColorChange,
  iconEmoji,
  onIconEmojiChange,
  iconEmojiError,
}: ConnectionIconStyleSettingsProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const surfaces = useIconSurfaces();
  const customHex = iconColor && isHexIconColor(iconColor) ? iconColor : undefined;

  const swatchClass = (selected: boolean) =>
    `connection-editor__swatch${selected ? " connection-editor__swatch--selected" : ""}`;

  return (
    <>
      <Field
        variant="settings"
        label="Icon Color"
        hint="Tints the connection icon in the sidebar and on tabs. Colors are adjusted to stay readable in light and dark themes."
      >
        <>
          <div
            className="connection-editor__swatches"
            role="radiogroup"
            aria-label="Icon color"
            data-testid="connection-editor-icon-color"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!iconColor}
              aria-label="Default color"
              title="Default"
              className={swatchClass(!iconColor)}
              onClick={() => onIconColorChange(undefined)}
              data-testid="icon-color-swatch-default"
            >
              <Ban size={14} aria-hidden="true" />
            </button>
            {ICON_COLOR_PALETTE.map((entry) => (
              <button
                key={entry.name}
                type="button"
                role="radio"
                aria-checked={iconColor === entry.name}
                aria-label={entry.label}
                title={entry.label}
                className={swatchClass(iconColor === entry.name)}
                onClick={() => onIconColorChange(entry.name)}
                data-testid={`icon-color-swatch-${entry.name}`}
              >
                <span
                  className="connection-editor__swatch-dot"
                  style={{ backgroundColor: resolveIconColor(entry.name, surfaces) }}
                />
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={customHex !== undefined}
              aria-label={customHex ? `Custom color ${customHex}` : "Custom color"}
              title="Custom…"
              className={swatchClass(customHex !== undefined)}
              onClick={() => setCustomOpen(true)}
              data-testid="icon-color-swatch-custom"
            >
              {customHex ? (
                <span
                  className="connection-editor__swatch-dot"
                  style={{ backgroundColor: resolveIconColor(customHex, surfaces) }}
                />
              ) : (
                <Pipette size={14} aria-hidden="true" />
              )}
            </button>
          </div>
        </>
      </Field>

      <Field
        variant="settings"
        label="Emoji Icon"
        htmlFor="connection-editor-icon-emoji"
        error={iconEmojiError ?? undefined}
        hint="One emoji shown instead of the icon. Type or paste it, or open the system emoji picker (Ctrl+Cmd+Space on macOS, Win+. on Windows)."
      >
        <>
          <div className="connection-editor__color-row">
            <Input
              id="connection-editor-icon-emoji"
              className="connection-editor__emoji-input"
              value={iconEmoji ?? ""}
              placeholder="None"
              aria-label="Emoji icon"
              aria-invalid={iconEmojiError ? true : undefined}
              error={Boolean(iconEmojiError)}
              onChange={(e) => {
                const next = e.target.value.trim();
                onIconEmojiChange(next === "" ? undefined : next);
              }}
              data-testid="connection-editor-icon-emoji"
            />
            {iconEmoji && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onIconEmojiChange(undefined)}
                data-testid="connection-editor-clear-icon-emoji"
              >
                Clear
              </Button>
            )}
          </div>
          <div
            className="connection-editor__emoji-suggestions"
            role="group"
            aria-label="Suggested emoji"
          >
            {SUGGESTED_ICON_EMOJI.map((emoji, index) => (
              <button
                key={emoji}
                type="button"
                className={swatchClass(iconEmoji === emoji)}
                aria-label={`Use ${emoji}`}
                aria-pressed={iconEmoji === emoji}
                onClick={() => onIconEmojiChange(emoji)}
                data-testid={`icon-emoji-suggestion-${index}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      </Field>

      <ColorPickerDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        currentColor={customHex}
        onColorChange={(c) => onIconColorChange(c ?? undefined)}
      />
    </>
  );
}
