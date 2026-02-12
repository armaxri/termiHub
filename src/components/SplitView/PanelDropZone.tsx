import { useDroppable } from "@dnd-kit/core";
import { DropEdge } from "@/types/terminal";
import "./PanelDropZone.css";

interface PanelDropZoneProps {
  panelId: string;
  /** Whether to hide edge zones (e.g. source panel with only 1 tab) */
  hideEdges: boolean;
}

const EDGES: DropEdge[] = ["left", "right", "top", "bottom"];

/** Drop zone overlay for a leaf panel — shown only during active drag. */
export function PanelDropZone({ panelId, hideEdges }: PanelDropZoneProps) {
  return (
    <div className="panel-drop-zone">
      {!hideEdges &&
        EDGES.map((edge) => (
          <EdgeZone key={edge} panelId={panelId} edge={edge} />
        ))}
      <CenterZone panelId={panelId} />
    </div>
  );
}

function EdgeZone({ panelId, edge }: { panelId: string; edge: DropEdge }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `edge-${panelId}-${edge}`,
    data: { type: "edge", panelId, edge },
  });

  return (
    <div
      ref={setNodeRef}
      className={`panel-drop-zone__edge panel-drop-zone__edge--${edge} ${
        isOver ? "panel-drop-zone__edge--active" : ""
      }`}
    />
  );
}

function CenterZone({ panelId }: { panelId: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `center-${panelId}`,
    data: { type: "center", panelId },
  });

  return (
    <div
      ref={setNodeRef}
      className={`panel-drop-zone__center ${
        isOver ? "panel-drop-zone__center--active" : ""
      }`}
    />
  );
}
