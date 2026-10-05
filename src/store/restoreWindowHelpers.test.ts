/**
 * Direct tests for the restore and multi-window helpers (#3992). They were only
 * reached through the layout-persistence and window-management slices, which
 * stub the probe and the window spawn, so the helpers' own branches had no test:
 *
 * - `probeRestorePromptReachability`: patches the active prompt's tabs with the
 *   probe result, drops a result for a prompt that is no longer active, and
 *   never throws out of the background probe;
 * - `restoreWindowedLayout`: spawns each secondary window (empty or seeded),
 *   survives a failed spawn, and returns the main window's groups (or every
 *   group for a plan with no main entry);
 * - `buildTransferAwareHandoff`: carries the optional tab fields only when set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogEntry, TerminalTab } from "@/types/terminal";
import type { WorkspaceTabGroupDef } from "@/types/workspace";
import type { RestorePrompt } from "@/utils/restoreMode";
import { onFrontendLog } from "@/utils/frontendLog";

import type { AppState } from "./appStore";
import { probeRestorePromptReachability } from "./restoreHelpers";
import { buildTransferAwareHandoff, restoreWindowedLayout } from "./windowHelpers";

const api = vi.hoisted(() => ({
  openWindow: vi.fn(),
  listSerialPorts: vi.fn(),
  probeTargetReachable: vi.fn(),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  openWindow: api.openWindow,
  listSerialPorts: api.listSerialPorts,
}));

vi.mock("@/services/networkApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/networkApi")>()),
  probeTargetReachable: api.probeTargetReachable,
}));

let logs: LogEntry[] = [];
let offLog: (() => void) | null = null;

beforeEach(() => {
  api.openWindow.mockReset().mockResolvedValue(undefined);
  api.listSerialPorts.mockReset().mockResolvedValue(["/dev/ttyUSB0"]);
  api.probeTargetReachable.mockReset().mockResolvedValue(true);
  logs = [];
  offLog = onFrontendLog((entry) => logs.push(entry));
});

afterEach(() => {
  offLog?.();
});

describe("probeRestorePromptReachability", () => {
  function prompt(): RestorePrompt {
    return {
      tabCount: 3,
      tabs: [
        { title: "web", typeLabel: "SSH", target: { kind: "host", host: "web", port: 22 } },
        { title: "board", typeLabel: "Serial", target: { kind: "serial", device: "/dev/ttyX" } },
        // No target: probed as a local tab.
        { title: "shell", typeLabel: "Local" },
      ],
    };
  }

  /** A minimal store whose `restorePrompt` is the given prompt. */
  function store(active: RestorePrompt | null) {
    let state = { restorePrompt: active } as AppState;
    const set = vi.fn((partial: Partial<AppState>) => {
      state = { ...state, ...partial };
    });
    return { get: () => state, set };
  }

  it("patches the active prompt's tabs with the probe results", async () => {
    const p = prompt();
    const s = store(p);
    api.probeTargetReachable.mockResolvedValue(false);

    await probeRestorePromptReachability(p, s.get, s.set);

    expect(api.probeTargetReachable).toHaveBeenCalledWith("web", 22);
    const tabs = s.get().restorePrompt!.tabs;
    // A local tab has nothing to probe, so it stays "unknown".
    expect(tabs.map((t) => t.reachability)).toEqual(["unreachable", "unreachable", "unknown"]);
    expect(tabs[0].unreachableReason).toBe("host unreachable");
    expect(tabs[1].unreachableReason).toBe("device offline");
    expect(tabs[2].unreachableReason).toBeUndefined();
  });

  it("drops the result when the prompt was replaced or dismissed meanwhile", async () => {
    const p = prompt();
    const s = store(null);

    await probeRestorePromptReachability(p, s.get, s.set);

    expect(s.set).not.toHaveBeenCalled();
    expect(s.get().restorePrompt).toBeNull();
  });

  it("marks tabs unknown when the port listing and the host probe fail", async () => {
    const p = prompt();
    const s = store(p);
    api.listSerialPorts.mockRejectedValue(new Error("enumeration crashed"));
    api.probeTargetReachable.mockRejectedValue(new Error("probe crashed"));

    await probeRestorePromptReachability(p, s.get, s.set);

    const tabs = s.get().restorePrompt!.tabs;
    expect(tabs.map((t) => t.reachability)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("logs instead of throwing when applying the result fails", async () => {
    const p = prompt();
    const s = store(p);
    s.set.mockImplementation(() => {
      throw new Error("store torn down");
    });

    await expect(probeRestorePromptReachability(p, s.get, s.set)).resolves.toBeUndefined();

    expect(logs.map((l) => l.message)).toContainEqual(
      expect.stringContaining("restore reachability probe failed: store torn down")
    );
  });
});

describe("restoreWindowedLayout", () => {
  const group = (name: string): WorkspaceTabGroupDef => ({ name }) as WorkspaceTabGroupDef;

  it("spawns each secondary window and returns the main window's groups", async () => {
    const main = [group("main-1")];
    const result = await restoreWindowedLayout([
      { windowId: "main", isMain: true, tabGroups: main },
      { windowId: "w2", isMain: false, tabGroups: [group("side")] },
      { windowId: "w3", isMain: false, tabGroups: [] },
    ]);

    expect(result).toBe(main);
    expect(api.openWindow).toHaveBeenCalledTimes(2);
    expect(api.openWindow).toHaveBeenNthCalledWith(1, undefined, { tabGroups: [group("side")] });
    // A window that owns no groups spawns empty (the #1902 empty-window state).
    expect(api.openWindow).toHaveBeenNthCalledWith(2);
  });

  it("logs a failed spawn and still spawns the remaining windows", async () => {
    api.openWindow.mockRejectedValueOnce(new Error("window limit"));

    await restoreWindowedLayout([
      { windowId: "w2", isMain: false, tabGroups: [] },
      { windowId: "w3", isMain: false, tabGroups: [] },
    ]);

    expect(api.openWindow).toHaveBeenCalledTimes(2);
    const messages = logs.map((l) => l.message);
    expect(messages).toContainEqual(expect.stringContaining("spawn restore window w2 failed"));
    expect(messages).toContainEqual(expect.stringContaining("window limit"));
  });

  it("returns every group in order when the plan has no main entry", async () => {
    const result = await restoreWindowedLayout([
      { windowId: "w2", isMain: false, tabGroups: [group("a")] },
      { windowId: "w3", isMain: false, tabGroups: [group("b"), group("c")] },
    ]);

    expect(result.map((g) => g.name)).toEqual(["a", "b", "c"]);
  });
});

describe("buildTransferAwareHandoff", () => {
  const base = {
    id: "tab-1",
    title: "shell",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "p1",
    isActive: true,
  } as unknown as TerminalTab;

  it("omits the optional fields and transfer ids of a bare tab", () => {
    const { record, transferSessionIds } = buildTransferAwareHandoff(base);

    expect(record.tab).toEqual({
      sessionId: undefined,
      title: "shell",
      connectionType: "local",
      contentType: "terminal",
      config: base.config,
    });
    expect(transferSessionIds).toEqual([]);
  });

  it("carries every optional field that is set, and the session's transfers", () => {
    const tab = {
      ...base,
      sessionId: "s1",
      initialCommand: "top",
      persistentConnectionId: "pc1",
      connectionId: "c1",
      spawned: true,
    } as TerminalTab;

    const { record, transferSessionIds } = buildTransferAwareHandoff(tab);

    expect(record.tab).toMatchObject({
      sessionId: "s1",
      initialCommand: "top",
      persistentConnectionId: "pc1",
      connectionId: "c1",
      spawned: true,
    });
    expect(record.tab).not.toHaveProperty("panelId");
    expect(transferSessionIds).toEqual(["s1"]);
  });
});
