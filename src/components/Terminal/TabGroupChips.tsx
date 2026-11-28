import { useState, useCallback } from "react";
import { ArrowLeft, ArrowRight, Layers, Palette, X } from "lucide-react";
import { DndContext, DragEndEvent, useSensor, useSensors } from "@dnd-kit/core";
import { ReleaseScopedPointerSensor } from "@/utils/releaseScopedPointerSensor";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "@/store/appStore";
import { useActiveTabGroupId, useLayoutTabGroups } from "@/store/layoutSelectors";
import { TabGroup } from "@/types/terminal";
import { closeTabGroupGuarded } from "@/utils/tabGroupCloseGuard";
import { RenameDialog } from "./RenameDialog";
import { ColorPickerDialog } from "./ColorPickerDialog";
import {
  Tooltip,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "@/components/ui";
import { withActionAccelerator } from "@/services/keybindings";
import { ICON_SIZE } from "@/components/ui/iconSize";
import "./TabGroupChips.css";

/**
 * Toolbar chip area for workspace-level tab groups.
 *
 * Chips are pill-shaped to distinguish them from file-tab-shaped terminal tabs.
 * With a single group there is nothing to switch to, so no chip renders: a lone
 * "Main" pill read as a tab above an empty tab row (#5849, R-023). The add
 * control then reads "New tab group" in words, and once chips show it is an
 * icon after them. Either way its glyph is a stack, never a "+": the toolbar's
 * only "+" opens a new terminal. The control stays rendered in both states
 * because dropping a dragged tab on it moves the tab into a new group.
 */
export function TabGroupChips() {
  const tabGroups = useLayoutTabGroups();
  const activeTabGroupId = useActiveTabGroupId();
  const setActiveTabGroup = useAppStore((s) => s.setActiveTabGroup);
  const addTabGroup = useAppStore((s) => s.addTabGroup);
  const renameTabGroup = useAppStore((s) => s.renameTabGroup);
  const setTabGroupColor = useAppStore((s) => s.setTabGroupColor);
  const reorderTabGroups = useAppStore((s) => s.reorderTabGroups);
  const draggingTabId = useAppStore((s) => s.draggingTabId);

  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);
  const [colorGroupId, setColorGroupId] = useState<string | null>(null);
  const newTabGroupText = "New tab group";
  const newTabGroupLabel = withActionAccelerator(newTabGroupText, "new-tab-group");
  const showChips = tabGroups.length > 1;

  const sensors = useSensors(
    useSensor(ReleaseScopedPointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = tabGroups.findIndex((g) => g.id === active.id);
      const toIndex = tabGroups.findIndex((g) => g.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        reorderTabGroups(fromIndex, toIndex);
      }
    },
    [tabGroups, reorderTabGroups]
  );

  // Both the chip X and the "Close group" item go through the shared guard, which
  // confirms before ending the group's live sessions or unsaved editors (UX2-001).
  const handleClose = useCallback((groupId: string, e: React.SyntheticEvent) => {
    e.stopPropagation();
    closeTabGroupGuarded(groupId);
  }, []);

  const renameGroup = tabGroups.find((g) => g.id === renameGroupId);

  return (
    <div className="tab-group-chips" data-testid="tab-group-chips">
      {showChips && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={tabGroups.map((g) => g.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabGroups.map((group, index) => (
              <TabGroupChip
                key={group.id}
                group={group}
                isActive={group.id === activeTabGroupId}
                canClose={tabGroups.length > 1}
                isDropTarget={!!draggingTabId && group.id !== activeTabGroupId}
                onClick={() => setActiveTabGroup(group.id)}
                onClose={(e) => handleClose(group.id, e)}
                onRename={() => setRenameGroupId(group.id)}
                onSetColor={() => setColorGroupId(group.id)}
                onMoveLeft={index > 0 ? () => reorderTabGroups(index, index - 1) : undefined}
                onMoveRight={
                  index < tabGroups.length - 1
                    ? () => reorderTabGroups(index, index + 1)
                    : undefined
                }
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
      <Tooltip content={newTabGroupLabel} side="bottom">
        <button
          className={`tab-group-chips__add${showChips ? "" : " tab-group-chips__add--labelled"}${draggingTabId ? " tab-group-chips__add--drop-target" : ""}`}
          onClick={() => addTabGroup()}
          aria-label={newTabGroupLabel}
          data-testid="tab-group-add"
          data-new-group-btn="true"
          data-icon="tab-group"
        >
          <Layers size={ICON_SIZE.sm} aria-hidden />
          {!showChips && <span className="tab-group-chips__add-text">{newTabGroupText}</span>}
        </button>
      </Tooltip>
      {/* The group's accent dot, as the tab-groups concept's chip menu offers (#6164). */}
      <ColorPickerDialog
        open={colorGroupId !== null}
        onOpenChange={(open) => {
          if (!open) setColorGroupId(null);
        }}
        currentColor={tabGroups.find((g) => g.id === colorGroupId)?.color}
        onColorChange={(color) => {
          if (colorGroupId) setTabGroupColor(colorGroupId, color);
        }}
      />
      <RenameDialog
        open={renameGroupId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameGroupId(null);
        }}
        currentTitle={renameGroup?.name ?? ""}
        onRename={(name) => {
          if (renameGroupId) renameTabGroup(renameGroupId, name);
          setRenameGroupId(null);
        }}
      />
    </div>
  );
}

interface TabGroupChipProps {
  group: TabGroup;
  isActive: boolean;
  canClose: boolean;
  isDropTarget: boolean;
  onClick: () => void;
  onClose: (e: React.SyntheticEvent) => void;
  onRename: () => void;
  /** Open the colour picker for the group's accent dot. */
  onSetColor: () => void;
  /**
   * Move the group one place left — the keyboard/menu alternative to dragging
   * its chip (#4329). Omitted on the first group, which disables the item.
   */
  onMoveLeft?: () => void;
  /** Move the group one place right (#4329). Omitted on the last group. */
  onMoveRight?: () => void;
}

function TabGroupChip({
  group,
  isActive,
  canClose,
  isDropTarget,
  onClick,
  onClose,
  onRename,
  onSetColor,
  onMoveLeft,
  onMoveRight,
}: TabGroupChipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
  });

  // Keyboard close (A11Y2-011): the X is a pointer-only glyph (a button nested
  // in the chip button is invalid), so Delete/Backspace on the focused chip
  // closes the group through the same guarded path.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      canClose &&
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      onClose(e);
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <button
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={`tab-group-chip${isActive ? " tab-group-chip--active" : ""}${isDropTarget ? " tab-group-chip--drop-target" : ""}`}
          onClick={onClick}
          onDoubleClick={onRename}
          onKeyDown={handleKeyDown}
          aria-keyshortcuts={canClose ? "Delete" : undefined}
          title={group.name}
          data-testid={`tab-group-chip-${group.id}`}
          data-tab-group-id={group.id}
        >
          {group.color && (
            <span className="tab-group-chip__dot" style={{ backgroundColor: group.color }} />
          )}
          <span className="tab-group-chip__name">{group.name}</span>
          {/* Pointer-only close glyph, hidden from assistive tech (A11Y2-011):
              keyboard users press Delete on the chip or use "Close group". */}
          {canClose && (
            <span
              className="tab-group-chip__close"
              onClick={onClose}
              data-testid="tab-group-chip-close"
              aria-hidden
            >
              <X size={ICON_SIZE.xs} />
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <MenuItem onSelect={onRename} data-testid="tab-group-ctx-rename">
          Rename
        </MenuItem>
        <MenuItem onSelect={onSetColor} data-testid="tab-group-ctx-color">
          <Palette size={ICON_SIZE.sm} /> Set color…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={!onMoveLeft}
          onSelect={() => onMoveLeft?.()}
          data-testid="tab-group-ctx-move-left"
        >
          <ArrowLeft size={ICON_SIZE.sm} /> Move left
        </MenuItem>
        <MenuItem
          disabled={!onMoveRight}
          onSelect={() => onMoveRight?.()}
          data-testid="tab-group-ctx-move-right"
        >
          <ArrowRight size={ICON_SIZE.sm} /> Move right
        </MenuItem>
        {canClose && (
          <>
            <MenuSeparator />
            <MenuItem
              onSelect={(e) => onClose(e as unknown as React.SyntheticEvent)}
              data-testid="tab-group-ctx-close"
            >
              Close group
            </MenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
