import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { DropEdge } from "@/types/terminal";
import "./PanelDropZone.css";

type ActiveZone = DropEdge | "center" | null;

interface PanelDropZoneProps {
  panelId: string;
  /** Whether to hide edge zones (e.g. source panel with only 1 tab) */
  hideEdges: boolean;
}

const EDGES: DropEdge[] = ["left", "right", "top", "bottom"];

/** Drop zone overlay for a leaf panel — shown only during active drag. */
export function PanelDropZone({ panelId, hideEdges }: PanelDropZoneProps) {
  const [activeZone, setActiveZone] = useState<ActiveZone>(null);

  return (
    <div className="panel-drop-zone">
      {!hideEdges &&
        EDGES.map((edge) => (
          <EdgeZone key={edge} panelId={panelId} edge={edge} setActiveZone={setActiveZone} />
        ))}
      <CenterZone panelId={panelId} setActiveZone={setActiveZone} />
      <DropPreview activeZone={activeZone} />
    </div>
  );
}

function EdgeZone({
  panelId,
  edge,
  setActiveZone,
}: {
  panelId: string;
  edge: DropEdge;
  setActiveZone: Dispatch<SetStateAction<ActiveZone>>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `edge-${panelId}-${edge}`,
    data: { type: "edge", panelId, edge },
  });

  useEffect(() => {
    if (isOver) {
      setActiveZone(edge);
    } else {
      setActiveZone((prev) => (prev === edge ? null : prev));
    }
  }, [isOver, edge, setActiveZone]);

  return (
    <div ref={setNodeRef} className={`panel-drop-zone__edge panel-drop-zone__edge--${edge}`} />
  );
}

function CenterZone({
  panelId,
  setActiveZone,
}: {
  panelId: string;
  setActiveZone: Dispatch<SetStateAction<ActiveZone>>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `center-${panelId}`,
    data: { type: "center", panelId },
  });

  useEffect(() => {
    if (isOver) {
      setActiveZone("center");
    } else {
      setActiveZone((prev) => (prev === "center" ? null : prev));
    }
  }, [isOver, setActiveZone]);

  return <div ref={setNodeRef} className="panel-drop-zone__center" />;
}

/** Full-area preview overlay showing where the dropped tab will land. */
function DropPreview({ activeZone }: { activeZone: ActiveZone }) {
  if (!activeZone) return null;

  return <div className={`panel-drop-zone__preview panel-drop-zone__preview--${activeZone}`} />;
}
