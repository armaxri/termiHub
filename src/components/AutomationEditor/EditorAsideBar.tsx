import { Zap } from "lucide-react";
import { Button } from "@/components/ui";
import { useAutomationEditor } from "./automationEditorStore";

/** The way back to the automation editor while it has stepped aside (A-031). */
export function EditorAsideBar() {
  const editing = useAutomationEditor((s) => s.editing);
  const aside = useAutomationEditor((s) => s.aside);
  const setAside = useAutomationEditor((s) => s.setAside);
  if (!editing || !aside) return null;
  const name = editing.automation.name;
  return (
    <div className="recording-bar" data-testid="automation-editor-aside">
      <Zap size={14} aria-hidden="true" />
      <span className="recording-bar__text" role="status">
        {name ? `The automation “${name}”` : "The new automation"} is still open. Nothing is saved
        yet.
      </span>
      <Button
        size="sm"
        onClick={() => setAside(false)}
        data-testid="automation-editor-aside-return"
      >
        Return to it
      </Button>
    </div>
  );
}
