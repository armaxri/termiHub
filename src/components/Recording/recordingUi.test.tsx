/**
 * Where a recording shows (#5818, slice 8): the toolbar chip's words, the bar
 * above the terminals, the tab's badge, and the host that follows the terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
}));

import { toast } from "@/components/ui";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { useAppStore } from "@/store/appStore";
import { __emitSessionViewForTest, type ProjectedSessionLifecycle } from "@/store/sessionBridge";
import { click, query } from "@/test/automationEditorHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { withTooltip } from "@/test/tooltip";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { RecordingBar, RecordingHost, TabRecordingBadge } from ".";
import { useRecordingLabel } from "./useRecordingLabel";

let container: HTMLDivElement;
let root: Root;
let version = 5000;

const store = () => useAppStore.getState();
const tab = (id: string): TerminalTab => ({
  id,
  sessionId: `sess-${id}`,
  title: id === "a" ? "prod-web" : "db-1",
  connectionType: "local",
  contentType: "terminal",
  config: { type: "local", config: {} },
  panelId: "leaf",
  isActive: id === "a",
});

function seedTabs(ids: string[], active = ids[0] ?? null): void {
  const leaf: LeafPanel = { type: "leaf", id: "leaf", tabs: ids.map(tab), activeTabId: active };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf" });
}

function emitSessions(sessions: Record<string, Partial<ProjectedSessionLifecycle>>): void {
  version += 1;
  __emitSessionViewForTest(
    { sessions: sessions as Record<string, ProjectedSessionLifecycle> },
    version
  );
}

function Label() {
  return <output data-testid="label">{useRecordingLabel() ?? "none"}</output>;
}
const label = () => query("label")?.textContent;

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      withTooltip(
        <>
          <Label />
          <RecordingBar />
          <RecordingHost />
        </>
      )
    )
  );
  await flushAsync();
}

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState());
  useAutomationSections.setState(useAutomationSections.getInitialState());
  emitSessions({});
  seedTabs(["a", "b"]);
  vi.spyOn(toast, "success").mockReturnValue("t");
  vi.spyOn(toast, "info").mockReturnValue("t");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => {
    if (store().recording) store().stopRecording();
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

const start = (intoEditor?: string) =>
  act(() => {
    store().startRecording({ intoEditor });
    store().recordInput("a", "ls\r");
  });

describe("the chip's words", () => {
  it("say that it records, and where when that is not in front", () => {
    expect(label()).toBe("none");
    start();
    expect(label()).toBe("Stop recording");
    act(() => seedTabs(["a", "b"], "b"));
    expect(label()).toBe("Stop recording in prod-web");
  });

  it("say that a password prompt is answered", () => {
    start();
    act(() => store().recordInput("a", "x", () => "Password: "));
    // Beside the Stop, not in it (B-011).
    expect(label()).toBe("Stop recording");
    expect(query("recording-bar-prompt")?.textContent).toBe(
      "Password prompt: what you type now is kept out of the recording. When saving you decide whether to store it."
    );
    act(() => store().recordInput("a", "\r", () => "Password: "));
    act(() => store().recordInput("a", "l", () => "$ "));
    expect(query("recording-bar-prompt")).toBeNull();
  });

  it("say that the terminal is not connected", async () => {
    start();
    act(() =>
      emitSessions({ a: { status: "disconnected", exit: { code: null, reason: "dropped" } } })
    );
    await flushAsync();
    expect(store().recording).not.toBeNull();
    expect(label()).toBe("Stop recording (not connected)");
  });
});

describe("the bar", () => {
  it("does not show for a plain recording: the chip does", () => {
    start();
    expect(query("recording-bar-editor")).toBeNull();
  });

  it("is the way back to the editor", () => {
    start("Deploy prep");
    expect(query("recording-bar-editor")?.textContent).toContain(
      "Recording into “Deploy prep”: type in prod-web."
    );
    // Its one Stop: the chip is away meanwhile (A-010).
    expect(label()).toBe("none");
    click("recording-bar-return");
    expect(store().recordedTake?.forEditor).toBe(true);
    expect(query("recording-save-dialog")).toBeNull();
  });

  it("takes a wrong start back to the editor without the keys (A-010)", () => {
    start("Deploy prep");
    click("recording-bar-cancel");
    expect(store()).toMatchObject({ recording: null, recordedTake: null });
  });

  it("Keep for later is the X by name (A-009)", () => {
    start();
    act(() => store().stopRecording());
    click("recording-save-keep");
    expect(query("recording-bar-unsaved")).not.toBeNull();
    expect(store().recordedTake).not.toBeNull();
  });

  it("keeps a recording whose dialog was closed, until it is saved or discarded", async () => {
    start();
    act(() => store().stopRecording());
    expect(query("recording-save-dialog")).not.toBeNull();
    expect(query("recording-bar-unsaved")).toBeNull();
    click("modal-close");
    expect(query("recording-bar-unsaved")?.textContent).toContain(
      "The recording in prod-web is not saved. It is lost when you close termiHub."
    );
    click("recording-bar-save");
    expect(query("recording-save-dialog")).not.toBeNull();
    click("modal-close");
    click("recording-bar-discard");
    expect(query("recording-bar-unsaved")).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(
      "Discarded the recording in prod-web",
      expect.objectContaining({ testId: "recording-discarded" })
    );
  });
});

describe("the host", () => {
  it("stops and asks when the terminal is closed", async () => {
    start();
    act(() => seedTabs(["b"]));
    await flushAsync();
    expect(query("recording-save-note")?.textContent).toContain("closed or moved");
  });

  it("stops and asks when the session ends", async () => {
    start();
    act(() => emitSessions({ a: { status: "connected", exit: { code: 0, reason: "clean" } } }));
    await flushAsync();
    expect(query("recording-save-note")?.textContent).toContain("the session ended");
  });

  it("marks the saved row, and says it was saved where the list does not show", async () => {
    useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: false });
    start();
    act(() => store().stopRecording());
    click("recording-save-confirm");
    await flushAsync();
    expect(query("recording-save-dialog")).toBeNull();
    expect(useAutomationSections.getState().saved?.id).toMatch(/^automation-/);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("says nothing more where the list shows the row", async () => {
    useAppStore.setState({ sidebarView: "automations", sidebarCollapsed: false });
    start();
    act(() => store().stopRecording());
    click("recording-save-confirm");
    await flushAsync();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

it("the tab's badge names itself and stops on a click", async () => {
  const onStop = vi.fn();
  await act(async () => root.render(withTooltip(<TabRecordingBadge tabId="a" onStop={onStop} />)));
  const badge = query("tab-recording-badge-a")!;
  expect(badge.getAttribute("aria-label")).toBe("Recording what you type here");
  click("tab-recording-badge-a");
  expect(onStop).toHaveBeenCalledTimes(1);
});
