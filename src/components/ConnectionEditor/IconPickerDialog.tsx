import { useState, useEffect, useMemo } from "react";
import { Modal, Button, SearchInput, EmptyState } from "@/components/ui";
import { useListFilter, type ListFilterMatcher } from "@/hooks/useListFilter";
import { getIconCatalog, IconByName, type IconCatalogEntry } from "@/utils/connectionIcons";
import "./IconPickerDialog.css";

interface IconPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentIcon: string | undefined;
  onIconChange: (icon: string | null) => void;
}

/**
 * Case-insensitive match of an icon catalog entry against the (already
 * normalized) query on its display name or any tag. Module-level so the
 * {@link useListFilter} memo stays stable across renders.
 */
const iconMatches: ListFilterMatcher<IconCatalogEntry> = (entry, query) => {
  if (!query) return true;
  return (
    entry.displayName.toLowerCase().includes(query) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(query))
  );
};

/**
 * Dialog for picking a connection icon with text search and scrollable grid.
 */
export function IconPickerDialog({
  open,
  onOpenChange,
  currentIcon,
  onIconChange,
}: IconPickerDialogProps) {
  const [selected, setSelected] = useState<string | null>(currentIcon ?? null);

  const catalog = useMemo(() => getIconCatalog(), []);
  const { query, setQuery, filtered } = useListFilter(catalog, iconMatches);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(currentIcon ?? null);
    }
  }, [open, currentIcon, setQuery]);

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
      <SearchInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search icons..."
        clearLabel="Clear icon search"
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
        {filtered.length === 0 && <EmptyState title="No icons match your search." />}
        {filtered.length > 200 && (
          <div className="icon-picker__hint">
            Showing 200 of {filtered.length} results. Refine your search.
          </div>
        )}
      </div>
    </Modal>
  );
}
