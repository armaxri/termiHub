import { useState } from "react";
import { Button, Modal, ModalClose } from "@/components/ui";
import { ConnectionIconStyleSettings } from "@/components/ConnectionEditor/ConnectionIconStyleSettings";
import { FolderIcon } from "@/utils/connectionIcons";
import { isSingleEmoji, isValidIconColor } from "@/utils/connectionIconStyle";
import type { ConnectionFolder } from "@/types/connection";
import "./FolderAppearanceDialog.css";

const FORM_ID = "folder-appearance-form";

export interface FolderAppearanceDialogProps {
  /** The folder being styled; `null` keeps the dialog closed. */
  folder: ConnectionFolder | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the folder carrying its new icon style; the dialog then closes. */
  onSave: (folder: ConnectionFolder) => void;
}

/**
 * Small dialog behind a folder's "Appearance…" context-menu entry (#5020): the
 * connection editor's icon colour swatches and emoji picker, with a live
 * preview of the folder row.
 */
export function FolderAppearanceDialog({
  folder,
  onOpenChange,
  onSave,
}: FolderAppearanceDialogProps) {
  return (
    <Modal
      open={folder !== null}
      onOpenChange={onOpenChange}
      title="Folder Appearance"
      description="Choose an icon color and emoji for this folder."
      data-testid="folder-appearance-dialog"
      footer={
        <>
          <ModalClose>
            <Button variant="secondary" data-testid="folder-appearance-cancel">
              Cancel
            </Button>
          </ModalClose>
          <Button
            type="submit"
            form={FORM_ID}
            variant="primary"
            data-testid="folder-appearance-save"
          >
            Save
          </Button>
        </>
      }
    >
      {/* Keyed so each opening starts from the folder's saved style. */}
      {folder && (
        <FolderAppearanceForm
          key={folder.id}
          folder={folder}
          onSave={(next) => {
            onSave(next);
            onOpenChange(false);
          }}
        />
      )}
    </Modal>
  );
}

/** The form body; owns the draft style so the dialog resets per folder. */
function FolderAppearanceForm({
  folder,
  onSave,
}: {
  folder: ConnectionFolder;
  onSave: (folder: ConnectionFolder) => void;
}) {
  const [iconColor, setIconColor] = useState<string | undefined>(
    folder.iconColor && isValidIconColor(folder.iconColor) ? folder.iconColor : undefined
  );
  const [iconEmoji, setIconEmoji] = useState<string | undefined>(folder.iconEmoji ?? undefined);
  const emojiError = iconEmoji && !isSingleEmoji(iconEmoji) ? "Enter a single emoji." : null;

  const save = () => {
    if (emojiError) return;
    // Spread so name and expansion travel unchanged; unset keys are dropped
    // so the backend stores nothing for them.
    const next: ConnectionFolder = { ...folder, iconColor, iconEmoji };
    if (!iconColor) delete next.iconColor;
    if (!iconEmoji) delete next.iconEmoji;
    onSave(next);
  };

  return (
    <form
      id={FORM_ID}
      className="folder-appearance"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="folder-appearance__preview" data-testid="folder-appearance-preview">
        <FolderIcon iconColor={iconColor} iconEmoji={emojiError ? undefined : iconEmoji} />
        <span className="folder-appearance__name">{folder.name}</span>
      </div>
      <ConnectionIconStyleSettings
        iconColor={iconColor}
        onIconColorChange={setIconColor}
        iconEmoji={iconEmoji}
        onIconEmojiChange={setIconEmoji}
        iconEmojiError={emojiError}
        colorHint="Tints the folder icon in the sidebar. Colors are adjusted to stay readable in light and dark themes."
        emojiHint="One emoji shown instead of the folder icon. Choose one from the picker, or type or paste it."
      />
    </form>
  );
}
