/**
 * Tests for the command palette (#1484): fuzzy matching across commands and
 * saved connections, Enter to run/connect, and keyboard navigation.
 *
 * The connect flow itself is covered by useConnectSavedConnection's own tests;
 * here it is mocked so the palette's wiring (which entry, closing on activate)
 * is verified in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { getAllLeaves } from "@/utils/panelTree";
import { CommandPalette } from "./CommandPalette";
import type { SavedConnection } from "@/types/connection";
import { layoutState } from "@/test/layoutState";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { ensureBroadcastSubscribed } from "@/store/broadcastBridge";
import type { Workflow } from "@/types/workflow";

const { connectSpy } = vi.hoisted(() => ({
  connectSpy: vi.fn((_connection: unknown) => Promise.resolve()),
}));

vi.mock("@/hooks/useConnectSavedConnection", () => ({
  useConnectSavedConnection: () => ({ connect: connectSpy }),
}));

function sshConn(id: string, name: string, host: string): SavedConnection {
  return {
    id,
    name,
    folderId: null,
    config: { type: "ssh", config: { host, username: "user", authMethod: "agent" } },
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(React.createElement(CommandPalette));
  });
}

function getInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]');
  if (!el) throw new Error("command palette input not found");
  return el;
}

function typeInto(value: string) {
  const input = getInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keydown(key: string) {
  act(() => {
    getInput().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function activeLabel(): string | null {
  return (
    document.querySelector('[role="option"][aria-selected="true"] .command-palette__label')
      ?.textContent ?? null
  );
}

setupConnectionsRegion();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    commandPaletteOpen: true,
  });
  seedConnectionsRegion({
    connections: [
      sshConn("c1", "Production Server", "prod.example.com"),
      sshConn("c2", "Staging Box", "staging.example.com"),
    ],
  });
  render();
}, 10000);

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("CommandPalette", () => {
  it("ranks a fuzzy-matched command to the top", () => {
    typeInto("new term");
    expect(activeLabel()).toBe("New Terminal");
  });

  it("ranks a fuzzy-matched connection to the top", () => {
    typeInto("production");
    expect(activeLabel()).toBe("Production Server");
  });

  it("matches a connection by host", () => {
    typeInto("staging.example");
    expect(activeLabel()).toBe("Staging Box");
  });

  it("runs the highlighted command on Enter and closes", () => {
    const addTab = vi.fn(() => "tab-1");
    useAppStore.setState({ addTab });
    typeInto("new terminal");
    keydown("Enter");
    expect(addTab).toHaveBeenCalledWith("Terminal", "local");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("runs the highlighted workflow on Enter via the manual trigger and closes", () => {
    const runWorkflow = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      runWorkflow,
      workflows: [
        {
          id: "wf-1",
          name: "Deploy",
          tags: [],
          steps: [{ kind: "send-command", command: "echo hi" }],
          triggers: [{ kind: "manual" }],
          createdAt: "2026-07-24T00:00:00Z",
          updatedAt: "2026-07-24T00:00:00Z",
        },
      ],
    });
    typeInto("run workflow: deploy");
    expect(activeLabel()).toBe("Run Workflow: Deploy");
    keydown("Enter");
    expect(runWorkflow).toHaveBeenCalledWith("wf-1");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("lists saved workspaces and launches the highlighted one on Enter", () => {
    const launchWorkspace = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      launchWorkspace,
      workspaces: [{ id: "ws-1", name: "Dev Layout", connectionCount: 2 }],
    });
    typeInto("launch workspace: dev");
    expect(activeLabel()).toBe("Launch Workspace: Dev Layout");
    keydown("Enter");
    expect(launchWorkspace).toHaveBeenCalledWith("ws-1");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("connects the highlighted connection on Enter and closes", () => {
    typeInto("production");
    keydown("Enter");
    expect(connectSpy).toHaveBeenCalledOnce();
    expect(connectSpy.mock.calls[0][0]).toMatchObject({ id: "c1", name: "Production Server" });
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  it("moves the selection with the arrow keys", () => {
    // Empty query lists commands first; the first command is initially active.
    const firstActive = activeLabel();
    keydown("ArrowDown");
    expect(activeLabel()).not.toBe(firstActive);
  });

  it("closes on Escape", () => {
    keydown("Escape");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  it("shows an empty state when nothing matches", () => {
    typeInto("zzzznomatch");
    expect(document.querySelector(".command-palette__empty")).not.toBeNull();
  });

  it("surfaces a context-bound command disabled when no target applies", () => {
    // The initial state has an empty active panel, so Close Tab has no target.
    typeInto("close tab");
    expect(activeLabel()).toBe("Close Tab");
    const active = document.querySelector('[role="option"][aria-selected="true"]');
    expect(active?.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not run a disabled context command on Enter and keeps the palette open", () => {
    typeInto("close tab");
    keydown("Enter");
    expect(useAppStore.getState().commandPaletteOpen).toBe(true);
  });

  it("runs an available context command on Enter and closes", () => {
    // Give the active panel a focused terminal so Find in Terminal has a target.
    act(() => {
      const id = useAppStore
        .getState()
        .addTab("Shell", "local", undefined, { contentType: "terminal" });
      const panel = getAllLeaves(layoutState().rootPanel).find((p) =>
        p.tabs.some((t) => t.id === id)
      )!;
      useAppStore.getState().setActivePanel(panel.id);
      useAppStore.getState().setActiveTab(id, panel.id);
    });
    const toggleSpy = vi.spyOn(useAppStore.getState(), "toggleTerminalSearch");

    typeInto("find in terminal");
    expect(activeLabel()).toBe("Find in Terminal");
    keydown("Enter");

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  describe("Run Workflow on Broadcast Group (#3430)", () => {
    let harness: ReturnType<typeof installBroadcastHarness> | null = null;

    function wf(id: string, name: string): Workflow {
      return {
        id,
        name,
        tags: [],
        steps: [{ kind: "send-command", command: "echo hi" }],
        triggers: [{ kind: "manual" }],
        createdAt: "2026-09-26T00:00:00Z",
        updatedAt: "2026-09-26T00:00:00Z",
      };
    }

    /** Seed the broadcast region + connected targets, then remount the palette. */
    async function setup(opts: {
      active: boolean;
      connected: string[];
      workflows?: Workflow[];
    }): Promise<ReturnType<typeof vi.fn>> {
      harness = installBroadcastHarness({
        active: opts.active,
        sourceTabId: opts.active ? "t1" : null,
        targetTabIds: opts.active ? ["t1", "t2", "t3"] : [],
      });
      await act(async () => {
        await ensureBroadcastSubscribed();
      });
      const runWorkflow = vi.fn(() => Promise.resolve());
      useAppStore.setState({
        runWorkflow,
        getBroadcastTargetTabIds: () => [...opts.connected],
        workflows: opts.workflows ?? [wf("wf-1", "Deploy"), wf("wf-2", "Health Check")],
      });
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      render();
      return runWorkflow;
    }

    function broadcastItem(): HTMLElement | null {
      return document.querySelector('[data-testid="command-palette-item-broadcast-workflow"]');
    }

    afterEach(() => {
      harness?.teardown();
      harness = null;
    });

    it("is hidden while broadcasting is off", async () => {
      await setup({ active: false, connected: [] });
      expect(broadcastItem()).toBeNull();
    });

    it("is listed and enabled while broadcasting with a connected terminal", async () => {
      await setup({ active: true, connected: ["t1", "t2"] });
      const item = broadcastItem();
      expect(item).not.toBeNull();
      expect(item?.getAttribute("aria-disabled")).toBeNull();
      expect(item?.textContent).toContain("Run Workflow on Broadcast Group");
      expect(item?.textContent).toContain("2 terminals");
    });

    it("is disabled and inert when the group has no connected terminals", async () => {
      const runWorkflow = await setup({ active: true, connected: [] });
      typeInto("run workflow on broadcast group");
      expect(activeLabel()).toContain("Run Workflow on Broadcast Group");
      expect(broadcastItem()?.getAttribute("aria-disabled")).toBe("true");
      keydown("Enter");
      // Still on the root list, palette open, nothing run.
      expect(document.querySelector('[data-testid="command-palette-picker"]')).toBeNull();
      expect(useAppStore.getState().commandPaletteOpen).toBe(true);
      expect(runWorkflow).not.toHaveBeenCalled();
    });

    it("is disabled when there are no workflows to run", async () => {
      await setup({ active: true, connected: ["t1"], workflows: [] });
      expect(broadcastItem()?.getAttribute("aria-disabled")).toBe("true");
    });

    it("opens a workflow picker listing every workflow", async () => {
      await setup({ active: true, connected: ["t1", "t2"] });
      typeInto("run workflow on broadcast group");
      keydown("Enter");
      expect(useAppStore.getState().commandPaletteOpen).toBe(true);
      expect(document.querySelector('[data-testid="command-palette-picker"]')).not.toBeNull();
      expect(getInput().value).toBe("");
      const labels = [...document.querySelectorAll(".command-palette__label")].map(
        (el) => el.textContent
      );
      expect(labels).toEqual(["Deploy", "Health Check"]);
    });

    it("runs the picked workflow on the group's connected terminals and closes", async () => {
      const runWorkflow = await setup({ active: true, connected: ["t1", "t3"] });
      typeInto("run workflow on broadcast group");
      keydown("Enter");
      typeInto("health");
      expect(activeLabel()).toBe("Health Check");
      keydown("Enter");
      expect(runWorkflow).toHaveBeenCalledWith("wf-2", { targetTabIds: ["t1", "t3"] });
      expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    });

    it("Backspace on an empty picker query returns to the command list", async () => {
      const runWorkflow = await setup({ active: true, connected: ["t1"] });
      typeInto("run workflow on broadcast group");
      keydown("Enter");
      expect(document.querySelector('[data-testid="command-palette-picker"]')).not.toBeNull();
      keydown("Backspace");
      expect(document.querySelector('[data-testid="command-palette-picker"]')).toBeNull();
      expect(broadcastItem()).not.toBeNull();
      expect(runWorkflow).not.toHaveBeenCalled();
    });
  });
});
