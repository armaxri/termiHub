import { useCallback, useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, BookmarkCheck, BookmarkMinus, BookmarkPlus, ListChecks } from "lucide-react";
import { Button, Tooltip, toast } from "@/components/ui";
import { bookmarksForScope, useFileBookmarksStore } from "@/store/fileBookmarksStore";
import { errorMessage } from "@/utils/errorMessage";
import { FileBookmarksDialog } from "./FileBookmarksDialog";

/** Props for {@link FileBookmarksMenu}. */
export interface FileBookmarksMenuProps {
  /** The current connection's bookmark scope; `null` when it cannot be scoped. */
  scope: string | null;
  /** The directory the browser is showing. */
  currentPath: string;
  /** Navigate the browser to a bookmarked directory. */
  onNavigate: (path: string) => void;
}

/**
 * Toolbar dropdown for the file browser's per-connection bookmarks (PROD-007,
 * #3558): bookmark / un-bookmark the current folder, jump to a bookmark, and
 * open the manage dialog to rename or remove them. The trigger shows a filled
 * bookmark (and `aria-pressed`) while the current folder is bookmarked.
 */
export function FileBookmarksMenu({ scope, currentPath, onNavigate }: FileBookmarksMenuProps) {
  const allBookmarks = useFileBookmarksStore((s) => s.bookmarks);
  const loaded = useFileBookmarksStore((s) => s.loaded);
  const load = useFileBookmarksStore((s) => s.load);
  const add = useFileBookmarksStore((s) => s.add);
  const remove = useFileBookmarksStore((s) => s.remove);
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const bookmarks = useMemo(() => bookmarksForScope(allBookmarks, scope), [allBookmarks, scope]);
  const current = bookmarks.find((b) => b.path === currentPath) ?? null;

  const handleAdd = useCallback(async () => {
    if (!scope || !currentPath) return;
    try {
      const stored = await add(scope, currentPath);
      toast.success(`Bookmarked "${stored.name}"`);
    } catch (err) {
      toast.error(`Could not add bookmark: ${errorMessage(err)}`);
    }
  }, [add, scope, currentPath]);

  const handleRemoveCurrent = useCallback(async () => {
    if (!current) return;
    try {
      await remove(current.id);
      toast.success(`Removed bookmark "${current.name}"`);
    } catch (err) {
      toast.error(`Could not remove bookmark: ${errorMessage(err)}`);
    }
  }, [remove, current]);

  return (
    <>
      <DropdownMenu.Root>
        <Tooltip content={current ? `Bookmarked: ${current.name}` : "Bookmarks"} side="top">
          <DropdownMenu.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              icon={current ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
              aria-label="Bookmarks"
              aria-pressed={current !== null}
              data-testid="file-browser-bookmarks"
            />
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="context-menu__content file-bookmarks__menu"
            align="end"
            data-testid="file-bookmarks-menu"
          >
            {scope === null ? (
              <DropdownMenu.Item
                className="context-menu__item"
                disabled
                data-testid="file-bookmarks-unavailable"
              >
                Bookmarks need a saved connection
              </DropdownMenu.Item>
            ) : (
              <>
                {current ? (
                  <DropdownMenu.Item
                    className="context-menu__item"
                    onSelect={() => void handleRemoveCurrent()}
                    data-testid="file-bookmarks-remove-current"
                  >
                    <BookmarkMinus size={14} /> Remove Bookmark for This Folder
                  </DropdownMenu.Item>
                ) : (
                  <DropdownMenu.Item
                    className="context-menu__item"
                    disabled={!currentPath}
                    onSelect={() => void handleAdd()}
                    data-testid="file-bookmarks-add"
                  >
                    <BookmarkPlus size={14} /> Bookmark This Folder
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Separator className="context-menu__separator" />
                {bookmarks.length === 0 ? (
                  <DropdownMenu.Item
                    className="context-menu__item"
                    disabled
                    data-testid="file-bookmarks-empty"
                  >
                    No bookmarks yet
                  </DropdownMenu.Item>
                ) : (
                  <DropdownMenu.Group aria-label="Bookmarked folders">
                    {bookmarks.map((b) => (
                      <DropdownMenu.Item
                        key={b.id}
                        className="context-menu__item file-bookmarks__item"
                        onSelect={() => onNavigate(b.path)}
                        title={b.path}
                        data-testid={`file-bookmark-item-${b.id}`}
                      >
                        {b.id === current?.id ? (
                          <BookmarkCheck size={14} aria-hidden="true" />
                        ) : (
                          <Bookmark size={14} aria-hidden="true" />
                        )}
                        <span className="file-bookmarks__name">{b.name}</span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Group>
                )}
                <DropdownMenu.Separator className="context-menu__separator" />
                <DropdownMenu.Item
                  className="context-menu__item"
                  disabled={bookmarks.length === 0}
                  onSelect={() => setManageOpen(true)}
                  data-testid="file-bookmarks-manage"
                >
                  <ListChecks size={14} /> Manage Bookmarks…
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {manageOpen && (
        <FileBookmarksDialog
          open={manageOpen}
          onOpenChange={setManageOpen}
          bookmarks={bookmarks}
          onOpen={(path) => {
            setManageOpen(false);
            onNavigate(path);
          }}
        />
      )}
    </>
  );
}
