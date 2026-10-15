import { useCallback, useEffect, useMemo, useState } from "react";
import { Bookmark, BookmarkCheck, BookmarkMinus, BookmarkPlus, ListChecks } from "lucide-react";
import {
  Button,
  Tooltip,
  toast,
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuGroup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui";
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
  /** Accessible label of the trigger (default "Bookmarks"). */
  label?: string;
  /** Test id of the trigger, distinct per menu when a view shows several. */
  testId?: string;
}

/**
 * Toolbar dropdown for the file browser's per-connection bookmarks (PROD-007,
 * #3558): bookmark / un-bookmark the current folder, jump to a bookmark, and
 * open the manage dialog to rename or remove them. The trigger shows a filled
 * bookmark (and `aria-pressed`) while the current folder is bookmarked.
 */
export function FileBookmarksMenu({
  scope,
  currentPath,
  onNavigate,
  label = "Bookmarks",
  testId = "file-browser-bookmarks",
}: FileBookmarksMenuProps) {
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
      <DropdownMenuRoot>
        <Tooltip content={current ? `Bookmarked: ${current.name}` : "Bookmarks"} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              icon={current ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
              aria-label={label}
              aria-pressed={current !== null}
              data-testid={testId}
            />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          className="file-bookmarks__menu"
          align="end"
          data-testid="file-bookmarks-menu"
        >
          {scope === null ? (
            <MenuItem disabled data-testid="file-bookmarks-unavailable">
              Bookmarks need a saved connection
            </MenuItem>
          ) : (
            <>
              {current ? (
                <MenuItem
                  onSelect={() => void handleRemoveCurrent()}
                  data-testid="file-bookmarks-remove-current"
                >
                  <BookmarkMinus size={14} /> Remove Bookmark for This Folder
                </MenuItem>
              ) : (
                <MenuItem
                  disabled={!currentPath}
                  onSelect={() => void handleAdd()}
                  data-testid="file-bookmarks-add"
                >
                  <BookmarkPlus size={14} /> Bookmark This Folder
                </MenuItem>
              )}
              <MenuSeparator />
              {bookmarks.length === 0 ? (
                <MenuItem disabled data-testid="file-bookmarks-empty">
                  No bookmarks yet
                </MenuItem>
              ) : (
                <MenuGroup aria-label="Bookmarked folders">
                  {bookmarks.map((b) => (
                    <MenuItem
                      key={b.id}
                      className="file-bookmarks__item"
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
                    </MenuItem>
                  ))}
                </MenuGroup>
              )}
              <MenuSeparator />
              <MenuItem
                disabled={bookmarks.length === 0}
                onSelect={() => setManageOpen(true)}
                data-testid="file-bookmarks-manage"
              >
                <ListChecks size={14} /> Manage Bookmarks…
              </MenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenuRoot>
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
