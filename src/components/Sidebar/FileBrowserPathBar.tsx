import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, Tooltip, Input } from "@/components/ui";
import { CollapsingBreadcrumbs } from "./FileBrowserBreadcrumbs";
import { isImeComposing } from "@/utils/imeComposition";

interface FileBrowserPathBarProps {
  /** The path currently shown by the file browser. */
  currentPath: string;
  /** Navigate the browser to an absolute path. */
  onNavigate: (path: string) => void;
}

/**
 * Editable breadcrumb path bar for the file browser.
 *
 * In its default state it renders `currentPath` as a row of clickable
 * breadcrumb segments (each navigates to its cumulative path) that folds its
 * middle segments into "…" when the path is wider than the bar. Clicking the
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

  return (
    <div className="file-browser__path-bar">
      <CollapsingBreadcrumbs currentPath={currentPath} onNavigate={onNavigate} />
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
