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
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui";
import { bookmarksForScope, useFileBookmarksStore } from "@/store/fileBookmarksStore";
import type { FileBookmark } from "@/types/fileBookmark";
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

/** The current scope's bookmarks, the one for `currentPath`, and add/remove actions. */
function useScopedBookmarks(scope: string | null, currentPath: string) {
  const allBookmarks = useFileBookmarksStore((s) => s.bookmarks);
  const loaded = useFileBookmarksStore((s) => s.loaded);
  const load = useFileBookmarksStore((s) => s.load);
  const add = useFileBookmarksStore((s) => s.add);
  const remove = useFileBookmarksStore((s) => s.remove);

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

  return { bookmarks, current, handleAdd, handleRemoveCurrent };
}

/** Props of the shared bookmark menu rows. */
interface BookmarkEntriesProps {
  scope: string | null;
  currentPath: string;
  bookmarks: FileBookmark[];
  current: FileBookmark | null;
  onAdd: () => void;
  onRemoveCurrent: () => void;
  onNavigate: (path: string) => void;
  onManage: () => void;
}

/** The bookmark rows, shared by the toolbar drop-down and the overflow sub-menu. */
function BookmarkEntries({
  scope,
  currentPath,
  bookmarks,
  current,
  onAdd,
  onRemoveCurrent,
  onNavigate,
  onManage,
}: BookmarkEntriesProps) {
  if (scope === null) {
    return (
      <MenuItem disabled data-testid="file-bookmarks-unavailable">
        Bookmarks need a saved connection
      </MenuItem>
    );
  }
  return (
    <>
      {current ? (
        <MenuItem onSelect={onRemoveCurrent} data-testid="file-bookmarks-remove-current">
          <BookmarkMinus size={14} /> Remove bookmark for this folder
        </MenuItem>
      ) : (
        <MenuItem disabled={!currentPath} onSelect={onAdd} data-testid="file-bookmarks-add">
          <BookmarkPlus size={14} /> Bookmark this folder
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
        onSelect={onManage}
        data-testid="file-bookmarks-manage"
      >
        <ListChecks size={14} /> Manage bookmarks…
      </MenuItem>
    </>
  );
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
  const { bookmarks, current, handleAdd, handleRemoveCurrent } = useScopedBookmarks(
    scope,
    currentPath
  );
  const [manageOpen, setManageOpen] = useState(false);

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
          <BookmarkEntries
            scope={scope}
            currentPath={currentPath}
            bookmarks={bookmarks}
            current={current}
            onAdd={() => void handleAdd()}
            onRemoveCurrent={() => void handleRemoveCurrent()}
            onNavigate={onNavigate}
            onManage={() => setManageOpen(true)}
          />
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

/** Props for {@link FileBookmarksSubmenu}. */
export interface FileBookmarksSubmenuProps {
  /** The current connection's bookmark scope; `null` when it cannot be scoped. */
  scope: string | null;
  /** The directory the browser is showing. */
  currentPath: string;
  /** Navigate the browser to a bookmarked directory. */
  onNavigate: (path: string) => void;
  /**
   * Open the manage dialog. The sub-menu unmounts when its parent menu closes,
   * so the dialog lives with the caller ({@link FileBookmarksManageDialog}).
   */
  onManage: () => void;
  /** Test id of the sub-menu trigger row. */
  testId?: string;
}

/**
 * The bookmarks as a "Bookmarks ▸" sub-menu of another drop-down — the file
 * browser's overflow "…" menu (#5520). Same rows as {@link FileBookmarksMenu}.
 */
export function FileBookmarksSubmenu({
  scope,
  currentPath,
  onNavigate,
  onManage,
  testId = "file-browser-bookmarks",
}: FileBookmarksSubmenuProps) {
  const { bookmarks, current, handleAdd, handleRemoveCurrent } = useScopedBookmarks(
    scope,
    currentPath
  );
  return (
    <MenuSub>
      <MenuSubTrigger
        icon={current ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
        data-testid={testId}
      >
        Bookmarks
      </MenuSubTrigger>
      <MenuSubContent
        className="file-bookmarks__menu"
        sideOffset={4}
        data-testid="file-bookmarks-menu"
      >
        <BookmarkEntries
          scope={scope}
          currentPath={currentPath}
          bookmarks={bookmarks}
          current={current}
          onAdd={() => void handleAdd()}
          onRemoveCurrent={() => void handleRemoveCurrent()}
          onNavigate={onNavigate}
          onManage={onManage}
        />
      </MenuSubContent>
    </MenuSub>
  );
}

/** Props for {@link FileBookmarksManageDialog}. */
export interface FileBookmarksManageDialogProps {
  scope: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
}

/** The manage dialog for one scope, owned by the caller of {@link FileBookmarksSubmenu}. */
export function FileBookmarksManageDialog({
  scope,
  open,
  onOpenChange,
  onNavigate,
}: FileBookmarksManageDialogProps) {
  const allBookmarks = useFileBookmarksStore((s) => s.bookmarks);
  const bookmarks = useMemo(() => bookmarksForScope(allBookmarks, scope), [allBookmarks, scope]);
  if (!open) return null;
  return (
    <FileBookmarksDialog
      open={open}
      onOpenChange={onOpenChange}
      bookmarks={bookmarks}
      onOpen={(path) => {
        onOpenChange(false);
        onNavigate(path);
      }}
    />
  );
}
