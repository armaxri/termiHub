import { useCallback, useMemo, useState } from "react";
import { SplitSquareHorizontal, SplitSquareVertical, Plus, X, RotateCcw } from "lucide-react";
import { NumberInput, Tooltip } from "@/components/ui";
import { WorkspaceLayoutNode, WorkspaceSplitNode, WorkspaceTabDef } from "@/types/workspace";
import {
  getWorkspaceLeaves,
  splitWorkspaceLeaf,
  addTabToLeaf,
  removeTabFromLeaf,
  removeWorkspaceLeaf,
  addLeafToSplit,
  wrapSplitInNewDirection,
  updateSplitSizes,
} from "@/utils/workspaceLayout";
import { ConnectionPicker } from "./ConnectionPicker";

/**
 * Build a map from leaf node reference to its depth-first index.
 * This is computed once per layout change and passed through the tree,
 * avoiding mutable counters that break under React StrictMode double-renders.
 */
function buildLeafIndexMap(node: WorkspaceLayoutNode): Map<WorkspaceLayoutNode, number> {
  const map = new Map<WorkspaceLayoutNode, number>();
  const leaves = getWorkspaceLeaves(node);
  leaves.forEach((leaf, idx) => map.set(leaf, idx));
  return map;
}

interface LayoutDesignerProps {
  layout: WorkspaceLayoutNode;
  onChange: (layout: WorkspaceLayoutNode) => void;
}

export function LayoutDesigner({ layout, onChange }: LayoutDesignerProps) {
  const [selectedLeaf, setSelectedLeaf] = useState<number>(0);
  const [pickerLeafIdx, setPickerLeafIdx] = useState<number | null>(null);
  const leafIndexMap = useMemo(() => buildLeafIndexMap(layout), [layout]);
  const leafCount = leafIndexMap.size;

  const handleSplit = useCallback(
    (leafIdx: number, direction: "horizontal" | "vertical") => {
      const { node, newLeafIndex } = splitWorkspaceLeaf(layout, leafIdx, direction);
      onChange(node);
      setSelectedLeaf(newLeafIndex);
    },
    [layout, onChange]
  );

  const handleAddTab = useCallback(
    (leafIdx: number, tab: WorkspaceTabDef) => {
      const result = addTabToLeaf(layout, leafIdx, tab);
      onChange(result);
      setPickerLeafIdx(null);
    },
    [layout, onChange]
  );

  const handleRemoveTab = useCallback(
    (leafIdx: number, tabIdx: number) => {
      const result = removeTabFromLeaf(layout, leafIdx, tabIdx);
      onChange(result);
    },
    [layout, onChange]
  );

  const handleRemoveLeaf = useCallback(
    (leafIdx: number) => {
      const result = removeWorkspaceLeaf(layout, leafIdx);
      if (result) {
        onChange(result);
        if (selectedLeaf >= getWorkspaceLeaves(result).length) {
          setSelectedLeaf(Math.max(0, getWorkspaceLeaves(result).length - 1));
        }
      }
    },
    [layout, selectedLeaf, onChange]
  );

  const handleSplitContainer = useCallback(
    (splitNode: WorkspaceSplitNode, direction: "horizontal" | "vertical") => {
      if (splitNode.direction === direction) {
        const result = addLeafToSplit(layout, splitNode);
        onChange(result);
      } else {
        const result = wrapSplitInNewDirection(layout, splitNode, direction);
        onChange(result);
      }
    },
    [layout, onChange]
  );

  const handleUpdateSizes = useCallback(
    (splitNode: WorkspaceSplitNode, sizes: number[] | null) => {
      const result = updateSplitSizes(layout, splitNode, sizes);
      onChange(result);
    },
    [layout, onChange]
  );

  return (
    <div className="layout-designer" data-testid="layout-designer">
      <div className="layout-designer__canvas" data-testid="layout-canvas">
        <LayoutNodePreview
          node={layout}
          leafIndexMap={leafIndexMap}
          selectedLeaf={selectedLeaf}
          leafCount={leafCount}
          onSelectLeaf={setSelectedLeaf}
          onRemoveTab={handleRemoveTab}
          onRemoveLeaf={handleRemoveLeaf}
          onSplit={handleSplit}
          onAddTab={setPickerLeafIdx}
          onSplitContainer={handleSplitContainer}
          onUpdateSizes={handleUpdateSizes}
        />
      </div>

      {pickerLeafIdx !== null && (
        <ConnectionPicker
          onSelect={(tab) => handleAddTab(pickerLeafIdx, tab)}
          onCancel={() => setPickerLeafIdx(null)}
        />
      )}
    </div>
  );
}

interface LayoutNodePreviewProps {
  node: WorkspaceLayoutNode;
  leafIndexMap: Map<WorkspaceLayoutNode, number>;
  selectedLeaf: number;
  leafCount: number;
  onSelectLeaf: (idx: number) => void;
  onRemoveTab: (leafIdx: number, tabIdx: number) => void;
  onRemoveLeaf: (leafIdx: number) => void;
  onSplit: (leafIdx: number, direction: "horizontal" | "vertical") => void;
  onAddTab: (leafIdx: number) => void;
  onSplitContainer: (splitNode: WorkspaceSplitNode, direction: "horizontal" | "vertical") => void;
  onUpdateSizes: (splitNode: WorkspaceSplitNode, sizes: number[] | null) => void;
}

function LayoutNodePreview({
  node,
  leafIndexMap,
  selectedLeaf,
  leafCount,
  onSelectLeaf,
  onRemoveTab,
  onRemoveLeaf,
  onSplit,
  onAddTab,
  onSplitContainer,
  onUpdateSizes,
}: LayoutNodePreviewProps) {
  if (node.type === "leaf") {
    const idx = leafIndexMap.get(node) ?? 0;

    return (
      <LeafPanel
        node={node}
        idx={idx}
        isSelected={idx === selectedLeaf}
        leafCount={leafCount}
        onSelect={() => onSelectLeaf(idx)}
        onRemoveTab={(tabIdx) => onRemoveTab(idx, tabIdx)}
        onRemove={() => onRemoveLeaf(idx)}
        onSplitH={() => onSplit(idx, "horizontal")}
        onSplitV={() => onSplit(idx, "vertical")}
        onAddTab={() => onAddTab(idx)}
      />
    );
  }

  const directionLabel = node.direction === "horizontal" ? "Horizontal" : "Vertical";
  const DirectionIcon =
    node.direction === "horizontal" ? SplitSquareHorizontal : SplitSquareVertical;
  const hasSizes = !!node.sizes;

  return (
    <div className="layout-split-container" data-testid={`layout-split-${node.direction}`}>
      <div className="layout-split-container__header">
        <span className="layout-split-container__label">
          <DirectionIcon size={10} />
          {directionLabel}
        </span>
        <div className="layout-split-container__actions">
          {hasSizes && (
            <Tooltip content="Reset to Equal" side="top">
              <button
                className="layout-split-container__action"
                onClick={() => onUpdateSizes(node, null)}
                aria-label="Reset to Equal"
                data-testid="layout-size-reset"
              >
                <RotateCcw size={10} />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Split Horizontal" side="top">
            <button
              className="layout-split-container__action"
              onClick={() => onSplitContainer(node, "horizontal")}
              aria-label="Split Horizontal"
            >
              <SplitSquareHorizontal size={10} />
            </button>
          </Tooltip>
          <Tooltip content="Split Vertical" side="top">
            <button
              className="layout-split-container__action"
              onClick={() => onSplitContainer(node, "vertical")}
              aria-label="Split Vertical"
            >
              <SplitSquareVertical size={10} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div
        className={`layout-split-container__content layout-split-container__content--${node.direction}`}
      >
        {node.children.map((child, i) => {
          const size = node.sizes?.[i] ?? 100 / node.children.length;
          return (
            <div key={i} className="layout-split-container__child" style={{ flex: size }}>
              <SizeBadge
                size={size}
                isCustom={hasSizes}
                splitNode={node}
                childIndex={i}
                onUpdateSizes={onUpdateSizes}
              />
              <LayoutNodePreview
                node={child}
                leafIndexMap={leafIndexMap}
                selectedLeaf={selectedLeaf}
                leafCount={leafCount}
                onSelectLeaf={onSelectLeaf}
                onRemoveTab={onRemoveTab}
                onRemoveLeaf={onRemoveLeaf}
                onSplit={onSplit}
                onAddTab={onAddTab}
                onSplitContainer={onSplitContainer}
                onUpdateSizes={onUpdateSizes}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SizeBadgeProps {
  size: number;
  isCustom: boolean;
  splitNode: WorkspaceSplitNode;
  childIndex: number;
  onUpdateSizes: (splitNode: WorkspaceSplitNode, sizes: number[] | null) => void;
}

function SizeBadge({ size, isCustom, splitNode, childIndex, onUpdateSizes }: SizeBadgeProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState<number | "">("");

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(Math.round(size));
    setEditing(true);
  };

  const handleCommit = () => {
    setEditing(false);
    if (editValue === "" || editValue < 10) return;
    const newSize = editValue;

    const count = splitNode.children.length;
    const currentSizes = splitNode.sizes ?? Array(count).fill(100 / count);
    const oldSize = currentSizes[childIndex];
    const diff = newSize - oldSize;

    // Redistribute the difference proportionally among siblings
    const otherTotal = currentSizes.reduce((sum, s, i) => (i === childIndex ? sum : sum + s), 0);
    const newSizes = currentSizes.map((s, i) => {
      if (i === childIndex) return newSize;
      if (otherTotal === 0) return (100 - newSize) / (count - 1);
      return Math.max(10, s - (diff * s) / otherTotal);
    });

    // Normalize to sum to 100
    const total = newSizes.reduce((a, b) => a + b, 0);
    const normalized = newSizes.map((s) => (s / total) * 100);

    onUpdateSizes(splitNode, normalized);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleCommit();
    if (e.key === "Escape") setEditing(false);
  };

  if (editing) {
    return (
      <NumberInput
        className="layout-size-input"
        min={10}
        max={90}
        value={editValue}
        onValueChange={setEditValue}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
        autoFocus
        onClick={(e) => e.stopPropagation()}
        data-testid="layout-size-input"
      />
    );
  }

  return (
    <Tooltip content="Click to edit size" side="top">
      <button
        className={`layout-size-badge ${isCustom ? "layout-size-badge--custom" : ""}`}
        onClick={handleStartEdit}
        aria-label="Click to edit size"
        data-testid="layout-size-badge"
      >
        {Math.round(size)}%
      </button>
    </Tooltip>
  );
}

interface LeafPanelProps {
  node: WorkspaceLayoutNode & { type: "leaf" };
  idx: number;
  isSelected: boolean;
  leafCount: number;
  onSelect: () => void;
  onRemoveTab: (tabIdx: number) => void;
  onRemove: () => void;
  onSplitH: () => void;
  onSplitV: () => void;
  onAddTab: () => void;
}

function LeafPanel({
  node,
  idx,
  isSelected,
  leafCount,
  onSelect,
  onRemoveTab,
  onRemove,
  onSplitH,
  onSplitV,
  onAddTab,
}: LeafPanelProps) {
  const className = ["layout-leaf", isSelected && "layout-leaf--selected"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} onClick={onSelect} data-testid={`layout-leaf-${idx}`}>
      <div className="layout-leaf__header">
        <div className="layout-leaf__actions">
          <Tooltip content="Split Horizontal" side="top">
            <button
              className="layout-leaf__action"
              onClick={(e) => {
                e.stopPropagation();
                onSplitH();
              }}
              aria-label="Split Horizontal"
              data-testid={`layout-leaf-split-h-${idx}`}
            >
              <SplitSquareHorizontal size={10} />
            </button>
          </Tooltip>
          <Tooltip content="Split Vertical" side="top">
            <button
              className="layout-leaf__action"
              onClick={(e) => {
                e.stopPropagation();
                onSplitV();
              }}
              aria-label="Split Vertical"
              data-testid={`layout-leaf-split-v-${idx}`}
            >
              <SplitSquareVertical size={10} />
            </button>
          </Tooltip>
          <Tooltip content="Add Connection" side="top">
            <button
              className="layout-leaf__action"
              onClick={(e) => {
                e.stopPropagation();
                onAddTab();
              }}
              aria-label="Add Connection"
              data-testid={`layout-leaf-add-tab-${idx}`}
            >
              <Plus size={10} />
            </button>
          </Tooltip>
        </div>
        {leafCount > 1 && (
          <Tooltip content="Remove Panel" side="top">
            <button
              className="layout-leaf__remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              aria-label="Remove Panel"
              data-testid={`layout-remove-leaf-${idx}`}
            >
              <X size={10} />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="layout-leaf__tabs">
        {node.tabs.length === 0 ? (
          <span className="layout-leaf__empty">Click + to add a connection</span>
        ) : (
          node.tabs.map((tab, tabIdx) => (
            <div key={tabIdx} className="layout-tab">
              <span className="layout-tab__name">
                {tab.title ?? tab.connectionRef ?? "Inline Connection"}
              </span>
              <Tooltip content="Remove Tab" side="top">
                <button
                  className="layout-tab__remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveTab(tabIdx);
                  }}
                  aria-label="Remove Tab"
                  data-testid={`layout-remove-tab-${idx}-${tabIdx}`}
                >
                  <X size={10} />
                </button>
              </Tooltip>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
