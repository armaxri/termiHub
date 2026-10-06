/**
 * The file browser of an agent-hosted SSH / Docker session (#3242): it lists
 * the session's own files through the session layer, and when the remote agent
 * is too old to browse such a session it says to update the agent instead of
 * showing a raw error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { setupFileBrowsersRegion } from "@/test/fileBrowsersRegionTestHarness";
import { setupVirtualListSizing } from "@/test/virtualListSize";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { FileBrowser } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { DEFAULT_AGENT_SETTINGS, type FileEntry } from "@/types/connection";

// The Download pickers (#3944): Save-as for a file, a folder picker for a folder.
const saveMock = vi.fn((): Promise<string | null> => Promise.resolve("/local/app.log"));
const openMock = vi.fn(
  (_options: unknown): Promise<string | null> => Promise.resolve("/local/target")
);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: () => saveMock(),
  open: (options: unknown) => openMock(options),
}));

// Byte-based downloads are written by the backend (#3115), never the fs plugin.
vi.mock("@tauri-apps/plugin-fs", () => {
  throw new Error("downloads must not use the fs plugin (#3115)");
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(vi.fn())),
  }),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
  onLocalDirChanged: vi.fn(() => Promise.resolve(vi.fn())),
  base64ToBytes: vi.fn(() => new Uint8Array()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getHomeDir: vi.fn(() => Promise.resolve("/home/test")),
  };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

setupAgentsRegion();
setupFileBrowsersRegion();
setupVirtualListSizing();

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/srv/${name}`,
    isDirectory,
    size: 12,
    modified: "2026-09-01T00:00:00Z",
    permissions: "rw-r--r--",
    writable: true,
  };
}

/** Make an agent-hosted `sessionType` tab active on an agent that can browse it. */
function seedAgentSession(sessionType: "ssh" | "docker", sessionId: string) {
  const tab: TerminalTab = {
    id: "tab-1",
    sessionId,
    title: `${sessionType} on agent`,
    connectionType: "remote-session",
    contentType: "terminal",
    config: {
      type: "remote-session",
      config: { agentId: "agent-1", sessionType },
    },
    panelId: "panel-1",
    isActive: true,
  };
  const panel: LeafPanel = { type: "leaf", id: tab.panelId, tabs: [tab], activeTabId: tab.id };
  seedLayoutState({ activePanelId: tab.panelId, rootPanel: panel });
  seedAgentsRegion({
    remoteAgents: [
      {
        id: "agent-1",
        name: "Build host",
        config: { host: "build.example.com", port: 22, username: "ci", authMethod: "key" },
        connectionState: "connected",
        isExpanded: false,
        capabilities: {
          connectionTypes: [
            {
              typeId: sessionType,
              displayName: sessionType,
              icon: "terminal",
              schema: { groups: [] },
              capabilities: {
                monitoring: true,
                fileBrowser: true,
                resize: true,
                persistent: true,
              },
            },
          ],
          maxSessions: 10,
          availableShells: [],
          availableSerialPorts: [],
          dockerAvailable: true,
          availableDockerImages: [],
        },
        agentSettings: DEFAULT_AGENT_SETTINGS,
      },
    ],
  });
}

async function renderBrowser() {
  useAppStore.setState({ sidebarView: "files" });
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <FileBrowser />
      </TooltipProvider>
    );
  });
  await flushAsync();
  await flushAsync();
}

describe("FileBrowser — agent-hosted sessions (#3242)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it.each(["ssh", "docker"] as const)(
    "lists an agent-hosted %s session's own files through its session",
    async (sessionType) => {
      const sessionId = `${sessionType}-on-agent`;
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === "session_list_files") {
          const { sessionId: asked } = args as { sessionId: string };
          return asked === sessionId
            ? Promise.resolve([entry("app.log"), entry("data", true)])
            : Promise.reject(new Error(`unexpected session ${asked}`));
        }
        return Promise.resolve(undefined);
      });
      seedAgentSession(sessionType, sessionId);

      await renderBrowser();

      expect(currentFileBrowsersView().mode).toBe("session");
      expect(useAppStore.getState().sessionFileBrowserId).toBe(sessionId);
      const listCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "session_list_files");
      expect(listCalls.length).toBeGreaterThan(0);
      expect(
        listCalls.every(([, args]) => (args as { sessionId: string }).sessionId === sessionId)
      ).toBe(true);
      expect(container.textContent).toContain("app.log");
      expect(container.textContent).toContain("data");
    }
  );

  it("says to update the agent when the remote agent is too old to browse the session", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "session_list_files") {
        return Promise.reject({
          code: "agent_outdated",
          message:
            "Remote agent error: Operation failed: the remote agent is too old to browse files in this session; update the agent",
        });
      }
      return Promise.resolve(undefined);
    });
    seedAgentSession("docker", "docker-on-old-agent");

    await renderBrowser();

    expect(currentFileBrowsersView().mode).toBe("session");
    const text = container.textContent ?? "";
    expect(text).toContain("too old to browse its files");
    expect(text).toContain("Update the agent");
    expect(text).not.toContain("thub-code");
    expect(text).not.toContain("Operation failed");
  });

  it("keeps any other listing error's own message", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "session_list_files") {
        return Promise.reject({ code: "remote_error", message: "Permission denied: /root" });
      }
      return Promise.resolve(undefined);
    });
    seedAgentSession("ssh", "ssh-on-agent");

    await renderBrowser();

    expect(container.textContent).toContain("Permission denied: /root");
    expect(container.textContent).not.toContain("Update the agent");
  });

  it("downloads a folder in a multi-select Download by its files, never as one file (#3944)", async () => {
    const sessionId = "docker-on-agent";
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "session_list_files") {
        const { path } = args as { path: string };
        return Promise.resolve(
          path === "/srv/data"
            ? [{ ...entry("inner.txt"), path: "/srv/data/inner.txt" }]
            : [entry("app.log"), entry("data", true)]
        );
      }
      return Promise.resolve(undefined);
    });
    seedAgentSession("docker", sessionId);
    await renderBrowser();

    const row = (name: string) =>
      container.querySelector(`[data-testid="file-row-${name}"]`) as HTMLElement;
    await act(async () => {
      row("app.log").click();
    });
    await act(async () => {
      row("data").dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    await act(async () => {
      row("data").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await act(async () => {
      (document.querySelector('[data-testid="multi-select-download"]') as HTMLElement).click();
    });
    await flushAsync();
    await flushAsync();
    await flushAsync();

    const downloads = () =>
      mockedInvoke.mock.calls
        .filter(([cmd]) => cmd === "session_download_to_local_file")
        .map(([, args]) => args as { remotePath: string; localPath: string });
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    // Folders list first; the folder itself is never copied as one file.
    await vi.waitFor(() =>
      expect(
        downloads()
          .map((d) => `${d.remotePath} -> ${d.localPath}`)
          .sort()
      ).toEqual([
        "/srv/app.log -> /local/app.log",
        "/srv/data/inner.txt -> /local/target/data/inner.txt",
      ])
    );
  });
});
