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
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { getAllLeaves } from "@/utils/panelTree";
import { CommandPalette } from "./CommandPalette";
import type { SavedConnection } from "@/types/connection";
import { layoutState } from "@/test/layoutState";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { ensureBroadcastSubscribed } from "@/store/broadcastBridge";
import { OPEN_RUN_AUTOMATION_EVENT } from "@/services/contextCommands";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import type { Automation } from "@/types/generated/Automation";
import { getActionAccelerator } from "@/services/keybindings";

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

function automation(id: string, name: string, over: Partial<Automation> = {}): Automation {
  return {
    id,
    name,
    tags: [],
    steps: [{ kind: "send-command", command: "echo hi" }],
    triggers: [],
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

/**
 * Mount the palette and let its async mount work (the connections-region
 * subscription resolving and fanning its snapshot) settle inside `act()`.
 */
async function render() {
  await act(async () => {
    root.render(React.createElement(CommandPalette));
  });
  await flushAsync();
}

/** Update the store while the palette is mounted, flushing the re-render in `act()`. */
function setStore(partial: Partial<ReturnType<typeof useAppStore.getState>>) {
  act(() => {
    useAppStore.setState(partial);
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

beforeEach(async () => {
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
  await render();
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
    expect(activeLabel()).toBe("New terminal");
  });

  it("ranks a fuzzy-matched connection to the top", () => {
    typeInto("production");
    expect(activeLabel()).toBe("Production Server");
  });

  it("matches a connection by host", () => {
    typeInto("staging.example");
    expect(activeLabel()).toBe("Staging Box");
  });

  it("shows the command's effective accelerator on its row (#4013)", () => {
    typeInto("new term");
    const expected = getActionAccelerator("new-terminal");
    // The default binding exists, so the row must render it — not a blank slot.
    expect(expected).toBeTruthy();
    const row = document.querySelector('[data-testid="command-palette-item-command:new-terminal"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector(".command-palette__accelerator")?.textContent).toBe(expected);
    // A command row carries an accelerator, never a connection-type badge.
    expect(row?.querySelector(".command-palette__type")).toBeNull();
  });

  it("shows the connection-type badge on a saved connection's row (#4013)", () => {
    typeInto("production");
    const row = document.querySelector('[data-testid="command-palette-item-connection:c1"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector(".command-palette__label")?.textContent).toBe("Production Server");
    expect(row?.querySelector(".command-palette__type")?.textContent).toBe("ssh");
    // A connection row has no accelerator.
    expect(row?.querySelector(".command-palette__accelerator")).toBeNull();
  });

  it("runs the highlighted command on Enter and closes", () => {
    const addLocalShellTab = vi.fn(() => "tab-1");
    setStore({ addLocalShellTab });
    typeInto("new terminal");
    keydown("Enter");
    expect(addLocalShellTab).toHaveBeenCalledWith();
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  describe("automations (#5818, slice 11)", () => {
    const steps: Automation = automation("wf-1", "Deploy", {
      steps: [{ kind: "send-command", command: "echo hi" }],
    });
    const typed: Automation = automation("m-1", "Login", {
      steps: [{ kind: "type-keys", chunks: [{ data: "a", delayMs: 0 }] }],
      tags: ["credentials"],
    });
    const runAutomation = vi.fn(() => Promise.resolve());

    /** The library, and an active terminal unless `terminal` is null. */
    function seed(terminal: string | null = "prod-web"): void {
      setStore({ runAutomation, ...automationLibraryState([steps, typed]) });
      if (terminal === null) return;
      act(() => {
        const id = useAppStore
          .getState()
          .addTab(terminal, "local", undefined, { contentType: "terminal" });
        const panel = getAllLeaves(layoutState().rootPanel).find((p) =>
          p.tabs.some((t) => t.id === id)
        )!;
        useAppStore.getState().setActivePanel(panel.id);
        useAppStore.getState().setActiveTab(id, panel.id);
      });
    }
    const row = (id: string) =>
      document.querySelector(`[data-testid="command-palette-item-automation:${id}"]`);

    it("is one kind of entry: name first, and where it runs (R-083)", () => {
      seed();
      typeInto("deploy");
      expect(activeLabel()).toBe("Deploy");
      expect(row("wf-1")?.querySelector(".command-palette__target")?.textContent).toBe(
        "→ prod-web"
      );
      expect(row("wf-1")?.textContent).not.toMatch(/macro|workflow/i);
      typeInto("login");
      expect(activeLabel()).toBe("Login");
      expect(document.querySelectorAll('[data-testid*="item-automation:"]')).toHaveLength(1);
    });

    it.each([
      ["run automation: deploy", "Deploy"],
      ["run macro: login", "Login"],
      ["run workflow: deploy", "Deploy"],
      // Either old word finds either of them.
      ["run macro: deploy", "Deploy"],
      ["run workflow: login", "Login"],
      ["credentials", "Login"],
    ])("is found by %s", (query, name) => {
      seed();
      typeInto(query);
      expect(activeLabel()).toBe(name);
    });

    it.each([
      ["record macro", "Record automation (start/stop)"],
      ["play macro", "Run automation…"],
    ])("the command once called %s is %s", (query, label) => {
      seed();
      typeInto(query);
      expect(activeLabel()).toBe(label);
    });

    it.each([
      ["deploy", "wf-1"],
      ["login", "m-1"],
    ])("runs %s through the one entry point, from the palette", (query, id) => {
      seed();
      typeInto(query);
      keydown("Enter");
      expect(runAutomation).toHaveBeenCalledWith(id, { origin: "palette" });
      expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    });

    it("asks where without an active terminal", () => {
      const asked: unknown[] = [];
      const listen = (e: Event) => asked.push((e as CustomEvent).detail);
      window.addEventListener(OPEN_RUN_AUTOMATION_EVENT, listen);
      seed(null);
      typeInto("deploy");
      expect(row("wf-1")?.querySelector(".command-palette__target")?.textContent).toBe(
        "→ choose a terminal"
      );
      keydown("Enter");
      window.removeEventListener(OPEN_RUN_AUTOMATION_EVENT, listen);
      expect(asked).toEqual([{ automationId: "wf-1" }]);
      expect(runAutomation).not.toHaveBeenCalled();
    });
  });

  it("lists saved workspaces and launches the highlighted one on Enter", () => {
    const launchWorkspace = vi.fn(() => Promise.resolve());
    setStore({
      launchWorkspace,
      workspaces: [{ id: "ws-1", name: "Dev Layout", connectionCount: 2 }],
    });
    typeInto("launch workspace: dev");
    expect(activeLabel()).toBe("Dev Layout");
    keydown("Enter");
    expect(launchWorkspace).toHaveBeenCalledWith("ws-1");
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("lists workspaces by name with a kind tag and still finds them by the verb (#5530)", () => {
    setStore({ workspaces: [{ id: "ws-1", name: "Dev Layout", connectionCount: 2 }] });
    typeInto("dev layout");
    expect(activeLabel()).toBe("Dev Layout");
    const item = document.querySelector('[data-testid="command-palette-item-workspace:ws-1"]');
    expect(item?.querySelector(".command-palette__label")?.textContent).toBe("Dev Layout");
    expect(item?.querySelector(".command-palette__type")?.textContent).toBe("workspace");
    typeInto("launch workspace");
    expect(activeLabel()).toBe("Dev Layout");
  });

  it("asks to confirm a workspace launch that would end live sessions (UX2-002)", () => {
    const launchWorkspace = vi.fn(() => Promise.resolve());
    setStore({
      launchWorkspace,
      workspaces: [{ id: "ws-1", name: "Dev Layout", connectionCount: 2 }],
    });
    act(() => {
      useAppStore.getState().addTab("live", "local");
      const tab = getAllLeaves(layoutState().rootPanel)[0].tabs[0];
      useAppStore.getState().setTabSessionId(tab.id, "sess-live");
    });
    typeInto("launch workspace: dev");
    keydown("Enter");
    expect(launchWorkspace).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWorkspaceLaunch).toMatchObject({ id: "ws-1", count: 1 });
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
    expect(document.querySelector('[data-testid="command-palette-empty"]')).not.toBeNull();
  });

  it("surfaces a context-bound command disabled when no target applies", () => {
    // The initial state has an empty active panel, so Close tab has no target.
    typeInto("close tab");
    expect(activeLabel()).toBe("Close tab");
    const active = document.querySelector('[role="option"][aria-selected="true"]');
    expect(active?.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not run a disabled context command on Enter and keeps the palette open", () => {
    typeInto("close tab");
    keydown("Enter");
    expect(useAppStore.getState().commandPaletteOpen).toBe(true);
  });

  it("runs an available context command on Enter and closes", () => {
    // Give the active panel a focused terminal so Find in terminal has a target.
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
    expect(activeLabel()).toBe("Find in terminal");
    keydown("Enter");

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
  });

  describe("Run automation on broadcast group (#3430)", () => {
    let harness: ReturnType<typeof installBroadcastHarness> | null = null;

    /** Seed the broadcast region + connected targets, then remount the palette. */
    async function setup(opts: {
      active: boolean;
      connected: string[];
      automations?: Automation[];
    }): Promise<ReturnType<typeof vi.fn>> {
      harness = installBroadcastHarness({
        active: opts.active,
        sourceTabId: opts.active ? "t1" : null,
        targetTabIds: opts.active ? ["t1", "t2", "t3"] : [],
      });
      await act(async () => {
        await ensureBroadcastSubscribed();
      });
      const runAutomation = vi.fn(() => Promise.resolve());
      setStore({
        runAutomation,
        getBroadcastTargetTabIds: () => [...opts.connected],
        ...automationLibraryState(
          opts.automations ?? [automation("wf-1", "Deploy"), automation("wf-2", "Health Check")]
        ),
      });
      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      await render();
      return runAutomation;
    }

    function broadcastItem(): HTMLElement | null {
      return document.querySelector('[data-testid="command-palette-item-broadcast"]');
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
      expect(item?.textContent).toContain("Run automation on broadcast group");
      expect(item?.textContent).toContain("2 terminals");
    });

    it("is disabled and inert when the group has no connected terminals", async () => {
      const runAutomation = await setup({ active: true, connected: [] });
      typeInto("run automation on broadcast group");
      expect(activeLabel()).toContain("Run automation on broadcast group");
      expect(broadcastItem()?.getAttribute("aria-disabled")).toBe("true");
      keydown("Enter");
      // Still on the root list, palette open, nothing run.
      expect(document.querySelector('[data-testid="command-palette-picker"]')).toBeNull();
      expect(useAppStore.getState().commandPaletteOpen).toBe(true);
      expect(runAutomation).not.toHaveBeenCalled();
    });

    it("is disabled when there are no automations to run", async () => {
      await setup({ active: true, connected: ["t1"], automations: [] });
      expect(broadcastItem()?.getAttribute("aria-disabled")).toBe("true");
    });

    it("opens a automation picker listing every automation", async () => {
      await setup({ active: true, connected: ["t1", "t2"] });
      typeInto("run automation on broadcast group");
      keydown("Enter");
      expect(useAppStore.getState().commandPaletteOpen).toBe(true);
      expect(document.querySelector('[data-testid="command-palette-picker"]')).not.toBeNull();
      expect(getInput().value).toBe("");
      const labels = [...document.querySelectorAll(".command-palette__label")].map(
        (el) => el.textContent
      );
      expect(labels).toEqual(["Deploy", "Health Check"]);
    });

    it("runs the picked automation on the group's connected terminals and closes", async () => {
      const runAutomation = await setup({ active: true, connected: ["t1", "t3"] });
      typeInto("run automation on broadcast group");
      keydown("Enter");
      typeInto("health");
      expect(activeLabel()).toBe("Health Check");
      keydown("Enter");
      expect(runAutomation).toHaveBeenCalledWith("wf-2", {
        targetTabIds: ["t1", "t3"],
        origin: "palette",
      });
      expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    });

    it("Backspace on an empty picker query returns to the command list", async () => {
      const runAutomation = await setup({ active: true, connected: ["t1"] });
      typeInto("run automation on broadcast group");
      keydown("Enter");
      expect(document.querySelector('[data-testid="command-palette-picker"]')).not.toBeNull();
      keydown("Backspace");
      expect(document.querySelector('[data-testid="command-palette-picker"]')).toBeNull();
      expect(broadcastItem()).not.toBeNull();
      expect(runAutomation).not.toHaveBeenCalled();
    });
  });

  describe("WAI-ARIA combobox pattern (#4330 / A11Y2-004)", () => {
    function listbox(): HTMLElement {
      const el = document.querySelector<HTMLElement>('[role="listbox"]');
      if (!el) throw new Error("listbox not found");
      return el;
    }
    function selectedOption(): HTMLElement | null {
      return document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    }

    it("points aria-controls at the listbox and reports it expanded while results show", () => {
      const input = getInput();
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.getAttribute("aria-autocomplete")).toBe("list");
      expect(input.getAttribute("aria-controls")).toBe(listbox().id);
      expect(input.getAttribute("aria-expanded")).toBe("true");
    });

    it("reports collapsed (not a hard-coded true) when nothing matches", () => {
      typeInto("zzzznomatch");
      expect(getInput().getAttribute("aria-expanded")).toBe("false");
      expect(getInput().hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("gives every option a unique, stable id", () => {
      const ids = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.id);
      expect(ids.every((id) => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("points aria-activedescendant at the highlighted option and follows the arrow keys", () => {
      const first = selectedOption();
      expect(first).not.toBeNull();
      expect(getInput().getAttribute("aria-activedescendant")).toBe(first!.id);

      keydown("ArrowDown");
      const second = selectedOption();
      expect(second).not.toBeNull();
      expect(second!.id).not.toBe(first!.id);
      expect(getInput().getAttribute("aria-activedescendant")).toBe(second!.id);

      keydown("ArrowUp");
      expect(getInput().getAttribute("aria-activedescendant")).toBe(first!.id);
    });
  });
});
