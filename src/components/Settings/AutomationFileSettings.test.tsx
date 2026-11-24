/** Settings → Import & migration → automations (#5818, slice 11). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
vi.mock("@/services/nativeDialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
}));

import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "@/components/ui";
import { saveAutomation } from "@/services/automationApi";
import { open, save } from "@/services/nativeDialog";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { checkA11y } from "@/test/axe";
import { click, query } from "@/test/automationEditorHarness";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import type { Automation } from "@/types/generated/Automation";
import { AutomationFileSettings } from "./AutomationFileSettings";

const automation = (over: Partial<Automation>): Automation => ({
  id: "a",
  name: "Deploy",
  tags: [],
  steps: [{ kind: "send-command", command: "make" }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  useAppStore.setState(useAppStore.getInitialState());
  vi.spyOn(toast, "success").mockReturnValue("t");
  vi.spyOn(toast, "error").mockReturnValue("t");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(withTooltip(<AutomationFileSettings />)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function importJson(file: unknown): Promise<void> {
  vi.mocked(open).mockResolvedValue("/tmp/in.json");
  vi.mocked(readTextFile).mockResolvedValue(typeof file === "string" ? file : JSON.stringify(file));
  click("import-migration-automations-import-btn");
  await flushAsync();
}
const note = (id: string) => query(`automation-import-note-${id}`)?.textContent;

describe("import", () => {
  it("says what came in, and no more when there is nothing to look at", async () => {
    await importJson({ version: 1, automations: [automation({}), automation({ name: "B" })] });
    expect(query("automation-import-dialog")?.textContent).toContain("Imported 2 automations");
    expect(query("automation-import-names")?.textContent).toBe("Deploy, B");
    expect(document.querySelector("[data-testid^=automation-import-note-]")).toBeNull();
    click("automation-import-close");
    await flushAsync();
    expect(query("automation-import-dialog")).toBeNull();
  });

  it("names what was switched off, what runs programs, what it wanted to read and what is missing", async () => {
    await importJson({
      version: 1,
      automations: [
        automation({ name: "Hot", triggers: [{ kind: "hotkey", binding: "Enter" }] }),
        automation({
          name: "Local",
          steps: [{ kind: "run-local-process", program: "rm", args: [] }],
        }),
        automation({
          name: "Script",
          steps: [{ kind: "run-script", script: "x", sourcePath: "/home/u/.ssh/id" }],
        }),
        automation({ name: "Caller", steps: [{ kind: "run-automation", automationId: "gone" }] }),
      ],
    });
    expect(note("disarmed")).toMatch(/Switched off: .*hotkey.*Hot$/);
    expect(note("local-process")).toMatch(/Allow experimental features.*Local$/);
    expect(note("script-paths")).toContain("Script: /home/u/.ssh/id");
    expect(note("outside")).toContain(
      "Caller: choose one in its “Run automation” step, or that step fails"
    );
    expect(vi.mocked(saveAutomation).mock.calls[0][0].triggersEnabled).toBe(false);
    await checkA11y(query("automation-import-dialog")!);
  });

  it("names the automation of this library that a step runs", async () => {
    act(() =>
      useAppStore.setState(automationLibraryState([automation({ id: "here", name: "Cleanup" })]))
    );
    await importJson({
      version: 1,
      automations: [
        automation({ name: "Caller", steps: [{ kind: "run-automation", automationId: "here" }] }),
      ],
    });
    expect(note("outside")).toContain("Caller: runs “Cleanup” of your library");
  });

  it("takes a file of an older build", async () => {
    await importJson({ version: 1, macros: [{ name: "M", steps: [{ data: "x", delayMs: 0 }] }] });
    expect(query("automation-import-names")?.textContent).toBe("M");
  });

  it("shows them in the sidebar, without closing it when it already shows", async () => {
    const setSidebarView = vi.fn();
    act(() => useAppStore.setState({ setSidebarView, sidebarView: "connections" }));
    await importJson({ version: 1, automations: [automation({})] });
    click("automation-import-show");
    expect(setSidebarView).toHaveBeenCalledWith("automations");
    await flushAsync();
    act(() => useAppStore.setState({ sidebarView: "automations", sidebarCollapsed: false }));
    setSidebarView.mockClear();
    await importJson({ version: 1, automations: [automation({})] });
    click("automation-import-show");
    expect(setSidebarView).not.toHaveBeenCalled();
  });

  it("imports nothing from a bad file, and says why", async () => {
    await importJson({ version: 2, automations: [automation({})] });
    expect(saveAutomation).not.toHaveBeenCalled();
    expect(query("automation-import-dialog")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Failed to import automations: The file was exported by a newer version of termiHub. Update termiHub to import it."
    );
  });

  it("does nothing when the dialog is canceled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    click("import-migration-automations-import-btn");
    await flushAsync();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("export", () => {
  it("is off without automations", () => {
    const button = query("import-migration-automations-export-btn") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("writes the whole library as one list", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/out.json");
    act(() =>
      useAppStore.setState(
        automationLibraryState([automation({}), automation({ id: "b", name: "B" })])
      )
    );
    click("import-migration-automations-export-btn");
    await flushAsync();
    const file = JSON.parse(vi.mocked(writeTextFile).mock.calls[0][1]);
    expect(file.version).toBe(1);
    expect(file.automations.map((a: Automation) => a.name)).toEqual(["Deploy", "B"]);
    expect(toast.success).toHaveBeenCalledWith("Exported 2 automations");
  });
});
