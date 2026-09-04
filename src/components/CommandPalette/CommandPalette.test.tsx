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
});
