/**
 * Which footer action is primary in the connection editor (#5755).
 *
 * Maintainer decision: a new connection (or new agent connection) is saved to
 * be used, so "Save and connect" is the primary (filled) action; editing an
 * existing one keeps "Save" primary. The remote-agent editor has no connect
 * action, so Save stays primary there. The primary sits on the right of the
 * footer (copy style guide), and Enter from a single-line field runs it.
 */
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { flushAsync, flushMacrotask } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { getAllTabsAcrossGroupTrees } from "@/store/layoutSelectors";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionEditorMeta } from "@/types/terminal";
import type {
  ConnectionTypeInfo,
  RemoteAgentDefinition,
  SavedConnection,
} from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

const TELNET_TYPE: ConnectionTypeInfo = {
  typeId: "telnet",
  displayName: "Telnet",
  icon: "telnet",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: false },
          { key: "port", label: "Port", fieldType: { type: "port" }, required: false },
        ],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** The type a new connection's editor starts on. */
const LOCAL_TYPE: ConnectionTypeInfo = {
  ...TELNET_TYPE,
  typeId: "local",
  displayName: "Local",
  icon: "local",
};

const EXISTING: SavedConnection = {
  id: "Lab switch",
  name: "Lab switch",
  config: { type: "telnet", config: { host: "10.0.0.5", port: 23 } },
  folderId: null,
};

const AGENT: RemoteAgentDefinition = {
  id: "agent-1",
  name: "Lab Agent",
  config: { host: "lab.example.com", port: 22, username: "user", authMethod: "password" },
  connectionState: "connected",
  isExpanded: true,
  agentSettings: DEFAULT_AGENT_SETTINGS,
  capabilities: {
    connectionTypes: [TELNET_TYPE],
    maxSessions: 10,
    availableShells: [],
    availableSerialPorts: [],
    availableDockerImages: [],
  },
};

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await flushMacrotask();
  });
}

async function render(meta: ConnectionEditorMeta) {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor tabId="tab-primary-action" meta={meta} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function q(testId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
}

function isPrimary(btn: HTMLElement | null): boolean {
  return !!btn?.classList.contains("ui-btn--primary");
}

/** The primary buttons in the footer, in DOM order. */
function primaryButtons(): string[] {
  const footer = container.querySelector('[data-testid="connection-editor-actions"]')!;
  return Array.from(footer.querySelectorAll("button.ui-btn--primary")).map(
    (b) => b.getAttribute("data-testid") ?? ""
  );
}

/** The footer button that is rendered last (the right-most one). */
function lastFooterButton(): string | null {
  const footer = container.querySelector('[data-testid="connection-editor-actions"]')!;
  const buttons = footer.querySelectorAll(":scope > button");
  return buttons[buttons.length - 1]?.getAttribute("data-testid") ?? null;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="connection-editor-name-input"]')!;
}

async function pressEnter(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  });
  await flush();
  await flushAsync();
}

/** The terminal tabs opened so far (the editor's own tab excluded). */
function terminalTabs() {
  return getAllTabsAcrossGroupTrees().filter((t) => t.contentType === "terminal");
}

function invokeCalls(cmd: string): unknown[][] {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd);
}

describe("ConnectionEditor — primary footer action (#5755)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "save_connection") return Promise.resolve("persisted-id");
      if (cmd === "load_connections_and_folders")
        return Promise.resolve({ connections: [EXISTING], folders: [] });
      return Promise.resolve(null);
    });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      connectionTypes: [LOCAL_TYPE, TELNET_TYPE],
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedConnectionsRegion({ connections: [EXISTING] });
    seedAgentsRegion({
      remoteAgents: [AGENT],
      agentDefinitions: {
        [AGENT.id]: [
          {
            id: "def-1",
            name: "Console",
            sessionType: "telnet",
            config: { host: "10.0.0.9" },
            persistent: false,
            folderId: null,
          },
        ],
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  describe("which button is primary", () => {
    it("a new connection makes Save and connect primary, on the right", async () => {
      await render({ connectionId: "new", folderId: null });
      expect(isPrimary(q("connection-editor-save-connect"))).toBe(true);
      expect(isPrimary(q("connection-editor-save"))).toBe(false);
      expect(primaryButtons()).toEqual(["connection-editor-save-connect"]);
      expect(lastFooterButton()).toBe("connection-editor-save-connect");
    });

    it("editing a connection keeps Save primary, on the right", async () => {
      await render({ connectionId: EXISTING.id, folderId: null });
      expect(isPrimary(q("connection-editor-save"))).toBe(true);
      expect(isPrimary(q("connection-editor-save-connect"))).toBe(false);
      expect(primaryButtons()).toEqual(["connection-editor-save"]);
      expect(lastFooterButton()).toBe("connection-editor-save");
    });

    it("a new agent connection makes Save and connect primary", async () => {
      await render({ connectionId: AGENT.id, folderId: null, agentDefinitionId: "new" });
      expect(primaryButtons()).toEqual(["connection-editor-save-connect"]);
      expect(lastFooterButton()).toBe("connection-editor-save-connect");
    });

    it("editing an agent connection keeps Save primary", async () => {
      await render({ connectionId: AGENT.id, folderId: null, agentDefinitionId: "def-1" });
      expect(primaryButtons()).toEqual(["connection-editor-save"]);
      expect(lastFooterButton()).toBe("connection-editor-save");
    });

    it("the remote-agent editor has no connect action, so Save stays primary", async () => {
      await render({ connectionId: AGENT.id, folderId: null });
      expect(q("connection-editor-save-connect")).toBeNull();
      expect(primaryButtons()).toEqual(["connection-editor-save"]);
    });
  });

  describe("Enter runs the primary action", () => {
    it("on a new connection, Enter saves and opens the connection's tab", async () => {
      await render({ connectionId: "new", folderId: null });
      setValue(nameInput(), "Fresh box");
      await flush();
      await pressEnter(nameInput());

      expect(invokeCalls("save_connection")).toHaveLength(1);
      const tabs = terminalTabs();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].title).toBe("Fresh box");
    });

    it("on an existing connection, Enter saves without connecting", async () => {
      await render({ connectionId: EXISTING.id, folderId: null });
      setValue(nameInput(), "Lab switch 2");
      await flush();
      await pressEnter(nameInput());

      expect(invokeCalls("save_connection")).toHaveLength(1);
      expect(terminalTabs()).toHaveLength(0);
    });

    it("on a new connection with an invalid form, Enter neither saves nor connects", async () => {
      await render({ connectionId: "new", folderId: null });
      // Blank name: the form is invalid, so the primary action is gated.
      setValue(nameInput(), "");
      await flush();
      await pressEnter(nameInput());

      expect(invokeCalls("save_connection")).toHaveLength(0);
      expect(terminalTabs()).toHaveLength(0);
    });
  });
});
