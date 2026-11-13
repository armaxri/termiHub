import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Input } from "@/components/ui";
import { CollapsingBreadcrumbs } from "./FileBrowserBreadcrumbs";
import { isImeComposing } from "@/utils/imeComposition";
import { eventMatchesSingleBinding } from "@/services/keybindings";
import "./FileBrowserPathBar.css";

/**
 * Shortcut action that opens the path editor of the focused file browser or
 * transfer pane (#5540): Cmd+L / Ctrl+L, like file managers and browsers. It
 * never fires through the global shortcut engine (scope `file-browser`); the
 * surface owning the bar matches it with {@link isEditPathShortcut}.
 */
export const EDIT_PATH_ACTION = "edit-file-browser-path";

/** Whether `event` is the (possibly rebound) edit-path shortcut (#5540). */
export function isEditPathShortcut(event: React.KeyboardEvent | KeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  if (native.isComposing) return false;
  return eventMatchesSingleBinding(native, EDIT_PATH_ACTION);
}

/** Imperative handle of {@link FileBrowserPathBar}. */
export interface FileBrowserPathBarHandle {
  /** Switch to the path editor with the full path selected. */
  startEditing: () => void;
}

interface FileBrowserPathBarProps {
  /** The path currently shown by the file browser. */
  currentPath: string;
  /** Navigate the browser to an absolute path. */
  onNavigate: (path: string) => void;
  /**
   * Prefix of every `data-testid` (default `file-browser`): the bar renders
   * `<prefix>-current-path`, `<prefix>-crumb-*`, `<prefix>-path-edit` and
   * `<prefix>-path-input`.
   */
  testIdPrefix?: string;
  /** Accessible name of the breadcrumbs (default "Path"); the editor adds "Edit". */
  label?: string;
  /** No path to show or edit yet (an unconnected transfer pane). */
  disabled?: boolean;
  /** Breadcrumb segments are drag-to-move drop targets (default `true`). */
  dropTargets?: boolean;
  /** Copy the full path; offered in the folded segments' menu (#5624). */
  onCopyPath?: () => void;
}

/**
 * Editable breadcrumb path bar, shared by the sidebar file browser and the
 * transfer view's panes (#5521, #5541).
 *
 * In its default state it renders `currentPath` as a row of clickable
 * breadcrumb segments (each ancestor navigates to its cumulative path) that
 * folds its middle segments into "…" when the path is wider than the bar.
 * Clicking the current (leaf) folder or the empty space after the segments —
 * or pressing the edit-path shortcut, wired by the owning surface through the
 * imperative handle — switches to a free-text input holding the full path,
 * selected (#5540): Enter navigates to the typed path, Escape (or blur)
 * cancels. Both states keep the bar's fixed height.
 */
export const FileBrowserPathBar = forwardRef<FileBrowserPathBarHandle, FileBrowserPathBarProps>(
  function FileBrowserPathBar(
    {
      currentPath,
      onNavigate,
      testIdPrefix = "file-browser",
      label = "Path",
      disabled = false,
      dropTargets = true,
      onCopyPath,
    },
    ref
  ) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(currentPath);
    const inputRef = useRef<HTMLInputElement>(null);

    const startEditing = useCallback(() => {
      if (disabled) return;
      if (editing) {
        // Already editing (the shortcut again): re-select the whole path.
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      setEditing(true);
    }, [disabled, editing]);

    useImperativeHandle(ref, () => ({ startEditing }), [startEditing]);

    useEffect(() => {
      if (editing) {
        setDraft(currentPath);
        // Focus + select on the next frame so the freshly-mounted input is ready.
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    }, [editing, currentPath]);

    const commit = () => {
      const next = draft.trim();
      setEditing(false);
      if (next && next !== currentPath) onNavigate(next);
    };

    const cancel = () => {
      setEditing(false);
      setDraft(currentPath);
    };

    if (editing && !disabled) {
      return (
        <div className="file-browser__path-bar">
          <Input
            ref={inputRef}
            size="sm"
            className="file-browser__path-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                // Escape only leaves the editor; it must not also close a
                // surrounding dialog or clear a selection.
                e.stopPropagation();
                cancel();
              }
            }}
            onBlur={cancel}
            aria-label={`Edit ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
            title={currentPath}
            data-testid={`${testIdPrefix}-path-input`}
          />
        </div>
      );
    }

    return (
      <div
        className={`file-browser__path-bar${disabled ? " file-browser__path-bar--disabled" : ""}`}
      >
        <CollapsingBreadcrumbs
          currentPath={currentPath}
          onNavigate={onNavigate}
          onEdit={disabled ? undefined : startEditing}
          testIdPrefix={testIdPrefix}
          label={label}
          dropTargets={dropTargets}
          onCopyPath={onCopyPath}
        />
      </div>
    );
  }
);
