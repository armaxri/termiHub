import { ChevronDown, FileInput, FolderPlus, Plus } from "lucide-react";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
  Tooltip,
} from "@/components/ui";
import { useOpenAfterMenuClose } from "./useOpenAfterMenuClose";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Props for {@link ConnectionsNewMenu}. */
export interface ConnectionsNewMenuProps {
  /** Opens the new-connection editor. */
  onNewConnection: () => void;
  /** Shows the inline new-folder input (runs once the menu has closed). */
  onNewFolder: () => void;
  /** Opens Settings ▸ Import & Migration (#5195). */
  onImport: () => void;
}

/**
 * The Saved header's one "New ▾" menu (#5848, R-022/R-096).
 *
 * It replaces three bare icons (new folder, "+", import) that a first-time
 * user could not tell apart without hovering each one. The trigger reads
 * "New", and each entry names what it creates. The item test ids are the ones
 * the icons had, so the harness keeps finding them once the menu is open.
 */
export function ConnectionsNewMenu({
  onNewConnection,
  onNewFolder,
  onImport,
}: ConnectionsNewMenuProps) {
  // The folder input would lose focus to the trigger as the menu closes and
  // cancel itself on blur, so it opens only after the menu has closed.
  const newFolder = useOpenAfterMenuClose(onNewFolder);
  return (
    <DropdownMenuRoot>
      <Tooltip content="New connection, folder or import" side="top">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={ICON_SIZE.sm} />}
            aria-label="New"
            className="connection-list__new-menu"
            data-testid="connection-list-new-menu"
          >
            New
            <ChevronDown size={ICON_SIZE.xs} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        onCloseAutoFocus={newFolder.onCloseAutoFocus}
        data-testid="connection-list-new-menu-content"
      >
        <MenuItem
          icon={<Plus size={ICON_SIZE.sm} />}
          onSelect={onNewConnection}
          data-testid="connection-list-new-connection"
        >
          New connection
        </MenuItem>
        <MenuItem
          icon={<FolderPlus size={ICON_SIZE.sm} />}
          onSelect={newFolder.request}
          data-testid="connection-list-new-folder"
        >
          New folder
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<FileInput size={ICON_SIZE.sm} />}
          onSelect={onImport}
          data-testid="connection-list-open-import-settings"
        >
          Import connections…
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
