import { useCallback, useState } from "react";
import { SplitSquareHorizontal, SplitSquareVertical, Plus, X } from "lucide-react";
import { WorkspaceLayoutNode, WorkspaceTabDef } from "@/types/workspace";
import {
  getWorkspaceLeaves,
  splitWorkspaceLeaf,
  addTabToLeaf,
  removeTabFromLeaf,
  removeWorkspaceLeaf,
  countWorkspaceTabs,
} from "@/utils/workspaceLayout";
import { ConnectionPicker } from "./ConnectionPicker";

interface LayoutDesignerProps {
  layout: WorkspaceLayoutNode;
  onChange: (layout: WorkspaceLayoutNode) => void;
}

export function LayoutDesigner({ layout, onChange }: LayoutDesignerProps) {
  const [selectedLeaf, setSelectedLeaf] = useState<number>(0);
  const [showConnectionPicker, setShowConnectionPicker] = useState(false);
  const leaves = getWorkspaceLeaves(layout);
  const totalTabs = countWorkspaceTabs(layout);

  const handleSplitH = useCallback(() => {
    const { node } = splitWorkspaceLeaf(layout, selectedLeaf, "horizontal");
    onChange(node);
  }, [layout, selectedLeaf, onChange]);

  const handleSplitV = useCallback(() => {
    const { node } = splitWorkspaceLeaf(layout, selectedLeaf, "vertical");
    onChange(node);
  }, [layout, selectedLeaf, onChange]);

  const handleAddTab = useCallback(() => {
    setShowConnectionPicker(true);
  }, []);

  const handleConnectionSelected = useCallback(
    (tab: WorkspaceTabDef) => {
      const result = addTabToLeaf(layout, selectedLeaf, tab);
      onChange(result);
      setShowConnectionPicker(false);
    },
    [layout, selectedLeaf, onChange]
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

  return (
    <div className="layout-designer" data-testid="layout-designer">
      <div className="layout-designer__toolbar">
        <button
          className="layout-designer__tool-btn"
          onClick={handleSplitH}
          title="Split Horizontal"
          data-testid="layout-split-h"
        >
          <SplitSquareHorizontal size={14} />
          Split H
        </button>
        <button
          className="layout-designer__tool-btn"
          onClick={handleSplitV}
          title="Split Vertical"
          data-testid="layout-split-v"
        >
          <SplitSquareVertical size={14} />
          Split V
        </button>
        <button
          className="layout-designer__tool-btn"
          onClick={handleAddTab}
          title="Add Tab"
          data-testid="layout-add-tab"
        >
          <Plus size={14} />
          Add Tab
        </button>
        <span className="layout-designer__info">
          {leaves.length} {leaves.length === 1 ? "panel" : "panels"}, {totalTabs}{" "}
          {totalTabs === 1 ? "tab" : "tabs"}
        </span>
      </div>

      <div className="layout-designer__canvas" data-testid="layout-canvas">
        <LayoutNodePreview
          node={layout}
          leafCounter={{ current: 0 }}
          selectedLeaf={selectedLeaf}
          onSelectLeaf={setSelectedLeaf}
          onRemoveTab={handleRemoveTab}
          onRemoveLeaf={handleRemoveLeaf}
        />
      </div>

      {showConnectionPicker && (
        <ConnectionPicker
          onSelect={handleConnectionSelected}
          onCancel={() => setShowConnectionPicker(false)}
        />
      )}
    </div>
  );
}

interface LayoutNodePreviewProps {
  node: WorkspaceLayoutNode;
  leafCounter: { current: number };
  selectedLeaf: number;
  onSelectLeaf: (idx: number) => void;
  onRemoveTab: (leafIdx: number, tabIdx: number) => void;
  onRemoveLeaf: (leafIdx: number) => void;
}

function LayoutNodePreview({
  node,
  leafCounter,
  selectedLeaf,
  onSelectLeaf,
  onRemoveTab,
  onRemoveLeaf,
}: LayoutNodePreviewProps) {
  if (node.type === "leaf") {
    const idx = leafCounter.current;
    leafCounter.current++;
    const isSelected = idx === selectedLeaf;

    return (
      <div
        className={`layout-leaf${isSelected ? " layout-leaf--selected" : ""}`}
        onClick={() => onSelectLeaf(idx)}
        data-testid={`layout-leaf-${idx}`}
      >
        <div className="layout-leaf__header">
          <span className="layout-leaf__label">Panel {idx + 1}</span>
          <button
            className="layout-leaf__remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveLeaf(idx);
            }}
            title="Remove Panel"
            data-testid={`layout-remove-leaf-${idx}`}
          >
            <X size={10} />
          </button>
        </div>
        <div className="layout-leaf__tabs">
          {node.tabs.length === 0 ? (
            <span className="layout-leaf__empty">Empty panel</span>
          ) : (
            node.tabs.map((tab, tabIdx) => (
              <div key={tabIdx} className="layout-tab">
                <span className="layout-tab__name">
                  {tab.title ?? tab.connectionRef ?? "Inline Connection"}
                </span>
                <button
                  className="layout-tab__remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveTab(idx, tabIdx);
                  }}
                  title="Remove Tab"
                  data-testid={`layout-remove-tab-${idx}-${tabIdx}`}
                >
                  <X size={10} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`layout-split layout-split--${node.direction}`}
      data-testid={`layout-split-${node.direction}`}
    >
      {node.children.map((child, i) => (
        <LayoutNodePreview
          key={i}
          node={child}
          leafCounter={leafCounter}
          selectedLeaf={selectedLeaf}
          onSelectLeaf={onSelectLeaf}
          onRemoveTab={onRemoveTab}
          onRemoveLeaf={onRemoveLeaf}
        />
      ))}
    </div>
  );
}
