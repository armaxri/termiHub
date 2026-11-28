import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AutomationImport, ImportedEntry } from "@/services/automationFileIo";
import type { Automation } from "@/types/generated/Automation";

const settings = { experimentalFeaturesEnabled: false, workflowLocalProcessEnabled: false };
vi.mock("@/store/useProjectedSettings", () => ({ useProjectedSettings: () => settings }));

import { useAppStore } from "@/store/appStore";
import { AutomationImportDialog } from "./AutomationImportDialog";

function result(localProcess: boolean): AutomationImport {
  const entry: ImportedEntry = {
    automation: { id: "a", name: "Helper" } as Automation,
    leftOut: [],
    triggersOff: [],
    localProcess,
    removedScriptPaths: [],
    outside: [],
  };
  return { automations: [entry.automation], entries: [entry], refused: [] };
}

let container: HTMLDivElement;
let root: Root;
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render(localProcess = true) {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <AutomationImportDialog result={result(localProcess)} onClose={onClose} onShow={vi.fn()} />
    )
  );
  return onClose;
}

describe("AutomationImportDialog: the switch a local program waits for (live review)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ openSettingsTab: vi.fn() });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    [false, false, "general"],
    [true, false, "security"],
  ])(
    "experimental %s, local programs %s: opens Settings at %s and closes",
    async (experimental, localPrograms, category) => {
      settings.experimentalFeaturesEnabled = experimental;
      settings.workflowLocalProcessEnabled = localPrograms;
      const onClose = await render();
      await act(async () => q("automation-import-open-setting")!.click());
      expect(useAppStore.getState().openSettingsTab).toHaveBeenCalledWith({ category });
      expect(onClose).toHaveBeenCalled();
    }
  );

  it("offers no setting once both switches are on, nor for an automation without a program", async () => {
    settings.experimentalFeaturesEnabled = true;
    settings.workflowLocalProcessEnabled = true;
    await render();
    expect(q("automation-import-open-setting")).toBeNull();
    settings.experimentalFeaturesEnabled = false;
    await render(false);
    expect(q("automation-import-open-setting")).toBeNull();
  });
});
