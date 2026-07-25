import { useState } from "react";
import { Folder, Check, X } from "lucide-react";
import { Input, Tooltip } from "@/components/ui";

interface InlineFolderInputProps {
  depth: number;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function InlineFolderInput({ depth, onConfirm, onCancel }: InlineFolderInputProps) {
  const [name, setName] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim()) {
      onConfirm(name.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div
      className="connection-tree__folder connection-tree__folder--editing"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <Folder size={16} />
      <Input
        className="connection-tree__inline-input"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder="Folder name"
        autoFocus
        data-testid="inline-folder-name-input"
      />
      <Tooltip content="Confirm" side="top">
        <button
          className="connection-tree__inline"
          onMouseDown={(e) => {
            e.preventDefault();
            if (name.trim()) onConfirm(name.trim());
          }}
          aria-label="Confirm"
          data-testid="inline-folder-confirm"
        >
          <Check size={14} />
        </button>
      </Tooltip>
      <Tooltip content="Cancel" side="top">
        <button
          className="connection-tree__inline"
          onMouseDown={(e) => {
            e.preventDefault();
            onCancel();
          }}
          aria-label="Cancel"
          data-testid="inline-folder-cancel"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
