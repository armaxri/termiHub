import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "@/components/ui";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { useAppStore } from "@/store/appStore";
import { failedRunActions } from "@/store/slices/automationRunActions";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { withTooltip } from "@/test/tooltip";
import type { Automation } from "@/types/generated/Automation";
import { AutomationEditorHost } from "./AutomationEditorHost";
import { useAutomationEditor } from "./automationEditorStore";

const automation = (id: string): Automation => ({
  id,
  name: `Automation ${id}`,
  tags: [],
  steps: [{ kind: "wait", delayMs: 1 }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

describe("the buttons of a failed run's toast (A-037)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState(automationLibraryState([automation("a"), automation("b")]));
    useAutomationEditor.setState(useAutomationEditor.getInitialState());
    vi.spyOn(toast, "info");
    vi.spyOn(toast, "error");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(withTooltip(<AutomationEditorHost />)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const press = (id: string, which: "action" | "cancel") =>
    act(() => failedRunActions(id)[which]?.onClick());
  const editing = () => useAutomationEditor.getState().editing?.automation.id;

  it("Edit opens the automation's editor, History its runs", () => {
    press("a", "cancel");
    expect(useAppStore.getState().sidebarView).toBe("automations");
    expect(useAutomationSections.getState()).toMatchObject({
      historyOpen: true,
      historyAutomationId: "a",
    });
    press("a", "action");
    expect(editing()).toBe("a");
  });

  it("never replaces an editor that is open on another one", () => {
    press("a", "action");
    press("a", "action");
    expect(toast.info).not.toHaveBeenCalled();
    press("b", "action");
    expect(editing()).toBe("a");
    expect(toast.info).toHaveBeenCalledWith("Save or close the open automation first");
  });

  it("says when the automation was deleted since", () => {
    press("gone", "action");
    expect(editing()).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith("The automation no longer exists");
  });
});
