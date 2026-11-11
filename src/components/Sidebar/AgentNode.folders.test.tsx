/**
 * Agent folder paths in the Remote Agents tree (#5322, COV-027).
 *
 * - Search filter: matched folders are force-expanded (even when stored
 *   collapsed), folders and definitions without a match are hidden, and folder
 *   toggles are suppressed so clearing the filter restores the stored state.
 * - "New Subfolder" from the folder menu creates the folder under its parent
 *   through the real `createAgentFolder` action.
 * - Keyboard: ArrowRight expands a collapsed folder then moves into its first
 *   child, ArrowLeft collapses an expanded folder or moves to the parent, and
 *   Space / Enter toggle. Expansion persists via the real `toggleAgentFolder`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { createAgentFolder, updateAgentFolder } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { typeInto } from "@/test/dirtyDismiss";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));

const AGENT_ID = "agent-folders-test";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Folder Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
  };
}

function def(id: string, name: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name, sessionType: "shell", config: {}, persistent: false, folderId };
}

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
  isExpanded = true
): AgentFolderInfo {
  return { id, name, parentId, isExpanded };
}

let container: HTMLDivElement;
let root: Root;

function seed(definitions: AgentDefinitionInfo[], folders: AgentFolderInfo[]) {
  seedAgentsRegion({
    remoteAgents: [makeAgent()],
    agentDefinitions: { [AGENT_ID]: definitions },
    agentFolders: { [AGENT_ID]: folders },
    agentSessions: {},
  });
}

async function render(filterQuery?: string) {
  await act(async () => {
    root.render(React.createElement(AgentNode, { agent: makeAgent(), filterQuery }));
  });
  await flushAsync();
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const folderRow = (id: string) => q(`agent-folder-toggle-${id}`) as HTMLElement;
const defRow = (id: string) => q(`agent-definition-${id}`);

async function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
  await flushAsync();
}

setupAgentsRegion();

describe("AgentNode — folder paths (#5322)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("search filter", () => {
    const FOLDERS = [
      folder("prod", "Prod", null, false),
      folder("web", "Web", "prod", false),
      folder("lab", "Lab"),
    ];
    const DEFS = [
      def("nginx", "nginx-edge", "web"),
      def("db", "postgres", "prod"),
      def("toy", "sandbox", "lab"),
      def("root-web", "web-root"),
    ];

    it("force-expands the folders on a match path and hides the rest", async () => {
      seed(DEFS, FOLDERS);
      await render("nginx");

      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("true");
      expect(folderRow("web").getAttribute("aria-expanded")).toBe("true");
      expect(defRow("nginx")).not.toBeNull();
      // Siblings without a match are hidden inside a shown folder.
      expect(defRow("db")).toBeNull();
      // A folder with no match anywhere below it is hidden entirely.
      expect(folderRow("lab")).toBeNull();
      expect(defRow("toy")).toBeNull();
      expect(defRow("root-web")).toBeNull();
    });

    it("matches definition names only, never folder names", async () => {
      seed(DEFS, FOLDERS);
      await render("web");
      expect(defRow("root-web")).not.toBeNull();
      // The Web folder's name matches, but nothing inside it does.
      expect(folderRow("web")).toBeNull();
      expect(folderRow("prod")).toBeNull();
    });

    it("suppresses folder toggles while filtering, so the stored state is kept", async () => {
      seed(DEFS, FOLDERS);
      await render("nginx");

      await act(async () => folderRow("prod").click());
      await press(folderRow("prod"), "ArrowLeft");

      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("true");
      expect(updateAgentFolder).not.toHaveBeenCalled();

      // Clearing the filter restores the stored (collapsed) state.
      await render("");
      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("false");
      expect(defRow("nginx")).toBeNull();
    });
  });

  describe("New Subfolder", () => {
    // #5322: the menu used to hand focus back to the folder row as it closed,
    // which blurred (and so cancelled) the input that had just opened, and on a
    // collapsed folder the input was never rendered at all.
    async function openNewSubfolder() {
      // Shift+F10 opens the folder row's menu (#5181).
      act(() => folderRow("prod").focus());
      await press(folderRow("prod"), "F10", { shiftKey: true });
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (el) => el.textContent?.includes("New Subfolder")
      );
      expect(item).toBeDefined();
      await act(async () => item!.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }

    it("creates the folder under its parent and renders it", async () => {
      seed([], [folder("prod", "Prod")]);
      vi.mocked(createAgentFolder).mockResolvedValue(folder("new", "Edge", "prod"));
      await render();

      await openNewSubfolder();
      const input = q("inline-folder-name-input") as HTMLInputElement;
      // The closing menu must not take focus back to the row (a blur cancels).
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      typeInto("inline-folder-name-input", "Edge");
      await press(input, "Enter");

      expect(createAgentFolder).toHaveBeenCalledWith(AGENT_ID, "Edge", "prod");
      expect(q("inline-folder-name-input")).toBeNull();
      const created = folderRow("new");
      expect(created).not.toBeNull();
      expect(created.textContent).toContain("Edge");
      expect(created.getAttribute("aria-level")).toBe("2");
    });

    it("expands a collapsed folder so the new-subfolder input is shown", async () => {
      seed([], [folder("prod", "Prod", null, false)]);
      await render();

      await openNewSubfolder();

      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(q("inline-folder-name-input"));
    });

    it("Escape cancels without creating anything", async () => {
      seed([], [folder("prod", "Prod")]);
      await render();

      await openNewSubfolder();
      typeInto("inline-folder-name-input", "Edge");
      await press(q("inline-folder-name-input") as HTMLElement, "Escape");

      expect(createAgentFolder).not.toHaveBeenCalled();
      expect(q("inline-folder-name-input")).toBeNull();
    });
  });

  describe("keyboard expand and collapse", () => {
    const tree = () => [
      folder("prod", "Prod", null, false),
      folder("web", "Web", "prod", true),
      folder("empty", "Empty", null, false),
    ];
    const defs = () => [def("nginx", "nginx", "web"), def("loose", "loose")];

    it("ArrowRight expands a collapsed folder and persists it", async () => {
      seed(defs(), tree());
      await render();
      const row = folderRow("prod");
      expect(row.getAttribute("aria-expanded")).toBe("false");

      act(() => row.focus());
      await press(row, "ArrowRight");

      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("true");
      expect(folderRow("web")).not.toBeNull();
      expect(updateAgentFolder).toHaveBeenCalledWith(AGENT_ID, { id: "prod", is_expanded: true });
      // Focus stays on the folder after expanding.
      expect(document.activeElement).toBe(folderRow("prod"));
    });

    it("ArrowRight on an expanded folder moves focus to its first child", async () => {
      seed(defs(), tree());
      await render();
      act(() => folderRow("prod").focus());
      await press(folderRow("prod"), "ArrowRight");
      await press(folderRow("prod"), "ArrowRight");
      expect(document.activeElement).toBe(folderRow("web"));
      // A further ArrowRight on the already-expanded Web folder reaches its definition.
      await press(folderRow("web"), "ArrowRight");
      expect(document.activeElement).toBe(defRow("nginx"));
    });

    it("ArrowRight on a collapsed folder without children does nothing", async () => {
      seed(defs(), tree());
      await render();
      act(() => folderRow("empty").focus());
      await press(folderRow("empty"), "ArrowRight");
      expect(folderRow("empty").getAttribute("aria-expanded")).toBe("false");
      expect(updateAgentFolder).not.toHaveBeenCalled();
    });

    it("ArrowLeft on a child moves to the parent, then collapses the parent", async () => {
      seed(defs(), tree());
      await render();
      act(() => folderRow("prod").focus());
      await press(folderRow("prod"), "ArrowRight");

      act(() => defRow("nginx")!.focus());
      await press(defRow("nginx")!, "ArrowLeft");
      expect(document.activeElement).toBe(folderRow("web"));

      // Web is expanded: ArrowLeft collapses it rather than moving up.
      await press(folderRow("web"), "ArrowLeft");
      expect(folderRow("web").getAttribute("aria-expanded")).toBe("false");
      expect(updateAgentFolder).toHaveBeenLastCalledWith(AGENT_ID, {
        id: "web",
        is_expanded: false,
      });

      // Collapsed child folder: ArrowLeft moves to its parent.
      await press(folderRow("web"), "ArrowLeft");
      expect(document.activeElement).toBe(folderRow("prod"));
      await press(folderRow("prod"), "ArrowLeft");
      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("false");
      expect(folderRow("web")).toBeNull();
    });

    it.each([" ", "Enter"])("%j toggles the focused folder", async (key) => {
      seed(defs(), tree());
      await render();
      act(() => folderRow("prod").focus());

      await press(folderRow("prod"), key);
      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("true");

      await press(folderRow("prod"), key);
      expect(folderRow("prod").getAttribute("aria-expanded")).toBe("false");
      expect(updateAgentFolder).toHaveBeenCalledTimes(2);
    });

    it("ArrowLeft on a root definition keeps focus in place", async () => {
      seed(defs(), tree());
      await render();
      const loose = defRow("loose")!;
      act(() => loose.focus());
      await press(loose, "ArrowLeft");
      expect(document.activeElement).toBe(loose);
    });
  });
});
