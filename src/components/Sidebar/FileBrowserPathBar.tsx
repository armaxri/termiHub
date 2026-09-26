import { useEffect, useRef, useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { Button, Tooltip, Input } from "@/components/ui";
import { splitPathSegments } from "@/utils/fileBrowserNav";
import { useFileDropTarget } from "./fileBrowserDnd";

interface FileBrowserPathBarProps {
  /** The path currently shown by the file browser. */
  currentPath: string;
  /** Navigate the browser to an absolute path. */
  onNavigate: (path: string) => void;
}

interface CrumbProps {
  label: string;
  path: string;
  isCurrent: boolean;
  onNavigate: (path: string) => void;
}

/**
 * One breadcrumb segment. Besides navigating on click, each segment is a drop
 * target for drag-to-move (PROD-006), so a row can be dragged "up" into any
 * ancestor folder; it highlights valid vs refused drops.
 */
function Crumb({ label, path, isCurrent, onNavigate }: CrumbProps) {
  const { setNodeRef, highlight } = useFileDropTarget(`crumb:${path}`, path);
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`file-browser__crumb${highlight ? ` file-browser__crumb--drop-${highlight}` : ""}`}
      onClick={() => onNavigate(path)}
      disabled={isCurrent}
      data-testid="file-browser-crumb"
      data-drop-highlight={highlight ?? undefined}
    >
      {label}
    </button>
  );
}

/**
 * Editable breadcrumb path bar for the file browser.
 *
 * In its default state it renders `currentPath` as a row of clickable
 * breadcrumb segments (each navigates to its cumulative path). Clicking the
 * pencil affordance switches to a free-text input pre-filled with the current
 * path: Enter navigates to the typed path, Escape (or blur) cancels.
 */
export function FileBrowserPathBar({ currentPath, onNavigate }: FileBrowserPathBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentPath);
  const inputRef = useRef<HTMLInputElement>(null);

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

  if (editing) {
    return (
      <div className="file-browser__path-bar">
        <Input
          ref={inputRef}
          className="file-browser__path-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={cancel}
          aria-label="Edit path"
          data-testid="file-browser-path-input"
        />
      </div>
    );
  }

  const crumbs = splitPathSegments(currentPath);

  return (
    <div className="file-browser__path-bar">
      <nav
        className="file-browser__breadcrumbs"
        aria-label="Path"
        title={currentPath}
        data-testid="file-browser-current-path"
      >
        {crumbs.map((crumb, i) => (
          <span className="file-browser__crumb-group" key={crumb.path}>
            {i > 0 && <ChevronRight size={11} className="file-browser__crumb-sep" aria-hidden />}
            <Crumb
              label={crumb.label}
              path={crumb.path}
              isCurrent={crumb.path === currentPath}
              onNavigate={onNavigate}
            />
          </span>
        ))}
      </nav>
      <Tooltip content="Edit path" side="top">
        <Button
          variant="ghost"
          size="sm"
          className="file-browser__path-edit"
          icon={<Pencil size={12} />}
          onClick={() => setEditing(true)}
          aria-label="Edit path"
          data-testid="file-browser-path-edit"
        />
      </Tooltip>
    </div>
  );
}
