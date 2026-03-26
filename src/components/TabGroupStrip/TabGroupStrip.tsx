import { useState, useRef, useCallback } from "react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  useDroppable,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Plus, X, Pencil, Copy, ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { TabGroup } from "@/types/terminal";
import { RenameDialog } from "@/components/Terminal/RenameDialog";
import "./TabGroupStrip.css";

interface TabGroupStripProps {
  /** When a tab is being dragged, expose the dragged tab id so chips become drop targets. */
  activeDragTabId?: string | null;
}

/** Strip of tab group chips shown above the split-view area (hidden when only one group). */
export function TabGroupStrip({ activeDragTabId }: TabGroupStripProps) {
  const tabGroups = useAppStore((s) => s.tabGroups);
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId);
  const addTabGroup = useAppStore((s) => s.addTabGroup);
  const reorderTabGroups = useAppStore((s) => s.reorderTabGroups);

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

  if (tabGroups.length <= 1) return null;

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd} collisionDetection={closestCenter}>
      <SortableContext items={tabGroups.map((g) => g.id)} strategy={horizontalListSortingStrategy}>
        <div className="tab-group-strip" data-testid="tab-group-strip">
          {tabGroups.map((group) => (
            <TabGroupChip
              key={group.id}
              group={group}
              isActive={group.id === activeTabGroupId}
              isDropTarget={!!activeDragTabId}
            />
          ))}
          <button
            className="tab-group-strip__add"
            onClick={() => addTabGroup()}
            title="New Tab Group"
            data-testid="tab-group-add"
          >
            <Plus size={14} />
          </button>
        </div>
      </SortableContext>
    </DndContext>
  );
}

interface TabGroupChipProps {
  group: TabGroup;
  isActive: boolean;
  isDropTarget: boolean;
}

function TabGroupChip({ group, isActive, isDropTarget }: TabGroupChipProps) {
  const setActiveTabGroup = useAppStore((s) => s.setActiveTabGroup);
  const closeTabGroup = useAppStore((s) => s.closeTabGroup);
  const renameTabGroup = useAppStore((s) => s.renameTabGroup);
  const duplicateTabGroup = useAppStore((s) => s.duplicateTabGroup);
  const reorderTabGroups = useAppStore((s) => s.reorderTabGroups);
  const tabGroups = useAppStore((s) => s.tabGroups);

  const [renaming, setRenaming] = useState(false);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `tgchip-${group.id}`,
    disabled: !isDropTarget,
  });

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      setSortableRef(el);
      setDropRef(el);
    },
    [setSortableRef, setDropRef]
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    ...(group.color ? ({ "--chip-accent": group.color } as React.CSSProperties) : {}),
  };

  const handleDragEnter = () => {
    if (!isDropTarget) return;
    dwellTimerRef.current = setTimeout(() => setActiveTabGroup(group.id), 500);
  };

  const handleDragLeave = () => {
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeTabGroup(group.id);
  };

  const idx = tabGroups.findIndex((g) => g.id === group.id);
  const canMoveLeft = idx > 0;
  const canMoveRight = idx < tabGroups.length - 1;

  const chipElement = (
    <div
      ref={setRef}
      style={style}
      className={[
        "tab-group-chip",
        isActive ? "tab-group-chip--active" : "",
        isOver && isDropTarget ? "tab-group-chip--drop-over" : "",
        group.color ? "tab-group-chip--colored" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => setActiveTabGroup(group.id)}
      onDoubleClick={() => setRenaming(true)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      data-testid={`tab-group-chip-${group.id}`}
      title={group.name}
      {...attributes}
      {...listeners}
    >
      {group.color && <span className="tab-group-chip__dot" />}
      <span className="tab-group-chip__name">{group.name}</span>
      {tabGroups.length > 1 && (
        <button
          className="tab-group-chip__close"
          onClick={handleClose}
          title="Close Tab Group"
          data-testid={`tab-group-close-${group.id}`}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{chipElement}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="context-menu__content">
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => setRenaming(true)}
              data-testid={`tab-group-ctx-rename-${group.id}`}
            >
              <Pencil size={14} /> Rename
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              onSelect={() => duplicateTabGroup(group.id)}
              data-testid={`tab-group-ctx-duplicate-${group.id}`}
            >
              <Copy size={14} /> Duplicate
            </ContextMenu.Item>
            <ContextMenu.Separator className="context-menu__separator" />
            <ContextMenu.Item
              className="context-menu__item"
              disabled={!canMoveLeft}
              onSelect={() => canMoveLeft && reorderTabGroups(idx, idx - 1)}
              data-testid={`tab-group-ctx-move-left-${group.id}`}
            >
              <ChevronLeft size={14} /> Move Left
            </ContextMenu.Item>
            <ContextMenu.Item
              className="context-menu__item"
              disabled={!canMoveRight}
              onSelect={() => canMoveRight && reorderTabGroups(idx, idx + 1)}
              data-testid={`tab-group-ctx-move-right-${group.id}`}
            >
              <ChevronRight size={14} /> Move Right
            </ContextMenu.Item>
            {tabGroups.length > 1 && (
              <>
                <ContextMenu.Separator className="context-menu__separator" />
                <ContextMenu.Item
                  className="context-menu__item"
                  onSelect={() => closeTabGroup(group.id)}
                  data-testid={`tab-group-ctx-close-${group.id}`}
                >
                  <X size={14} /> Close
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <RenameDialog
        open={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(false);
        }}
        currentTitle={group.name}
        onRename={(name) => renameTabGroup(group.id, name)}
      />
    </>
  );
}
