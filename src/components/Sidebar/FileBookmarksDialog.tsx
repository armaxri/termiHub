import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Pencil, Trash2 } from "lucide-react";
import { Button, Input, Modal, Tooltip, toast } from "@/components/ui";
import { useFileBookmarksStore } from "@/store/fileBookmarksStore";
import type { FileBookmark } from "@/types/fileBookmark";
import { errorMessage } from "@/utils/errorMessage";

/** Props for {@link FileBookmarksDialog}. */
export interface FileBookmarksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current connection's bookmarks. */
  bookmarks: FileBookmark[];
  /** Navigate to a bookmark (the caller closes the dialog). */
  onOpen: (path: string) => void;
}

/**
 * Manage one connection's file-browser bookmarks (PROD-007, #3558): open,
 * rename inline (Enter saves, Escape or leaving the field cancels) and remove.
 */
export function FileBookmarksDialog({
  open,
  onOpenChange,
  bookmarks,
  onOpen,
}: FileBookmarksDialogProps) {
  const rename = useFileBookmarksStore((s) => s.rename);
  const remove = useFileBookmarksStore((s) => s.remove);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renamingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renamingId]);

  // Escape while renaming cancels the rename; it must not also close the dialog.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && renamingId) return;
      onOpenChange(next);
    },
    [onOpenChange, renamingId]
  );

  const startRename = (b: FileBookmark) => {
    setDraft(b.name);
    setRenamingId(b.id);
  };

  const commitRename = async (b: FileBookmark) => {
    const name = draft.trim();
    setRenamingId(null);
    if (!name || name === b.name) return;
    try {
      await rename(b.id, name);
      toast.success(`Renamed bookmark to "${name}"`);
    } catch (err) {
      toast.error(`Could not rename bookmark: ${errorMessage(err)}`);
    }
  };

  const handleRemove = async (b: FileBookmark) => {
    try {
      await remove(b.id);
      toast.success(`Removed bookmark "${b.name}"`);
    } catch (err) {
      toast.error(`Could not remove bookmark: ${errorMessage(err)}`);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title="Bookmarks"
      description="Bookmarked folders for this connection"
      data-testid="file-bookmarks-dialog"
    >
      {bookmarks.length === 0 ? (
        <p className="file-bookmarks__empty">No bookmarks for this connection.</p>
      ) : (
        <ul className="file-bookmarks__list" aria-label="Bookmarked folders">
          {bookmarks.map((b) => (
            <li
              key={b.id}
              className="file-bookmarks__row"
              data-testid={`file-bookmark-row-${b.id}`}
            >
              <div className="file-bookmarks__text">
                {renamingId === b.id ? (
                  <Input
                    ref={inputRef}
                    size="sm"
                    value={draft}
                    aria-label={`New name for ${b.name}`}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => setRenamingId(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename(b);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    data-testid="file-bookmark-rename-input"
                  />
                ) : (
                  <span className="file-bookmarks__name">{b.name}</span>
                )}
                <span className="file-bookmarks__path" title={b.path}>
                  {b.path}
                </span>
              </div>
              <Tooltip content="Open" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<FolderOpen size={14} />}
                  aria-label={`Open ${b.name}`}
                  onClick={() => onOpen(b.path)}
                  data-testid={`file-bookmark-open-${b.id}`}
                />
              </Tooltip>
              <Tooltip content="Rename" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Pencil size={14} />}
                  aria-label={`Rename ${b.name}`}
                  onClick={() => startRename(b)}
                  data-testid={`file-bookmark-rename-${b.id}`}
                />
              </Tooltip>
              <Tooltip content="Remove" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  aria-label={`Remove ${b.name}`}
                  onClick={() => void handleRemove(b)}
                  data-testid={`file-bookmark-remove-${b.id}`}
                />
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
