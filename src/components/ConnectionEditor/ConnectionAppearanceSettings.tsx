import { ColorPickerDialog } from "@/components/Terminal/ColorPickerDialog";
import { IconPickerDialog } from "./IconPickerDialog";
import { IconByName } from "@/utils/connectionIcons";
import { Button } from "@/components/ui";
import { useState } from "react";

interface ConnectionAppearanceSettingsProps {
  color: string | undefined;
  onColorChange: (color: string | undefined) => void;
  icon: string | undefined;
  onIconChange: (icon: string | undefined) => void;
}

export function ConnectionAppearanceSettings({
  color,
  onColorChange,
  icon,
  onIconChange,
}: ConnectionAppearanceSettingsProps) {
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  return (
    <div className="settings-panel__category">
      <h3 className="settings-panel__category-title">Appearance</h3>

      <div className="settings-form__field">
        <span className="settings-form__label">Tab Color</span>
        <div className="connection-editor__color-row">
          {color && (
            <div className="connection-editor__color-preview" style={{ backgroundColor: color }} />
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setColorPickerOpen(true)}
            data-testid="connection-editor-color-picker"
          >
            {color ? "Change" : "Set Color"}
          </Button>
          {color && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onColorChange(undefined)}
              data-testid="connection-editor-clear-color"
            >
              Clear
            </Button>
          )}
        </div>
        <span className="settings-form__hint">
          Accent color shown on the connection tab and sidebar entry.
        </span>
      </div>

      <div className="settings-form__field">
        <span className="settings-form__label">Icon</span>
        <div className="connection-editor__color-row">
          {icon && <IconByName name={icon} size={18} />}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setIconPickerOpen(true)}
            data-testid="connection-editor-icon-picker"
          >
            {icon ? "Change" : "Set Icon"}
          </Button>
          {icon && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onIconChange(undefined)}
              data-testid="connection-editor-clear-icon"
            >
              Clear
            </Button>
          )}
        </div>
        <span className="settings-form__hint">
          Icon displayed on the connection tab and in the sidebar.
        </span>
      </div>

      <ColorPickerDialog
        open={colorPickerOpen}
        onOpenChange={setColorPickerOpen}
        currentColor={color}
        onColorChange={(c) => onColorChange(c ?? undefined)}
      />
      <IconPickerDialog
        open={iconPickerOpen}
        onOpenChange={setIconPickerOpen}
        currentIcon={icon}
        onIconChange={(i) => onIconChange(i ?? undefined)}
      />
    </div>
  );
}
