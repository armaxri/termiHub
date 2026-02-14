import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { HexColorPicker } from "react-colorful";
import "./ColorPickerDialog.css";

const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
];

interface ColorPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentColor: string | undefined;
  onColorChange: (color: string | null) => void;
}

/**
 * Dialog for picking a tab color with preset swatches and a full color picker.
 */
export function ColorPickerDialog({
  open,
  onOpenChange,
  currentColor,
  onColorChange,
}: ColorPickerDialogProps) {
  const [selectedColor, setSelectedColor] = useState(currentColor ?? "#3b82f6");

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedColor(currentColor ?? "#3b82f6");
    }
  }, [open, currentColor]);

  const handleApply = () => {
    onColorChange(selectedColor);
    onOpenChange(false);
  };

  const handleClear = () => {
    onColorChange(null);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="color-picker__overlay" />
        <Dialog.Content className="color-picker__content">
          <Dialog.Title className="color-picker__title">Tab Color</Dialog.Title>

          <div className="color-picker__presets">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                className={`color-picker__swatch ${selectedColor === color ? "color-picker__swatch--active" : ""}`}
                style={{ backgroundColor: color }}
                onClick={() => setSelectedColor(color)}
                title={color}
                data-testid={`color-picker-swatch-${color.replace("#", "")}`}
              />
            ))}
          </div>

          <HexColorPicker
            className="color-picker__picker"
            color={selectedColor}
            onChange={setSelectedColor}
          />

          <input
            className="color-picker__hex-input"
            type="text"
            value={selectedColor}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setSelectedColor(v);
            }}
            maxLength={7}
            data-testid="color-picker-hex-input"
          />

          <div className="color-picker__actions">
            <button
              className="color-picker__btn color-picker__btn--secondary"
              onClick={handleClear}
              data-testid="color-picker-clear"
            >
              Clear
            </button>
            <button
              className="color-picker__btn color-picker__btn--primary"
              onClick={handleApply}
              data-testid="color-picker-apply"
            >
              Apply
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
