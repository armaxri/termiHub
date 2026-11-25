import { useEffect, useRef } from "react";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui";
import { useAutomationEditor } from "./automationEditorStore";

/** The way back to the automation editor while it has stepped aside (A-031). */
export function EditorAsideBar() {
  const editing = useAutomationEditor((s) => s.editing);
  const aside = useAutomationEditor((s) => s.aside);
  const setAside = useAutomationEditor((s) => s.setAside);
  const back = useRef<HTMLButtonElement>(null);
  const shown = editing !== null && aside;
  // Else the closing editor gives the focus to the row's button, whose tooltip then
  // covers Run (B-021).
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => back.current?.focus());
    return () => window.clearTimeout(timer);
  }, [shown]);
  if (!editing || !aside) return null;
  const name = editing.automation.name;
  return (
    <div className="recording-bar" data-testid="automation-editor-aside">
      <Zap size={14} aria-hidden="true" />
      <span className="recording-bar__text" role="status">
        {name ? `“${name}”` : "The new automation"} is still open. Your changes are kept, not saved
        yet.
      </span>
      <Button
        ref={back}
        size="sm"
        onClick={() => setAside(false)}
        data-testid="automation-editor-aside-return"
      >
        Return to it
      </Button>
    </div>
  );
}
