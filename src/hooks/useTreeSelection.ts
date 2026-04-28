import { useState, useCallback, useEffect } from "react";

export interface TreeSelectionResult {
  selectedIds: Set<string>;
  handleItemClick: (itemId: string, event: React.MouseEvent) => void;
  handleAreaClick: (event: React.MouseEvent) => void;
  clearSelection: () => void;
  selectSingle: (itemId: string) => void;
}

/**
 * Manages multi-select state for a connection tree (Ctrl/Cmd+Click toggle,
 * Shift+Click range, Escape deselect, click-on-empty deselect).
 *
 * @param flatVisibleIds - Item IDs in current visual order, used for Shift+Click range.
 */
export function useTreeSelection(flatVisibleIds: string[]): TreeSelectionResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedId(null);
  }, []);

  const selectSingle = useCallback((itemId: string) => {
    setSelectedIds(new Set([itemId]));
    setLastSelectedId(itemId);
  }, []);

  const handleItemClick = useCallback(
    (itemId: string, event: React.MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(itemId)) next.delete(itemId);
          else next.add(itemId);
          return next;
        });
        setLastSelectedId(itemId);
      } else if (event.shiftKey && lastSelectedId) {
        const anchorIdx = flatVisibleIds.indexOf(lastSelectedId);
        const targetIdx = flatVisibleIds.indexOf(itemId);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [start, end] =
            anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
          setSelectedIds(new Set(flatVisibleIds.slice(start, end + 1)));
        }
      } else {
        setSelectedIds(new Set([itemId]));
        setLastSelectedId(itemId);
      }
    },
    [flatVisibleIds, lastSelectedId]
  );

  const handleAreaClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".connection-tree__item")) {
      setSelectedIds(new Set());
      setLastSelectedId(null);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clearSelection]);

  return { selectedIds, handleItemClick, handleAreaClick, clearSelection, selectSingle };
}
