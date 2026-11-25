/**
 * Recording what the user types (#1674, #5818 slice 8): one terminal at a time,
 * every byte and its timing, and a take that only a save or a discard ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
  deleteAutomation: vi.fn(() => Promise.resolve()),
}));

import { listAutomations, saveAutomation } from "@/services/automationApi";
import { toast } from "@/components/ui";
import { seedLayoutState } from "@/test/layoutState";
import type { Automation } from "@/types/generated/Automation";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { useAppStore } from "./appStore";
import { automationLibraryState } from "./slices/automationStoreState";
import { recordingStep, type SaveTakeRequest } from "./slices/recordingSlice";
import { __emitSessionViewForTest, type ProjectedSessionLifecycle } from "./sessionBridge";

let version = 1000;
/** Set the projected sessions. */
function emitSessionViewForTest(
  sessions: Record<string, Partial<ProjectedSessionLifecycle>>
): void {
  version += 1;
  __emitSessionViewForTest(
    { sessions: sessions as Record<string, ProjectedSessionLifecycle> },
    version
  );
}

const store = () => useAppStore.getState();

function tab(id: string, over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf",
    isActive: id === "a",
    ...over,
  };
}

function seedTabs(tabs: TerminalTab[], active: string | null = tabs[0]?.id ?? null): void {
  const leaf: LeafPanel = { type: "leaf", id: "leaf", tabs, activeTabId: active };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf" });
}

/** Record `keys` on terminal a and stop. */
function record(...keys: string[]): void {
  store().startRecording();
  for (const key of keys) store().recordInput("a", key);
  store().stopRecording();
}

const existing: Automation = {
  id: "x",
  name: "Deploy",
  tags: ["ops"],
  steps: [{ kind: "send-command", command: "make" }],
  triggers: [{ kind: "hotkey", binding: "F8" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  emitSessionViewForTest({});
  vi.clearAllMocks();
  seedTabs([tab("a"), tab("b")]);
  vi.spyOn(toast, "info").mockReturnValue("t");
  vi.spyOn(toast, "error").mockReturnValue("t");
});
afterEach(() => {
  if (store().recording) store().stopRecording();
  vi.restoreAllMocks();
});

describe("starting", () => {
  it("binds to the active terminal and focuses it", () => {
    const focused: string[] = [];
    const listen = (e: Event) => focused.push((e as CustomEvent).detail.tabId);
    window.addEventListener("termihub:focus-terminal", listen);
    expect(store().startRecording()).toBe(true);
    window.removeEventListener("termihub:focus-terminal", listen);
    expect(store().recording).toMatchObject({ tabId: "a", tabTitle: "a", keys: 0 });
    expect(focused).toEqual(["a"]);
  });

  it.each<[string, () => void]>([
    ["no tab", () => seedTabs([])],
    ["an editor tab", () => seedTabs([tab("a", { contentType: "settings" })])],
    ["a terminal that is not connected", () => seedTabs([tab("a", { sessionId: null })])],
  ])("with %s says to open a terminal", (_name, seed) => {
    seed();
    expect(store().startRecording()).toBe(false);
    expect(store().recording).toBeNull();
    expect(toast.info).toHaveBeenCalledWith("Open a terminal to record in");
  });

  it("with an unsaved take asks about that first, and loses neither", () => {
    record("ls\r");
    store().setRecordingSaveOpen(false);
    expect(store().startRecording()).toBe(false);
    expect(store()).toMatchObject({ recordingSaveOpen: true, recordingStartHeld: true });
    expect(store().recordedTake?.chunks).toHaveLength(1);
  });

  it("does nothing while a recording runs", () => {
    store().startRecording();
    store().recordInput("a", "x");
    expect(store().startRecording({ tabId: "b" })).toBe(false);
    expect(store().recording).toMatchObject({ tabId: "a", keys: 1 });
  });
});

describe("what is recorded", () => {
  it("is what is sent to its own terminal, byte for byte with the delays", () => {
    const now = vi.spyOn(performance, "now");
    store().startRecording();
    now.mockReturnValue(1000);
    store().recordInput("a", "l");
    store().recordInput("b", "other terminal");
    now.mockReturnValue(1200);
    store().recordInput("a", "\x1b[A");
    now.mockReturnValue(1250);
    store().recordInput("a", "\x1b[200~grüße\r\n🚀\x1b[201~");
    expect(store().recording?.keys).toBe(3);
    store().stopRecording();
    expect(store().recordedTake?.chunks).toEqual([
      { data: "l", delayMs: 0 },
      { data: "\x1b[A", delayMs: 200 },
      { data: "\x1b[200~grüße\r\n🚀\x1b[201~", delayMs: 50 },
    ]);
  });

  it("holds a paste in the place it was asked for", () => {
    store().startRecording();
    const paste = store().reserveRecordedPaste("a");
    expect(store().reserveRecordedPaste("b")).toBeNull();
    store().recordInput("a", "typed after");
    paste!.fill("pasted");
    store().stopRecording();
    expect(store().recordedTake?.chunks.map((c) => c.data)).toEqual(["pasted", "typed after"]);
  });

  it("leaves out a paste that lands after Stop", () => {
    store().startRecording();
    const paste = store().reserveRecordedPaste("a");
    store().recordInput("a", "x");
    store().stopRecording();
    const take = store().recordedTake;
    paste!.fill("late");
    expect(store().recordedTake).toBe(take);
    expect(take?.chunks.map((c) => c.data)).toEqual(["x"]);
  });

  it("is nothing while no recording runs", () => {
    store().recordInput("a", "noise");
    expect(store().reserveRecordedPaste("a")).toBeNull();
    expect(store().recordedTake).toBeNull();
  });

  it("says while a password prompt is answered", () => {
    store().startRecording();
    store().recordInput("a", "x", () => "Password: ");
    expect(store().recording?.atPrompt).toBe(true);
    store().recordInput("a", "\r", () => "Password: ");
    expect(store().recording?.atPrompt).toBe(false);
  });
});

describe("stopping", () => {
  it("keeps the take and asks what to do with it", () => {
    record("ls\r");
    expect(store()).toMatchObject({ recording: null, recordingSaveOpen: true });
    expect(store().recordedTake).toMatchObject({ tabTitle: "a", ended: "stopped" });
  });

  it("with nothing typed says so and asks nothing", () => {
    record();
    expect(store()).toMatchObject({ recordedTake: null, recordingSaveOpen: false });
    expect(toast.info).toHaveBeenCalledWith("Nothing was typed, so nothing was recorded");
  });

  it("is a no-op when nothing is recorded", () => {
    store().stopRecording();
    expect(store().recordedTake).toBeNull();
  });

  it("toggles", () => {
    store().toggleRecording();
    expect(store().recording).not.toBeNull();
    store().recordInput("a", "x");
    store().toggleRecording();
    expect(store().recordedTake).not.toBeNull();
  });
});

describe("the recorded terminal", () => {
  const start = () => {
    store().startRecording();
    store().recordInput("a", "typed");
  };

  it("being closed, or moved to another window, stops and keeps the take", () => {
    start();
    seedTabs([tab("b")]);
    store().followRecordedTerminal();
    expect(store().recordedTake).toMatchObject({ ended: "tab-gone", tabTitle: "a" });
    expect(store().recordedTake?.chunks).toHaveLength(1);
  });

  it("moving to another panel or group changes nothing", () => {
    start();
    const other: LeafPanel = { type: "leaf", id: "other", tabs: [tab("a")], activeTabId: "a" };
    seedLayoutState({ rootPanel: other, activePanelId: "other" });
    store().followRecordedTerminal();
    store().recordInput("a", "more");
    expect(store().recording).toMatchObject({ tabId: "a", keys: 2 });
  });

  it.each(["clean", "killed"] as const)("ending its session (%s) stops and keeps", (reason) => {
    start();
    emitSessionViewForTest({ a: { status: "connected", exit: { code: 0, reason } } });
    store().followRecordedTerminal();
    expect(store().recordedTake).toMatchObject({ ended: "session-ended" });
  });

  it("being disconnected by the user stops and keeps", () => {
    start();
    emitSessionViewForTest({ a: { status: "disconnected", endReason: "user" } });
    store().followRecordedTerminal();
    expect(store().recordedTake?.ended).toBe("session-ended");
  });

  it("dropping and reconnecting goes on recording, in one take", () => {
    start();
    emitSessionViewForTest({
      a: {
        status: "disconnected",
        endReason: "unexpected",
        exit: { code: null, reason: "dropped" },
      },
    });
    store().followRecordedTerminal();
    emitSessionViewForTest({
      a: { status: "reconnecting", exit: { code: null, reason: "killed" } },
    });
    store().followRecordedTerminal();
    emitSessionViewForTest({ a: { status: "connected" } });
    store().followRecordedTerminal();
    store().recordInput("a", "after");
    store().stopRecording();
    expect(store().recordedTake?.chunks.map((c) => c.data)).toEqual(["typed", "after"]);
  });
});

describe("saving", () => {
  it("stores a new automation of one recorded step", async () => {
    record("echo hi", "\r");
    const id = await store().saveRecordedTake({
      to: "new",
      name: "Greeting",
      description: "says hi",
      tags: ["demo"],
      keepSecrets: false,
    });
    expect(saveAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        name: "Greeting",
        description: "says hi",
        tags: ["demo"],
        triggers: [],
        steps: [expect.objectContaining({ kind: "type-keys", timing: "recorded", recorded: true })],
      })
    );
    expect(store()).toMatchObject({ recordedTake: null, recordingSaveOpen: false });
  });

  it("adds to an existing automation at the end, and changes nothing else of it", async () => {
    useAppStore.setState(automationLibraryState([existing]));
    vi.mocked(listAutomations).mockResolvedValue([existing]);
    record("ls\r");
    await store().saveRecordedTake({ to: "existing", automationId: "x", keepSecrets: false });
    expect(saveAutomation).toHaveBeenCalledWith({
      ...existing,
      steps: [
        ...existing.steps,
        {
          kind: "type-keys",
          chunks: [{ data: "ls\r", delayMs: 0 }],
          timing: "recorded",
          recorded: true,
        },
      ],
    });
  });

  it.each<[string, () => void, "new" | "existing"]>([
    [
      "the backend fails",
      () => vi.mocked(saveAutomation).mockRejectedValueOnce(new Error("x")),
      "new",
    ],
    ["the automation is gone", () => undefined, "existing"],
  ])("keeps the take and the dialog when %s", async (_name, arrange, to) => {
    record("ls\r");
    arrange();
    const request: SaveTakeRequest =
      to === "new"
        ? { to, name: "n", tags: [], keepSecrets: false }
        : { to, automationId: "gone", keepSecrets: false };
    await expect(store().saveRecordedTake(request)).rejects.toThrow();
    expect(store()).toMatchObject({ recordingSaveOpen: true });
    expect(store().recordedTake?.chunks).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save the recording")
    );
  });

  describe("what was typed at a password prompt", () => {
    const take = () => {
      store().startRecording();
      store().recordInput("a", "sudo -v\r", () => "$ ");
      for (const key of ["p", "w", "\r"]) store().recordInput("a", key, () => "Password: ");
      store().recordInput("a", "ls\r", () => "$ ");
      store().stopRecording();
      return store().recordedTake!;
    };
    const typed = (keep: boolean) => {
      const step = recordingStep(store().recordedTake!, keep);
      return step?.kind === "type-keys" ? step.chunks.map((c) => c.data) : null;
    };

    it("is left out unless it is asked for", () => {
      expect(take().secrets).toEqual([{ start: 1, end: 4, prompt: "Password:" }]);
      expect(typed(false)).toEqual(["sudo -v\r", "ls\r"]);
      expect(typed(true)).toEqual(["sudo -v\r", "p", "w", "\r", "ls\r"]);
    });

    it("alone leaves nothing to save", async () => {
      store().startRecording();
      for (const key of ["p", "\r"]) store().recordInput("a", key, () => "Password: ");
      store().stopRecording();
      await expect(
        store().saveRecordedTake({ to: "new", name: "n", tags: [], keepSecrets: false })
      ).rejects.toThrow("There is nothing to save");
      expect(saveAutomation).not.toHaveBeenCalled();
    });
  });
});

describe("discarding", () => {
  /** Press Undo on the last toast. */
  const undo = () => {
    const calls = vi.mocked(toast.info).mock.calls;
    calls[calls.length - 1][1]!.action!.onClick();
  };

  it("can be undone", () => {
    record("ls\r");
    const take = store().recordedTake;
    store().discardRecordedTake();
    expect(store()).toMatchObject({ recordedTake: null, recordingSaveOpen: false });
    expect(toast.info).toHaveBeenCalledWith(
      "Discarded the recording of 1 key",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
    );
    undo();
    expect(store()).toMatchObject({ recordedTake: take, recordingSaveOpen: true });
    expect(saveAutomation).not.toHaveBeenCalled();
  });

  it("undone while another recording runs, loses neither", async () => {
    record("first\r");
    store().discardRecordedTake();
    const calls = vi.mocked(toast.info).mock.calls;
    const undoFirst = calls[calls.length - 1][1]!.action!.onClick as () => void;
    store().startRecording();
    store().recordInput("a", "second\r");
    undoFirst();
    store().stopRecording();
    expect(store().recordedTake?.chunks[0].data).toBe("first\r");
    await store().saveRecordedTake({ to: "new", name: "1", tags: [], keepSecrets: false });
    expect(store().recordedTake?.chunks[0].data).toBe("second\r");
    expect(store().recordingSaveOpen).toBe(true);
    store().discardRecordedTake();
    expect(store().recordedTake).toBeNull();
  });
});

describe("into the editor", () => {
  it("hands the take over instead of asking, also an empty one", () => {
    store().startRecording({ tabId: "b", intoEditor: "Deploy" });
    expect(store().recording).toMatchObject({ tabId: "b", intoEditor: "Deploy" });
    store().stopRecording();
    expect(store().recordingSaveOpen).toBe(false);
    expect(store().takeForEditor()?.chunks).toEqual([]);
    expect(store().recordedTake).toBeNull();
    expect(store().takeForEditor()).toBeNull();
  });
});
