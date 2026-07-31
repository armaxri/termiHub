import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { flushAsync } from "@/test/flushAsync";
import { FileBrowser, FileMenuItems, MultiSelectMenuItems } from "./FileBrowser";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import { DEFAULT_AGENT_SETTINGS, type FileEntry } from "@/types/connection";

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
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getHomeDir: vi.fn(() => Promise.resolve("C:\\Users\\test")),
  };
});

const mockedInvoke = vi.mocked(invoke);

let container: HTMLDivElement;
let root: Root;

/** Create a minimal TerminalTab for testing. */
function makeTab(overrides: Partial<TerminalTab>): TerminalTab {
  return {
    id: "tab-1",
    sessionId: "sess-1",
    title: "Test Tab",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "panel-1",
    isActive: true,
    ...overrides,
  };
}

/** Set up the store so `getActiveTab` returns the given tab. */
function setActiveTab(tab: TerminalTab) {
  const panel: LeafPanel = {
    type: "leaf",
    id: tab.panelId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  useAppStore.setState({
    activePanelId: tab.panelId,
    rootPanel: panel,
  });
}

describe("FileBrowser – useFileBrowserSync", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    // Mock file listing commands to return empty entries so navigation doesn't throw.
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      if (cmd === "session_list_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  // --- Mode selection ---

  it("sets fileBrowserMode to 'local' for a WSL tab", () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Ubuntu" } },
    });
    setActiveTab(wslTab);

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("sets fileBrowserMode to 'local' for a local tab with WSL shell type", () => {
    const localWslTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "wsl:Ubuntu" } },
    });
    setActiveTab(localWslTab);

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("sets fileBrowserMode to 'local' for a plain local tab", () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("does not set fileBrowserMode to 'sftp' for a WSL tab even when capability claims true", () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Debian" } },
    });
    setActiveTab(wslTab);
    useAppStore.setState({
      connectionTypes: [
        {
          typeId: "wsl",
          displayName: "WSL",
          icon: "penguin",
          schema: { groups: [] },
          capabilities: {
            monitoring: false,
            fileBrowser: true,
            resize: true,
            persistent: true,
          },
        },
      ],
    });

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("sets fileBrowserMode to 'none' for a settings tab", () => {
    const settingsTab = makeTab({
      contentType: "settings",
      config: { type: "local", config: {} },
    });
    setActiveTab(settingsTab);

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  it("sets fileBrowserMode to 'none' for unsupported connection types", () => {
    const telnetTab = makeTab({
      connectionType: "telnet",
      config: { type: "telnet", config: { host: "example.com" } },
    });
    setActiveTab(telnetTab);

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  // --- Protocol-agnostic (session-layer) browsing for non-SSH types (#1335) ---

  /** Register a desktop connection type that advertises the file-browser capability. */
  function setFileBrowserCapableType(typeId: string, displayName: string) {
    useAppStore.setState({
      connectionTypes: [
        {
          typeId,
          displayName,
          icon: "folder",
          schema: { groups: [] },
          capabilities: {
            monitoring: false,
            fileBrowser: true,
            resize: false,
            persistent: false,
          },
        },
      ],
    });
  }

  it("sets fileBrowserMode to 'session' for an FTP tab and targets the tab's session", () => {
    const ftpTab = makeTab({
      connectionType: "ftp",
      sessionId: "ftp-sess-1",
      config: { type: "ftp", config: { host: "ftp.example.com", port: 21 } },
    });
    setActiveTab(ftpTab);
    setFileBrowserCapableType("ftp", "FTP");

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    // FTP must browse through the shared session layer, not the SSH-only
    // SftpManager path — an `sftp_open` with an FTP config could never connect.
    expect(useAppStore.getState().fileBrowserMode).toBe("session");
    expect(useAppStore.getState().sessionFileBrowserId).toBe("ftp-sess-1");
  });

  it("keeps fileBrowserMode on 'sftp' for an SSH tab (legacy SftpManager path)", async () => {
    // 'sftp' mode auto-connects an SFTP session, so the SFTP command surface
    // has to answer for real here rather than resolving undefined.
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sftp_open") return Promise.resolve("sftp-sess-1");
      if (cmd === "sftp_realpath") return Promise.resolve("/root");
      if (cmd === "sftp_list_dir") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const sshTab = makeTab({
      connectionType: "ssh",
      sessionId: "ssh-sess-1",
      config: { type: "ssh", config: { host: "example.com", port: 22, username: "root" } },
    });
    setActiveTab(sshTab);
    setFileBrowserCapableType("ssh", "SSH");

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().fileBrowserMode).toBe("sftp");
  });

  it("sets fileBrowserMode to 'none' for an FTP tab that has no session yet", () => {
    const ftpTab = makeTab({
      connectionType: "ftp",
      sessionId: null,
      config: { type: "ftp", config: { host: "ftp.example.com", port: 21 } },
    });
    setActiveTab(ftpTab);
    setFileBrowserCapableType("ftp", "FTP");

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  it("sets fileBrowserMode to 'none' for an FTP tab when the file browser is disabled", () => {
    const ftpTab = makeTab({
      connectionType: "ftp",
      sessionId: "ftp-sess-1",
      config: { type: "ftp", config: { host: "ftp.example.com", port: 21 } },
    });
    setActiveTab(ftpTab);
    setFileBrowserCapableType("ftp", "FTP");
    useAppStore.setState((s) => ({
      settings: { ...s.settings, fileBrowserEnabled: false },
    }));

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  it("sets fileBrowserMode to 'session' for a Docker tab (shared session layer)", () => {
    const dockerTab = makeTab({
      connectionType: "docker",
      sessionId: "docker-sess-1",
      config: { type: "docker", config: { container: "web" } },
    });
    setActiveTab(dockerTab);
    setFileBrowserCapableType("docker", "Docker");

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("session");
    expect(useAppStore.getState().sessionFileBrowserId).toBe("docker-sess-1");
  });

  it("sets fileBrowserMode to 'session' for remote-session tab when agent supports file browser", () => {
    const remoteTab = makeTab({
      connectionType: "remote-session",
      sessionId: "terminal-sess-1",
      config: {
        type: "remote-session",
        config: { agentId: "agent-1", sessionType: "local" },
      },
    });
    setActiveTab(remoteTab);
    useAppStore.setState({
      remoteAgents: [
        {
          id: "agent-1",
          name: "Test Agent",
          config: { host: "example.com", port: 22, username: "user", authMethod: "key" },
          connectionState: "connected",
          isExpanded: false,
          capabilities: {
            connectionTypes: [
              {
                typeId: "local",
                displayName: "Local Shell",
                icon: "terminal",
                schema: { groups: [] },
                capabilities: {
                  monitoring: false,
                  fileBrowser: true,
                  resize: true,
                  persistent: false,
                },
              },
            ],
            maxSessions: 10,
            availableShells: ["/bin/bash"],
            availableSerialPorts: [],
            dockerAvailable: false,
            availableDockerImages: [],
          },
          agentSettings: DEFAULT_AGENT_SETTINGS,
        },
      ],
    });

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("session");
    expect(useAppStore.getState().sessionFileBrowserId).toBe("terminal-sess-1");
  });

  it("sets fileBrowserMode to 'none' for remote-session tab when agent does not support file browser", () => {
    const remoteTab = makeTab({
      connectionType: "remote-session",
      sessionId: "terminal-sess-2",
      config: {
        type: "remote-session",
        config: { agentId: "agent-2", sessionType: "serial" },
      },
    });
    setActiveTab(remoteTab);
    useAppStore.setState({
      remoteAgents: [
        {
          id: "agent-2",
          name: "Test Agent 2",
          config: { host: "example.com", port: 22, username: "user", authMethod: "key" },
          connectionState: "connected",
          isExpanded: false,
          capabilities: {
            connectionTypes: [
              {
                typeId: "serial",
                displayName: "Serial",
                icon: "serial",
                schema: { groups: [] },
                capabilities: {
                  monitoring: false,
                  fileBrowser: false,
                  resize: false,
                  persistent: false,
                },
              },
            ],
            maxSessions: 10,
            availableShells: [],
            availableSerialPorts: ["/dev/ttyUSB0"],
            dockerAvailable: false,
            availableDockerImages: [],
          },
          agentSettings: DEFAULT_AGENT_SETTINGS,
        },
      ],
    });

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  it("sets fileBrowserMode to 'none' for remote-session tab when no agent found", () => {
    const remoteTab = makeTab({
      connectionType: "remote-session",
      sessionId: "terminal-sess-3",
      config: {
        type: "remote-session",
        config: { agentId: "nonexistent-agent", sessionType: "local" },
      },
    });
    setActiveTab(remoteTab);
    useAppStore.setState({ remoteAgents: [] });

    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });

    expect(useAppStore.getState().fileBrowserMode).toBe("none");
  });

  // --- Navigation path conversion ---

  it("navigates to WSL UNC root when WSL tab has no CWD", async () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "FedoraLinux-43" } },
    });
    setActiveTab(wslTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("//wsl$/FedoraLinux-43/");
  });

  it("converts WSL /mnt/c CWD to Windows drive path for file browser", async () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Ubuntu" } },
    });
    setActiveTab(wslTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "/mnt/c/Users/richtera" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users/richtera");
  });

  it("converts native WSL Linux path to UNC path for file browser", async () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Ubuntu" } },
    });
    setActiveTab(wslTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "/home/user/projects" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("//wsl$/Ubuntu/home/user/projects");
  });

  it("converts CWD for local tab with WSL shell type", async () => {
    const localWslTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "wsl:Debian" } },
    });
    setActiveTab(localWslTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "/mnt/d/work" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("D:/work");
  });

  it("does not apply WSL path conversion for plain local tabs", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "C:/Users/richtera" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users/richtera");
  });

  // Regression test for #555: PowerShell reports CWD via OSC 9;9 with backslashes.
  // navigateLocal must normalize them so navigateUp and path display work correctly.
  it("normalizes Windows backslash CWD to forward slashes for local tab (#555)", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "C:\\Users\\testuser" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users/testuser");
  });
});

/** Simple wrapper that renders items as plain divs (bypassing Radix portal issues in JSDOM). */
function SimpleItem({
  children,
  onSelect,
  ...rest
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  [key: string]: unknown;
}) {
  return (
    <div role="menuitem" onClick={onSelect} {...rest}>
      {children}
    </div>
  );
}
function SimpleSeparator(props: Record<string, unknown>) {
  return <hr {...props} />;
}

describe("FileBrowser – Copy/Cut/Paste UI", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir")
        return Promise.resolve([
          { name: "test.txt", path: "/home/test.txt", isDirectory: false, size: 10 },
          { name: "mydir", path: "/home/mydir", isDirectory: true, size: 0 },
        ]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders paste button in toolbar when in local mode", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const pasteBtn = container.querySelector('[data-testid="file-browser-paste"]');
    expect(pasteBtn).toBeTruthy();
    expect((pasteBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables paste button when clipboard has content", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      fileClipboard: {
        entries: [
          {
            name: "copied.txt",
            path: "/home/copied.txt",
            isDirectory: false,
            size: 5,
            modified: "",
            permissions: null,
            writable: null,
          },
        ],
        operation: "copy",
        sourceMode: "local",
        sourcePath: "/home",
        sftpSessionId: null,
      },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const pasteBtn = container.querySelector('[data-testid="file-browser-paste"]');
    expect(pasteBtn).toBeTruthy();
    expect((pasteBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("sets clipboard state via store setFileClipboard for copy", () => {
    const entry: FileEntry = {
      name: "test.txt",
      path: "/home/test.txt",
      isDirectory: false,
      size: 10,
      modified: "",
      permissions: null,
      writable: null,
    };
    useAppStore.getState().setFileClipboard({
      entries: [entry],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    });

    const clipboard = useAppStore.getState().fileClipboard;
    expect(clipboard).not.toBeNull();
    expect(clipboard?.entries[0].name).toBe("test.txt");
    expect(clipboard?.operation).toBe("copy");
    expect(clipboard?.sourceMode).toBe("local");
  });

  it("sets clipboard state via store setFileClipboard for cut", () => {
    const entry: FileEntry = {
      name: "mydir",
      path: "/home/mydir",
      isDirectory: true,
      size: 0,
      modified: "",
      permissions: null,
      writable: null,
    };
    useAppStore.getState().setFileClipboard({
      entries: [entry],
      operation: "cut",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    });

    const clipboard = useAppStore.getState().fileClipboard;
    expect(clipboard).not.toBeNull();
    expect(clipboard?.entries[0].name).toBe("mydir");
    expect(clipboard?.operation).toBe("cut");
    expect(clipboard?.sourceMode).toBe("local");
  });

  it("clears clipboard when setFileClipboard is called with null", () => {
    const entry: FileEntry = {
      name: "test.txt",
      path: "/home/test.txt",
      isDirectory: false,
      size: 10,
      modified: "",
      permissions: null,
      writable: null,
    };
    useAppStore.getState().setFileClipboard({
      entries: [entry],
      operation: "copy",
      sourceMode: "local",
      sourcePath: "/home",
      sftpSessionId: null,
    });
    expect(useAppStore.getState().fileClipboard).not.toBeNull();

    useAppStore.getState().setFileClipboard(null);
    expect(useAppStore.getState().fileClipboard).toBeNull();
  });
});

describe("FileBrowser – Copy Name / Copy Path", () => {
  const fileEntry: FileEntry = {
    name: "notes.txt",
    path: "/home/user/notes.txt",
    isDirectory: false,
    size: 42,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
    writable: null,
  };
  const dirEntry: FileEntry = {
    name: "projects",
    path: "/home/user/projects",
    isDirectory: true,
    size: 0,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
    writable: null,
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows Copy Name and Copy Path items for a file", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={fileEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    expect(container.querySelector('[data-testid="file-menu-copy-name"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-menu-copy-path"]')).toBeTruthy();
  });

  it("shows Copy Name and Copy Path items for a directory", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={dirEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    expect(container.querySelector('[data-testid="file-menu-copy-name"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-menu-copy-path"]')).toBeTruthy();
  });

  it("triggers copyName action when Copy Name is clicked", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={fileEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    const item = container.querySelector('[data-testid="file-menu-copy-name"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(onAction).toHaveBeenCalledWith(fileEntry, "copyName");
  });

  it("triggers copyPath action when Copy Path is clicked", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={fileEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    const item = container.querySelector('[data-testid="file-menu-copy-path"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(onAction).toHaveBeenCalledWith(fileEntry, "copyPath");
  });

  it("triggers copyName action for a directory", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={dirEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    const item = container.querySelector('[data-testid="file-menu-copy-name"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(onAction).toHaveBeenCalledWith(dirEntry, "copyName");
  });

  it("triggers copyPath action for a directory", () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <FileMenuItems
          entry={dirEntry}
          vscodeAvailable={false}
          onNavigate={vi.fn()}
          onContextAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
          testIdPrefix="file-menu"
        />
      );
    });

    const item = container.querySelector('[data-testid="file-menu-copy-path"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(onAction).toHaveBeenCalledWith(dirEntry, "copyPath");
  });
});

describe("FileBrowser – Multi-file selection", () => {
  const entries: FileEntry[] = [
    {
      name: "alpha.txt",
      path: "/home/alpha.txt",
      isDirectory: false,
      size: 10,
      modified: "",
      permissions: null,
      writable: null,
    },
    {
      name: "beta.txt",
      path: "/home/beta.txt",
      isDirectory: false,
      size: 20,
      modified: "",
      permissions: null,
      writable: null,
    },
    {
      name: "gamma.txt",
      path: "/home/gamma.txt",
      isDirectory: false,
      size: 30,
      modified: "",
      permissions: null,
      writable: null,
    },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(entries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("selects a single file on plain click", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const row = container.querySelector('[data-testid="file-row-alpha.txt"]') as HTMLElement;
    act(() => {
      row.click();
    });

    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(1);
  });

  it("adds to selection on Ctrl+click", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const alpha = container.querySelector('[data-testid="file-row-alpha.txt"]') as HTMLElement;
    const beta = container.querySelector('[data-testid="file-row-beta.txt"]') as HTMLElement;

    act(() => {
      alpha.click();
    });
    act(() => {
      beta.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(2);
  });

  it("deselects an already-selected file on Ctrl+click", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const alpha = container.querySelector('[data-testid="file-row-alpha.txt"]') as HTMLElement;

    act(() => {
      alpha.click();
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(1);

    act(() => {
      alpha.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(0);
  });

  it("selects a range on Shift+click", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const alpha = container.querySelector('[data-testid="file-row-alpha.txt"]') as HTMLElement;
    const gamma = container.querySelector('[data-testid="file-row-gamma.txt"]') as HTMLElement;

    act(() => {
      alpha.click();
    });
    act(() => {
      gamma.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    });

    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(3);
  });

  it("replaces selection on plain click after multi-select", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const alpha = container.querySelector('[data-testid="file-row-alpha.txt"]') as HTMLElement;
    const beta = container.querySelector('[data-testid="file-row-beta.txt"]') as HTMLElement;
    const gamma = container.querySelector('[data-testid="file-row-gamma.txt"]') as HTMLElement;

    // Select alpha and beta
    act(() => {
      alpha.click();
    });
    act(() => {
      beta.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(2);

    // Plain click on gamma — should replace selection
    act(() => {
      gamma.click();
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(1);
    expect(
      container
        .querySelector('[data-testid="file-row-gamma.txt"]')
        ?.closest(".file-browser__row-wrapper")
        ?.classList.contains("file-browser__row-wrapper--selected")
    ).toBe(true);
  });
});

describe("FileBrowser – MultiSelectMenuItems", () => {
  let localContainer: HTMLDivElement;
  let localRoot: Root;

  beforeEach(() => {
    localContainer = document.createElement("div");
    document.body.appendChild(localContainer);
    localRoot = createRoot(localContainer);
  });

  afterEach(() => {
    act(() => {
      localRoot.unmount();
    });
    localContainer.remove();
  });

  it("shows correct item count label", () => {
    act(() => {
      localRoot.render(
        <MultiSelectMenuItems
          count={3}
          onAction={vi.fn()}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
        />
      );
    });

    expect(
      localContainer.querySelector('[data-testid="multi-select-copy"]')?.textContent
    ).toContain("3");
    expect(
      localContainer.querySelector('[data-testid="multi-select-delete"]')?.textContent
    ).toContain("3");
  });

  it("calls onAction with 'delete' when Delete is clicked", () => {
    const onAction = vi.fn();
    act(() => {
      localRoot.render(
        <MultiSelectMenuItems
          count={2}
          onAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
        />
      );
    });

    act(() => {
      (localContainer.querySelector('[data-testid="multi-select-delete"]') as HTMLElement).click();
    });

    expect(onAction).toHaveBeenCalledWith("delete");
  });

  it("calls onAction with 'copy' when Copy is clicked", () => {
    const onAction = vi.fn();
    act(() => {
      localRoot.render(
        <MultiSelectMenuItems
          count={2}
          onAction={onAction}
          onPaste={vi.fn()}
          hasClipboard={false}
          Item={SimpleItem}
          Separator={SimpleSeparator}
        />
      );
    });

    act(() => {
      (localContainer.querySelector('[data-testid="multi-select-copy"]') as HTMLElement).click();
    });

    expect(onAction).toHaveBeenCalledWith("copy");
  });
});

// Regression tests for #555: Windows navigate-up and Up button disable state.
describe("FileBrowser – Windows navigate-up (#555)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("navigateLocal normalizes backslash path and Up button navigates to parent", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "C:\\Users\\testuser" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    // Path should be normalized
    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users/testuser");

    // Click the Up button — should navigate to "C:/Users"
    const upBtn = container.querySelector('[data-testid="file-browser-up"]') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(false);

    await act(async () => {
      upBtn.click();
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users");
  });

  it("Up button is disabled at Windows drive root (C:/)", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);
    // Drive CWD through tabCwds so the sync hook navigates there (not to getHomeDir)
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "C:/" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/");
    const upBtn = container.querySelector('[data-testid="file-browser-up"]') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it("navigating up from C:/Users stops at drive root C:/", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: { shell: "powershell" } },
    });
    setActiveTab(localTab);
    // Drive CWD through tabCwds so the sync hook navigates there (not to getHomeDir)
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "C:/Users" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const upBtn = container.querySelector('[data-testid="file-browser-up"]') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(false);

    await act(async () => {
      upBtn.click();
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/");
  });
});

describe("FileBrowser – session mode initial path (#630)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "session_list_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("navigates to ~ when entering session mode with no CWD", async () => {
    useAppStore.setState({
      fileBrowserMode: "session",
      sessionFileBrowserId: "sess-remote",
      sessionFileEntries: [],
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "session_list_files");
    expect(calls.length).toBeGreaterThan(0);
    const [, args] = calls[0] as [string, { sessionId: string; path: string }];
    expect(args.path).toBe("~");
  });
});

describe("FileBrowser – Go to Terminal CWD button", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("button is disabled when no CWD is available", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files" });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const btn = container.querySelector(
      '[data-testid="file-browser-go-to-cwd"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("button is enabled when a CWD is available", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "/home/user/projects" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const btn = container.querySelector(
      '[data-testid="file-browser-go-to-cwd"]'
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("clicking the button navigates to the terminal CWD", async () => {
    const localTab = makeTab({
      connectionType: "local",
      config: { type: "local", config: {} },
    });
    setActiveTab(localTab);
    useAppStore.setState({
      sidebarView: "files",
      tabCwds: { "tab-1": "/home/user/projects" },
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    // Manually navigate away
    await act(async () => {
      useAppStore.getState().navigateLocal("/home/user");
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/home/user");

    // Click the Go to CWD button
    const btn = container.querySelector(
      '[data-testid="file-browser-go-to-cwd"]'
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("/home/user/projects");
  });

  it("does not disconnect the existing SFTP session when an editor tab with isRemote is activated", async () => {
    // Simulate: user had an SSH terminal → SFTP auto-connected → user opened a
    // remote file → editor tab is now active.  The auto-connect effect must NOT
    // call disconnectSftp() because the editor tab carries a dummy local config.
    const editorTab = makeTab({
      contentType: "editor",
      connectionType: "local",
      config: { type: "local", config: { shell: "zsh" } },
      editorMeta: { filePath: "/remote/file.txt", isRemote: true, sftpSessionId: "session-xyz" },
    });
    setActiveTab(editorTab);

    // Pre-seed the store as if an SFTP session was already established.
    useAppStore.setState({
      sftpSessionId: "session-xyz",
      sftpConnectedHost: "user@host:22",
    });

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    // The SFTP session must still be alive — not disconnected by the auto-connect effect.
    expect(useAppStore.getState().sftpSessionId).toBe("session-xyz");
  });
});

describe("FileBrowser – failed-connect recovery UI (S1)", () => {
  /** An SSH connection type that supports the file browser (→ sftp mode). */
  function seedSshCapability() {
    useAppStore.setState({
      sidebarView: "files",
      connectionTypes: [
        {
          typeId: "ssh",
          displayName: "SSH",
          icon: "terminal",
          schema: { groups: [] },
          capabilities: {
            monitoring: false,
            fileBrowser: true,
            resize: true,
            persistent: false,
          },
        },
      ],
    });
  }

  function makeSshTab() {
    return makeTab({
      connectionType: "ssh",
      config: {
        type: "ssh",
        config: {
          host: "example.com",
          port: 22,
          username: "alice",
          authMethod: "password",
          password: "pw",
        },
      },
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("shows Retry + Dismiss controls when the SFTP connect fails", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sftp_open") return Promise.reject(new Error("auth failed"));
      return Promise.resolve(undefined);
    });
    seedSshCapability();
    setActiveTab(makeSshTab());

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    expect(useAppStore.getState().sftpError).toBe("auth failed");
    const retryBtn = container.querySelector('[data-testid="file-browser-sftp-retry"]');
    const dismissBtn = container.querySelector('[data-testid="file-browser-sftp-dismiss"]');
    expect(retryBtn).toBeTruthy();
    expect(dismissBtn).toBeTruthy();
  });

  it("Retry re-invokes the SFTP connect", async () => {
    let openCalls = 0;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sftp_open") {
        openCalls += 1;
        return Promise.reject(new Error("auth failed"));
      }
      return Promise.resolve(undefined);
    });
    seedSshCapability();
    setActiveTab(makeSshTab());

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const callsAfterAutoConnect = openCalls;
    expect(callsAfterAutoConnect).toBeGreaterThanOrEqual(1);

    const retryBtn = container.querySelector(
      '[data-testid="file-browser-sftp-retry"]'
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
    });
    await flushAsync();

    expect(openCalls).toBeGreaterThan(callsAfterAutoConnect);
  });

  it("Dismiss clears the error", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sftp_open") return Promise.reject(new Error("auth failed"));
      return Promise.resolve(undefined);
    });
    seedSshCapability();
    setActiveTab(makeSshTab());

    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();

    const dismissBtn = container.querySelector(
      '[data-testid="file-browser-sftp-dismiss"]'
    ) as HTMLButtonElement;
    await act(async () => {
      dismissBtn.click();
    });
    await flushAsync();

    expect(useAppStore.getState().sftpError).toBeNull();
  });
});

describe("FileBrowser – navigation UX (#1361)", () => {
  const navEntries = [
    {
      name: "adir",
      path: "/home/adir",
      isDirectory: true,
      size: 0,
      modified: "2026-01-05T00:00:00Z",
    },
    {
      name: "bdir",
      path: "/home/bdir",
      isDirectory: true,
      size: 0,
      modified: "2026-01-04T00:00:00Z",
    },
    {
      name: "big.log",
      path: "/home/big.log",
      isDirectory: false,
      size: 900,
      modified: "2026-01-01T00:00:00Z",
    },
    {
      name: "small.txt",
      path: "/home/small.txt",
      isDirectory: false,
      size: 5,
      modified: "2026-01-02T00:00:00Z",
    },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(navEntries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  /** Set a controlled input's value the way React expects (native setter + input event). */
  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function renderLocalAt(path: string) {
    const localTab = makeTab({ connectionType: "local", config: { type: "local", config: {} } });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": path } });
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  it("renders a clickable breadcrumb for the current path", async () => {
    await renderLocalAt("/home");
    const crumbs = container.querySelectorAll('[data-testid="file-browser-crumb"]');
    const labels = Array.from(crumbs).map((c) => c.textContent);
    expect(labels).toEqual(["/", "home"]);
  });

  it("navigates when a breadcrumb segment is clicked", async () => {
    await renderLocalAt("/home");
    const rootCrumb = container.querySelectorAll(
      '[data-testid="file-browser-crumb"]'
    )[0] as HTMLElement;
    await act(async () => {
      rootCrumb.click();
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/");
  });

  it("reveals a path input prefilled with the current path when edit is clicked", async () => {
    await renderLocalAt("/home");
    const editBtn = container.querySelector(
      '[data-testid="file-browser-path-edit"]'
    ) as HTMLElement;
    await act(async () => {
      editBtn.click();
    });
    const input = container.querySelector(
      '[data-testid="file-browser-path-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("/home");
  });

  it("navigates to a typed path on Enter", async () => {
    await renderLocalAt("/home");
    const editBtn = container.querySelector(
      '[data-testid="file-browser-path-edit"]'
    ) as HTMLElement;
    await act(async () => {
      editBtn.click();
    });
    const input = container.querySelector(
      '[data-testid="file-browser-path-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "/var/log");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/var/log");
  });

  it("cancels path editing on Escape without navigating", async () => {
    await renderLocalAt("/home");
    const editBtn = container.querySelector(
      '[data-testid="file-browser-path-edit"]'
    ) as HTMLElement;
    await act(async () => {
      editBtn.click();
    });
    const input = container.querySelector(
      '[data-testid="file-browser-path-input"]'
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "/should/not/apply");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushAsync();
    expect(container.querySelector('[data-testid="file-browser-path-input"]')).toBeNull();
    expect(useAppStore.getState().localCurrentPath).toBe("/home");
  });

  it("filters the list by name", async () => {
    await renderLocalAt("/home");
    const filter = container.querySelector(
      '[data-testid="file-browser-filter"]'
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(filter, "dir");
    });
    await flushAsync();
    expect(container.querySelector('[data-testid="file-row-adir"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-row-bdir"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="file-row-small.txt"]')).toBeNull();
  });

  it("opens the focused directory with ArrowDown + Enter", async () => {
    await renderLocalAt("/home");
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    // active starts at index 0 (adir); ArrowDown → bdir; Enter opens it.
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/home/bdir");
  });

  it("navigates up a level on Backspace", async () => {
    await renderLocalAt("/home/adir");
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/home");
  });

  it("selects all entries with Ctrl+A", async () => {
    await renderLocalAt("/home");
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(
      navEntries.length
    );
  });

  it("shows an 'N selected' indicator when multiple rows are selected", async () => {
    await renderLocalAt("/home");
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    const indicator = container.querySelector('[data-testid="file-browser-selected-count"]');
    expect(indicator?.textContent).toContain(String(navEntries.length));
  });

  it("clears the selection on Escape", async () => {
    await renderLocalAt("/home");
    const list = container.querySelector('[data-testid="file-browser-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    expect(
      container.querySelectorAll(".file-browser__row-wrapper--selected").length
    ).toBeGreaterThan(0);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelectorAll(".file-browser__row-wrapper--selected").length).toBe(0);
  });

  it("shows a persistent 'Drop files here' hint in local mode", async () => {
    await renderLocalAt("/home");
    expect(container.querySelector('[data-testid="file-browser-drop-hint"]')).toBeTruthy();
  });

  it("sorts files by size when the size column header is clicked", async () => {
    await renderLocalAt("/home");
    const sizeHeader = container.querySelector(
      '[data-testid="file-browser-sort-size"]'
    ) as HTMLElement;
    await act(async () => {
      sizeHeader.click();
    });
    const rows = Array.from(
      container.querySelectorAll('[data-testid^="file-row-"]:not([data-testid^="file-row-menu-"])')
    ).map((r) => r.getAttribute("data-testid"));
    // Directories always first; files sorted by size ascending: small.txt (5) before big.log (900).
    expect(rows).toEqual([
      "file-row-adir",
      "file-row-bdir",
      "file-row-small.txt",
      "file-row-big.log",
    ]);
  });

  it("renders a modified-time column for file rows", async () => {
    await renderLocalAt("/home");
    const modifiedCells = container.querySelectorAll(".file-browser__modified");
    expect(modifiedCells.length).toBeGreaterThan(0);
  });
});

describe("FileBrowser – symlinks (#1513)", () => {
  const symlinkEntries: FileEntry[] = [
    {
      name: "mylink",
      path: "/home/mylink",
      isDirectory: false,
      size: 7,
      modified: "2026-01-05T00:00:00Z",
      permissions: "rwxrwxrwx",
      writable: true,
      isSymlink: true,
      symlinkTarget: "/etc/target",
    },
    {
      name: "plain.txt",
      path: "/home/plain.txt",
      isDirectory: false,
      size: 5,
      modified: "2026-01-02T00:00:00Z",
      permissions: "rw-r--r--",
      writable: true,
      isSymlink: false,
      symlinkTarget: null,
    },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve(symlinkEntries);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAt(path: string) {
    const localTab = makeTab({ connectionType: "local", config: { type: "local", config: {} } });
    setActiveTab(localTab);
    useAppStore.setState({ sidebarView: "files", tabCwds: { "tab-1": path } });
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  it("renders a distinct symlink icon only on the link row", async () => {
    await renderAt("/home");
    const linkRow = container.querySelector('[data-testid="file-row-mylink"]');
    const plainRow = container.querySelector('[data-testid="file-row-plain.txt"]');
    expect(linkRow?.querySelector(".file-browser__icon--symlink")).toBeTruthy();
    expect(plainRow?.querySelector(".file-browser__icon--symlink")).toBeNull();
  });

  it("shows the link target in the row", async () => {
    await renderAt("/home");
    const target = container.querySelector(".file-browser__symlink-target");
    expect(target?.textContent).toContain("/etc/target");
    expect(target?.getAttribute("title")).toContain("/etc/target");
  });

  it("follows the symlink to its resolved target on double-click", async () => {
    await renderAt("/home");
    const linkRow = container.querySelector('[data-testid="file-row-mylink"]') as HTMLButtonElement;
    await act(async () => {
      linkRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await flushAsync();
    expect(useAppStore.getState().localCurrentPath).toBe("/etc/target");
  });
});

// --- Editor tabs backed by the session layer (#1557) ---
describe("FileBrowser – session-layer editor tabs (#1557)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_list_dir") return Promise.resolve([]);
      if (cmd === "session_list_files") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderBrowser() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <FileBrowser />
        </TooltipProvider>
      );
    });
  }

  /** An editor tab carries a dummy local config; only its editorMeta matters here. */
  function makeEditorTab(editorMeta: TerminalTab["editorMeta"]): TerminalTab {
    return makeTab({
      id: "tab-editor-1",
      connectionType: "local",
      contentType: "editor",
      config: { type: "local", config: {} },
      editorMeta,
    });
  }

  it("puts a session-backed editor tab in 'session' mode, not 'sftp'", () => {
    setActiveTab(
      makeEditorTab({
        filePath: "/srv/app/config.yml",
        isRemote: true,
        sessionBrowser: { sessionId: "ftp-sess-1", connectionType: "ftp" },
      })
    );

    renderBrowser();

    // Falling into "sftp" here would point the browser at an SftpManager
    // session that does not exist for an FTP/Docker/agent-backed tab.
    expect(useAppStore.getState().fileBrowserMode).toBe("session");
    expect(useAppStore.getState().sessionFileBrowserId).toBe("ftp-sess-1");
  });

  it("keeps an SFTP-backed editor tab in 'sftp' mode", () => {
    setActiveTab(
      makeEditorTab({
        filePath: "/etc/hosts",
        isRemote: true,
        sftpSessionId: "sftp-sess-1",
      })
    );

    renderBrowser();

    expect(useAppStore.getState().fileBrowserMode).toBe("sftp");
  });

  it("keeps a local editor tab in 'local' mode", () => {
    setActiveTab(makeEditorTab({ filePath: "/home/me/notes.txt", isRemote: false }));

    renderBrowser();

    expect(useAppStore.getState().fileBrowserMode).toBe("local");
  });

  it("opens a session-backed editor tab when a file is activated in session mode", async () => {
    const ftpTab = makeTab({
      connectionType: "ftp",
      sessionId: "ftp-sess-1",
      config: { type: "ftp", config: { host: "ftp.example.com", port: 21 } },
    });
    setActiveTab(ftpTab);
    useAppStore.setState({
      connectionTypes: [
        {
          typeId: "ftp",
          displayName: "FTP",
          icon: "folder",
          schema: { groups: [] },
          capabilities: {
            monitoring: false,
            fileBrowser: true,
            resize: false,
            persistent: false,
          },
        },
      ],
    });

    renderBrowser();
    await flushAsync();
    expect(useAppStore.getState().fileBrowserMode).toBe("session");

    const entry: FileEntry = {
      name: "config.yml",
      path: "/srv/app/config.yml",
      isDirectory: false,
      size: 12,
      modified: "2026-07-17T00:00:00Z",
      permissions: "-rw-r--r--",
      writable: true,
    };
    act(() => {
      useAppStore.setState({ sessionFileEntries: [entry], sessionCurrentPath: "/srv/app" });
    });

    // Double-clicking a file is the same code path as the "Edit" context item.
    const row = container.querySelector('[data-testid="file-row-config.yml"]') as HTMLElement;
    expect(row).not.toBeNull();
    act(() => {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await flushAsync();

    const editorTab = (useAppStore.getState().rootPanel as LeafPanel).tabs.find(
      (t) => t.contentType === "editor"
    );
    expect(editorTab).toBeDefined();
    expect(editorTab?.editorMeta).toMatchObject({
      filePath: "/srv/app/config.yml",
      isRemote: true,
      permissions: "-rw-r--r--",
      sessionBrowser: { sessionId: "ftp-sess-1", connectionType: "ftp" },
    });
    // The session layer has no SftpManager session behind it.
    expect(editorTab?.editorMeta?.sftpSessionId).toBeUndefined();
  });
});
