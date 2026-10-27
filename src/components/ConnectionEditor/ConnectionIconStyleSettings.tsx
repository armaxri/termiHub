import { useState } from "react";
import { Ban, Pipette, Smile } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { useIconSurfaces } from "@/hooks/useIconSurfaces";
import { EmojiPickerDialog } from "./EmojiPickerDialog";
import { ICON_COLOR_PALETTE, isHexIconColor, resolveIconColor } from "@/utils/connectionIconStyle";
// The swatch styles live with the editor; imported here so the folder
// Appearance dialog (#5020) gets them without the editor mounted.
import "./ConnectionEditor.css";

const DEFAULT_COLOR_HINT =
  "Tints the connection icon in the sidebar and on tabs. Colors are adjusted to stay readable in light and dark themes.";
const DEFAULT_EMOJI_HINT =
  "One emoji shown instead of the icon. Choose one from the picker, or type or paste it.";

export interface ConnectionIconStyleSettingsProps {
  /** Palette name, `#rrggbb`, or unset. */
  iconColor: string | undefined;
  onIconColorChange: (color: string | undefined) => void;
  /** Raw emoji input; validated by the editor's zod schema. */
  iconEmoji: string | undefined;
  onIconEmojiChange: (emoji: string | undefined) => void;
  /** Inline validation message for the emoji field. */
  iconEmojiError?: string | null;
  /** Hint under the colour swatches; defaults to the connection wording. */
  colorHint?: string;
  /** Hint under the emoji field; defaults to the connection wording. */
  emojiHint?: string;
}

/**
 * Icon colour swatches and emoji input for the connection editor's Appearance
 * tab (#5008) and the folder Appearance dialog (#5020). Swatches preview the shade the active theme will actually draw.
 */
export function ConnectionIconStyleSettings({
  iconColor,
  onIconColorChange,
  iconEmoji,
  onIconEmojiChange,
  iconEmojiError,
  colorHint = DEFAULT_COLOR_HINT,
  emojiHint = DEFAULT_EMOJI_HINT,
}: ConnectionIconStyleSettingsProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const surfaces = useIconSurfaces();
  const customHex = iconColor && isHexIconColor(iconColor) ? iconColor : undefined;

  const swatchClass = (selected: boolean) =>
    `connection-editor__swatch${selected ? " connection-editor__swatch--selected" : ""}`;

  return (
    <>
      <Field variant="settings" label="Icon Color" hint={colorHint}>
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
        hint={emojiHint}
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEmojiPickerOpen(true)}
              data-testid="connection-editor-choose-icon-emoji"
            >
              <Smile size={14} aria-hidden="true" /> Choose…
            </Button>
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
        </>
      </Field>

      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onEmojiSelect={(emoji) => onIconEmojiChange(emoji)}
      />
      <ColorPickerDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        currentColor={customHex}
        onColorChange={(c) => onIconColorChange(c ?? undefined)}
      />
    </>
  );
}
