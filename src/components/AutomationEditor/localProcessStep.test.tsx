/**
 * "Run local process" stays behind the experimental switch (#5818, maintainer
 * decision) now that the rest of the editor graduated: both Add step menus
 * offer it only while the switch is on. A step already there keeps its row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { openMenu } from "@/test/automationRowMenu";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import type { Workflow } from "@/types/workflow";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import { offeredStepKinds, WORKFLOW_STEP_KINDS } from "./workflowStepMeta";

setupSettingsRegion();

const workflow: Workflow = {
  id: "w1",
  name: "Build",
  tags: [],
  steps: [
    { kind: "conditional", condition: { left: "a", op: "eq", right: "a" }, then: [] },
    { kind: "run-local-process", program: "make", args: [] },
  ],
  triggers: [{ kind: "manual" }],
  createdAt: "",
  updatedAt: "",
};

const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const menuTestIds = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]'), (el) =>
    el.getAttribute("data-testid")
  );

describe("the Run local process step in the Add step menus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(experimental: boolean): Promise<void> {
    seedSettings({ experimentalFeaturesEnabled: experimental });
    await act(async () =>
      root.render(
        withTooltip(
          <WorkflowEditorDialog
            open
            workflow={workflow}
            macros={[]}
            connections={[]}
            onOpenChange={vi.fn()}
            onSave={vi.fn()}
          />
        )
      )
    );
    await flushAsync();
  }

  it("offers every kind but this one without the switch", () => {
    expect(offeredStepKinds(true)).toEqual(WORKFLOW_STEP_KINDS);
    expect(offeredStepKinds(false)).toEqual(
      WORKFLOW_STEP_KINDS.filter((kind) => kind !== "run-local-process")
    );
  });

  it.each([false, true])("experimental %s: the menus", async (experimental) => {
    await render(experimental);
    openMenu("workflow-editor-add-step");
    expect(menuTestIds()).toContain("workflow-editor-add-step-wait");
    expect(menuTestIds().includes("workflow-editor-add-step-run-local-process")).toBe(experimental);
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });

    act(() => query("workflow-editor-step-toggle-0")!.click());
    const add = document.querySelector<HTMLElement>(
      '[data-testid^="workflow-editor-add-substep-"]'
    )!;
    openMenu(add.getAttribute("data-testid")!);
    const sub = menuTestIds().filter((id) => id?.startsWith("workflow-editor-add-substep-"));
    expect(sub.some((id) => id!.endsWith("-wait"))).toBe(true);
    expect(sub.some((id) => id!.endsWith("-run-local-process"))).toBe(experimental);
  });

  it("keeps a step that is already there", async () => {
    await render(false);
    expect(query("workflow-editor-step-kind-1")!.getAttribute("data-kind")).toBe(
      "run-local-process"
    );
  });
});
