import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SavedConnection } from "@/types/connection";
import type { VisibleTreeNode } from "@/utils/computeVisibleTreeNodes";

export interface TreeKeyboardNavResult {
  /** Container ref: scopes DOM focus queries to this tree. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** The row that currently owns `tabindex=0` (roving tabindex). */
  focusedId: string | null;
  /** Update the focused row when the user tabs/clicks into it (no DOM focus move). */
  setFocusedId: (id: string) => void;
  /** `onKeyDown` handler to attach to every tree row. */
  handleKeyDown: (event: React.KeyboardEvent, nodeId: string) => void;
}

interface TreeKeyboardNavOptions {
  onConnect: (connection: SavedConnection) => void;
  onToggleFolder: (folderId: string) => void;
}

/**
 * Roving-tabindex keyboard navigation for a flattened tree (#1356).
 *
 * Given the visible rows in visual order, this manages which row is tabbable
 * and moves DOM focus in response to arrow keys:
 * - Up/Down move between visible rows.
 * - Right expands a collapsed folder, or descends into an expanded one.
 * - Left collapses an expanded folder, or ascends to the parent row.
 * - Enter/Space connects a focused connection or toggles a focused folder.
 * - Home/End jump to the first/last row.
 *
 * DOM focus is moved by locating `[data-tree-node-id]` inside {@link containerRef}
 * after the render that reveals the target row.
 */
export function useTreeKeyboardNav(
  nodes: VisibleTreeNode[],
  { onConnect, onToggleFolder }: TreeKeyboardNavOptions
): TreeKeyboardNavResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const pendingFocusRef = useRef<string | null>(null);

  // After the tree re-renders, move DOM focus to a pending target once it exists.
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (!target || !containerRef.current) return;
    const rows = containerRef.current.querySelectorAll<HTMLElement>("[data-tree-node-id]");
    const el = Array.from(rows).find((row) => row.dataset.treeNodeId === target);
    if (el) {
      el.focus();
      pendingFocusRef.current = null;
    }
  });

  const focusNode = useCallback((id: string) => {
    setFocusedId(id);
    pendingFocusRef.current = id;
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, nodeId: string) => {
      const index = nodes.findIndex((n) => n.id === nodeId);
      if (index === -1) return;
      const node = nodes[index];

      switch (event.key) {
        case "ArrowDown": {
          const next = nodes[index + 1];
          if (next) {
            event.preventDefault();
            focusNode(next.id);
          }
          break;
        }
        case "ArrowUp": {
          const prev = nodes[index - 1];
          if (prev) {
            event.preventDefault();
            focusNode(prev.id);
          }
          break;
        }
        case "ArrowRight": {
          if (node.kind !== "folder") break;
          event.preventDefault();
          if (!node.isExpanded && node.hasChildren) {
            onToggleFolder(node.id);
            focusNode(node.id);
          } else if (node.isExpanded) {
            const child = nodes[index + 1];
            if (child && child.depth > node.depth) focusNode(child.id);
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (node.kind === "folder" && node.isExpanded) {
            onToggleFolder(node.id);
            focusNode(node.id);
          } else if (node.parentId) {
            focusNode(node.parentId);
          }
          break;
        }
        case "Enter":
        case " ": {
          event.preventDefault();
          if (node.kind === "connection" && node.connection) onConnect(node.connection);
          else if (node.kind === "folder") onToggleFolder(node.id);
          break;
        }
        case "Home": {
          if (nodes[0]) {
            event.preventDefault();
            focusNode(nodes[0].id);
          }
          break;
        }
        case "End": {
          const last = nodes[nodes.length - 1];
          if (last) {
            event.preventDefault();
            focusNode(last.id);
          }
          break;
        }
        default:
          break;
      }
    },
    [nodes, focusNode, onConnect, onToggleFolder]
  );

  return { containerRef, focusedId, setFocusedId, handleKeyDown };
}
