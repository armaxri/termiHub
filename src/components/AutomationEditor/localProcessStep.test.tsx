/**
 * "Run local process" stays behind the experimental switch (#5818, maintainer
 * decision): both Add step menus offer it only while the switch is on. A step
 * already there stays, can be edited and removed, and says why it will not run. So
 * does a step of a kind this build does not know (#6009).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { openMenu } from "@/test/automationRowMenu";
import {
  automationWith,
  chooseStep,
  click,
  mountEditor,
  query,
  typeText,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { useAppStore } from "@/store/appStore";
import { useAutomationEditor } from "./automationEditorStore";
import { LOCAL_PROCESS_STEP_REASON, UNKNOWN_STEP_REASON } from "./stepMeta";

setupConnectionsRegion();
setupSettingsRegion();

const automation = automationWith([
  { kind: "conditional", condition: { left: "a", op: "eq", right: "a" }, then: [] },
  { kind: "run-local-process", program: "make", args: [] },
]);
const entries = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]'), (el) =>
    el.getAttribute("data-testid")
  );

let editor: EditorHarness;
afterEach(() => editor.unmount());

async function open(experimental: boolean): Promise<void> {
  seedSettings({ experimentalFeaturesEnabled: experimental });
  editor = await mountEditor(automation);
}

describe("the Run local process step", () => {
  it.each([false, true])("experimental %s: the Add step menus", async (experimental) => {
    await open(experimental);
    openMenu("automation-editor-add-step");
    expect(entries()).toContain("automation-editor-add-step-wait");
    expect(entries().includes("automation-editor-add-step-run-local-process")).toBe(experimental);
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flushAsync();

    click("automation-editor-step-toggle-0");
    openMenu("automation-editor-add-substep-0-then");
    expect(entries()).toContain("automation-editor-add-substep-0-then-wait");
    expect(entries().includes("automation-editor-add-substep-0-then-run-local-process")).toBe(
      experimental
    );
  });

  it("without the switch: shows, says why it will not run, and can be edited", async () => {
    await open(false);
    expect(query("automation-editor-step-summary-1")?.textContent).toContain("Will not run");
    click("automation-editor-step-toggle-1");
    expect(query("automation-editor-step-blocked-1")?.textContent).toContain(
      LOCAL_PROCESS_STEP_REASON
    );
    typeText("automation-editor-step-program-1", "cmake");
    expect((await editor.save()).steps[1]).toEqual({
      kind: "run-local-process",
      program: "cmake",
      args: [],
    });
  });

  it("both blocked kinds say that nothing of the automation runs (A-031)", () => {
    for (const reason of [LOCAL_PROCESS_STEP_REASON, UNKNOWN_STEP_REASON]) {
      expect(reason).toMatch(/^Will not run: .* Nothing of the automation runs until you /);
    }
  });

  it("without the switch: Save and run is unavailable and says why; Save works (A-032)", async () => {
    await open(false);
    expect(query("automation-editor-footer-note")?.textContent).toBe(
      "Cannot run: local programs are switched off."
    );
    expect(query("automation-editor-save-run")?.getAttribute("aria-disabled")).toBe("true");
    typeText("automation-editor-name", "Renamed");
    click("automation-editor-save-run");
    await flushAsync();
    expect(editor.onSave).not.toHaveBeenCalled();
    expect((await editor.save()).name).toBe("Renamed");
  });

  it("Open Settings steps aside and keeps the draft (A-031)", async () => {
    await open(false);
    const openSettingsTab = vi.fn();
    act(() => useAppStore.setState({ openSettingsTab }));
    useAutomationEditor.setState({ editing: { automation, isNew: false } });
    typeText("automation-editor-name", "Renamed");
    click("automation-editor-step-toggle-1");
    click("automation-editor-step-open-settings-1");
    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
    expect(query("automation-editor-dialog")).toBeNull();
    // Another automation does not take its place: the draft comes back instead.
    act(() => useAutomationEditor.getState().open(automationWith([], { id: "other" }), false));
    expect(useAutomationEditor.getState().editing?.automation.id).toBe(automation.id);
    expect(query("automation-editor-name")).toHaveProperty("value", "Renamed");
    act(() => useAutomationEditor.getState().close());
  });

  it("without the switch: can be removed", async () => {
    await open(false);
    await chooseStep("1", "delete");
    expect((await editor.save()).steps).toHaveLength(1);
  });

  it("with the switch: says nothing", async () => {
    await open(true);
    click("automation-editor-step-toggle-1");
    expect(query("automation-editor-step-blocked-1")).toBeNull();
    expect(query("automation-editor-step-summary-1")?.textContent).toBe("");
  });
});

it.each(["take-snapshot", "constructor"])("a step of the unknown kind %s says so", async (kind) => {
  editor = await mountEditor(automationWith([{ kind, volume: "data" } as never]));
  expect(query("automation-editor-step-summary-0")?.textContent).toContain("Will not run");
  expect(query("automation-editor-step-0")?.textContent).toContain(kind);
  click("automation-editor-step-toggle-0");
  expect(query("automation-editor-step-blocked-0")?.textContent).toContain(
    "a newer version of termiHub made this step"
  );
  // It stays as it is until it is deleted.
  expect(query("automation-editor-footer-note")?.textContent).toContain("does not know");
  typeText("automation-editor-name", "Renamed");
  expect((await editor.save()).steps).toEqual([{ kind, volume: "data" }]);
});
