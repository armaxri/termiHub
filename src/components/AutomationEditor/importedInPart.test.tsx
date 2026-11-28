import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutomationSidebar } from "@/components/AutomationSidebar/AutomationSidebar";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { click, query } from "@/test/automationEditorHarness";
import { flushAsync } from "@/test/flushAsync";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { withTooltip } from "@/test/tooltip";
import type { Automation } from "@/types/generated/Automation";
import { AutomationEditorHost } from "./AutomationEditorHost";
import { useAutomationEditor } from "./automationEditorStore";

setupSettingsRegion();
setupConnectionsRegion();

const automation: Automation = {
  id: "a",
  name: "Partly",
  tags: [],
  steps: [{ kind: "wait", delayMs: 1 }],
  triggers: [],
  importedInPart: ["a setting of step 1 (“later”)"],
  createdAt: "",
  updatedAt: "",
};

describe("an automation that was imported in part (B-041)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const save = vi.fn((a: Automation) => Promise.resolve(a));

  beforeEach(async () => {
    save.mockClear();
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      ...automationLibraryState([automation]),
      saveAutomationToBackend: save,
    });
    useAutomationEditor.setState(useAutomationEditor.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        withTooltip(
          <>
            <AutomationSidebar />
            <AutomationEditorHost />
          </>
        )
      )
    );
    await flushAsync();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says so on its row, also one without triggers, with the way to check it", () => {
    expect(query("automation-imported-part-a")?.textContent).toContain(
      "Imported in part: left out 1 setting from a newer termiHub (“later”) in step 1."
    );
    click("automation-imported-check-a");
    expect(query("automation-editor-imported-part")?.textContent).toContain("Check what it does");
  });

  it("is checked once it is saved, also when nothing else was changed", async () => {
    click("automation-imported-check-a");
    click("automation-editor-cancel");
    expect(save).not.toHaveBeenCalled();
    click("automation-imported-check-a");
    click("automation-editor-save");
    await flushAsync();
    const { importedInPart: _importedInPart, ...checked } = automation;
    expect(save).toHaveBeenCalledWith(checked);
  });
});
