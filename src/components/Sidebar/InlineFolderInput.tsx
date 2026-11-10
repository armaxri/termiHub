import { useId, useState } from "react";
import { Folder, Check, X } from "lucide-react";
import { Button, Input, Tooltip } from "@/components/ui";
import { isImeComposing } from "@/utils/imeComposition";

/**
 * How the inline input was dismissed without committing: Escape, the Cancel
 * button, or focus leaving it. A caller returns focus to the tree row on the
 * first two only — a blur means the user already put focus somewhere else.
 */
export type InlineFolderCancelReason = "escape" | "button" | "blur";

interface InlineFolderInputProps {
  depth: number;
  onConfirm: (name: string) => void;
  onCancel: (reason: InlineFolderCancelReason) => void;
  /** Pre-filled (and pre-selected) name — set when renaming an existing folder (#5233). */
  initialName?: string;
  /**
   * Check a trimmed candidate name before it is confirmed. Return a message to
   * reject it (shown under the input, announced, and Enter is ignored), or
   * `null` to accept it.
   */
  validate?: (name: string) => string | null;
  /** Accessible name of the text field. */
  ariaLabel?: string;
}

export function InlineFolderInput({
  depth,
  onConfirm,
  onCancel,
  initialName = "",
  validate,
  ariaLabel = "Folder name",
}: InlineFolderInputProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = () => {
    const trimmed = name.trim();
    const problem = trimmed ? (validate?.(trimmed) ?? null) : validate ? "Enter a name." : null;
    if (problem) {
      setError(problem);
      return;
    }
    if (trimmed) onConfirm(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      // Keep the key away from the tree's own Enter/Escape handling.
      e.stopPropagation();
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onCancel("escape");
    }
  };

  return (
    <>
      <div
        className="connection-tree__folder connection-tree__folder--editing"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <Folder size={16} />
        <Input
          className="connection-tree__inline-input"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => onCancel("blur")}
          onFocus={(e) => {
            if (initialName) e.currentTarget.select();
          }}
          placeholder="Folder name"
          aria-label={ariaLabel}
          error={error !== null}
          aria-describedby={error ? errorId : undefined}
          autoFocus
          data-testid="inline-folder-name-input"
        />
        <Tooltip content="Confirm" side="top">
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            icon={<Check size={14} />}
            onMouseDown={(e) => {
              e.preventDefault();
              submit();
            }}
            aria-label="Confirm"
            data-testid="inline-folder-confirm"
          />
        </Tooltip>
        <Tooltip content="Cancel" side="top">
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            icon={<X size={14} />}
            onMouseDown={(e) => {
              e.preventDefault();
              onCancel("button");
            }}
            aria-label="Cancel"
            data-testid="inline-folder-cancel"
          />
        </Tooltip>
      </div>
      {error && (
        <div
          id={errorId}
          role="alert"
          className="connection-tree__inline-error"
          style={{ paddingLeft: `${depth * 16 + 8 + 20}px` }}
          data-testid="inline-folder-error"
        >
          {error}
        </div>
      )}
    </>
  );
}
