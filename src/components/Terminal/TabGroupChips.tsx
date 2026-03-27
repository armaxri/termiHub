import { useState, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useAppStore } from "@/store/appStore";
import { TabGroup } from "@/types/terminal";
import { RenameDialog } from "./RenameDialog";
import "./TabGroupChips.css";

/**
 * Toolbar chip area for workspace-level tab groups.
 * Hidden when only one group exists (returns null).
 * Chips are pill-shaped to distinguish them from file-tab-shaped terminal tabs.
 */
export function TabGroupChips() {
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  const setActiveTabGroup = useAppStore((s) => s.setActiveTabGroup);
  const addTabGroup = useAppStore((s) => s.addTabGroup);
  const closeTabGroup = useAppStore((s) => s.closeTabGroup);
  const renameTabGroup = useAppStore((s) => s.renameTabGroup);
  const reorderTabGroups = useAppStore((s) => s.reorderTabGroups);
  const draggingTabId = useAppStore((s) => s.draggingTabId);

  const [renameGroupId, setRenameGroupId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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

  const handleClose = useCallback(
    (groupId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      closeTabGroup(groupId);
    },
    [closeTabGroup]
  );

  const renameGroup = tabGroups.find((g) => g.id === renameGroupId);

  return (
    <div className="tab-group-chips">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext
          items={tabGroups.map((g) => g.id)}
          strategy={horizontalListSortingStrategy}
        >
          {tabGroups.map((group) => (
            <TabGroupChip
              key={group.id}
              group={group}
              isActive={group.id === activeTabGroupId}
              canClose={tabGroups.length > 1}
              isDropTarget={!!draggingTabId && group.id !== activeTabGroupId}
              onClick={() => setActiveTabGroup(group.id)}
              onClose={(e) => handleClose(group.id, e)}
              onRename={() => setRenameGroupId(group.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        className="tab-group-chips__add"
        onClick={() => addTabGroup()}
        title="New Tab Group (Ctrl+Shift+T)"
        data-testid="tab-group-add"
      >
        <Plus size={14} />
      </button>
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
  onClose: (e: React.MouseEvent) => void;
  onRename: () => void;
}

function TabGroupChip({
  group,
  isActive,
  canClose,
  isDropTarget,
  onClick,
  onClose,
  onRename,
}: TabGroupChipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={`tab-group-chip${isActive ? " tab-group-chip--active" : ""}${isDropTarget ? " tab-group-chip--drop-target" : ""}`}
          onClick={onClick}
          onDoubleClick={onRename}
          title={group.name}
          data-testid={`tab-group-chip-${group.id}`}
          data-tab-group-id={group.id}
        >
          {group.color && (
            <span className="tab-group-chip__dot" style={{ backgroundColor: group.color }} />
          )}
          <span className="tab-group-chip__name">{group.name}</span>
          {canClose && (
            <span
              className="tab-group-chip__close"
              onClick={onClose}
              data-testid="tab-group-chip-close"
              role="button"
              aria-label={`Close ${group.name}`}
            >
              <X size={12} />
            </span>
          )}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="context-menu__content">
          <ContextMenu.Item
            className="context-menu__item"
            onSelect={onRename}
            data-testid="tab-group-ctx-rename"
          >
            Rename
          </ContextMenu.Item>
          {canClose && (
            <>
              <ContextMenu.Separator className="context-menu__separator" />
              <ContextMenu.Item
                className="context-menu__item"
                onSelect={(e) => onClose(e as unknown as React.MouseEvent)}
                data-testid="tab-group-ctx-close"
              >
                Close Group
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
