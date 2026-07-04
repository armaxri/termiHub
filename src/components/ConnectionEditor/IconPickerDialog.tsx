import { useState, useEffect, useMemo, useRef } from "react";
import { Modal, Button, Input } from "@/components/ui";
import { getIconCatalog, IconByName } from "@/utils/connectionIcons";
import "./IconPickerDialog.css";

interface IconPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentIcon: string | undefined;
  onIconChange: (icon: string | null) => void;
}

/**
 * Dialog for picking a connection icon with text search and scrollable grid.
 */
export function IconPickerDialog({
  open,
  onOpenChange,
  currentIcon,
  onIconChange,
}: IconPickerDialogProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(currentIcon ?? null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelected(currentIcon ?? null);
    }
  }, [open, currentIcon]);

  const catalog = useMemo(() => getIconCatalog(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return catalog;
    const q = search.toLowerCase();
    return catalog.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        e.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [catalog, search]);

  const handleApply = () => {
    onIconChange(selected);
    onOpenChange(false);
  };

  const handleClear = () => {
    onIconChange(null);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Choose Icon"
      footer={
        <>
          <Button variant="secondary" onClick={handleClear} data-testid="icon-picker-clear">
            Clear
          </Button>
          <Button variant="primary" onClick={handleApply} data-testid="icon-picker-apply">
            Apply
          </Button>
        </>
      }
    >
      <Input
        ref={searchRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search icons..."
        autoFocus
        data-testid="icon-picker-search"
      />

      <div className="icon-picker__grid" data-testid="icon-picker-grid">
        {filtered.slice(0, 200).map((entry) => (
          <button
            key={entry.name}
            className={`icon-picker__cell ${selected === entry.name ? "icon-picker__cell--active" : ""}`}
            onClick={() => setSelected(entry.name)}
            title={entry.displayName}
            data-testid={`icon-picker-cell-${entry.name}`}
          >
            <IconByName name={entry.name} size={20} />
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="icon-picker__empty">No icons match your search.</div>
        )}
        {filtered.length > 200 && (
          <div className="icon-picker__hint">
            Showing 200 of {filtered.length} results. Refine your search.
          </div>
        )}
      </div>
    </Modal>
  );
}
