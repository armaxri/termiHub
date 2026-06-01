import { useCallback, useRef, type RefObject } from "react";
import { LeafPanel } from "@/types/terminal";
import { getPanelActiveSessionId } from "@/utils/panelTree";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { sendInput } from "@/services/api";
import { quotePath } from "@/utils/quotePath";

interface PaneFileDrop {
  /** Attach to the pane's terminal area — defines this pane's drop target bounds. */
  terminalAreaRef: RefObject<HTMLDivElement>;
  /** True while an OS file drag hovers over this pane. */
  isFileDragOver: boolean;
  /** Session that a drop would insert into, or null if this pane has no active terminal. */
  panelSessionId: string | null;
}

/**
 * Scopes OS file drag-and-drop to a single terminal pane: a path dropped onto the
 * pane is inserted into the session of the tab shown there, so each open connection
 * is its own drop target rather than the whole terminal area being one zone.
 */
export function usePaneFileDrop(panel: LeafPanel): PaneFileDrop {
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const panelSessionId = getPanelActiveSessionId(panel);
  const handleFileDrop = useCallback(
    async (paths: string[]) => {
      if (!panelSessionId || paths.length === 0) return;
      const text = paths.map(quotePath).join(" ");
      await sendInput(panelSessionId, text);
    },
    [panelSessionId]
  );
  const { isDragOver: isFileDragOver } = useOsFileDrop(terminalAreaRef, handleFileDrop);
  return { terminalAreaRef, isFileDragOver, panelSessionId };
}
