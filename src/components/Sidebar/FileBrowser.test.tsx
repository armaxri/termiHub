import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { FileBrowser, FileMenuItems, MultiSelectMenuItems } from "./FileBrowser";
import type { TerminalTab, LeafPanel } from "@/types/terminal";
import type { FileEntry } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/events", () => ({
  onVscodeEditComplete: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    getHomeDir: vi.fn(() => Promise.resolve("C:\\Users\\test")),
  };
});

const mockedInvoke = vi.mocked(invoke);

/** Flush pending microtasks (Promise callbacks) inside act(). */
async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

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

    // Mock local_list_dir to return empty entries so navigateLocal doesn't throw.
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

  // --- Mode selection ---

  it("sets fileBrowserMode to 'local' for a WSL tab", () => {
    const wslTab = makeTab({
      connectionType: "wsl",
      config: { type: "wsl", config: { distribution: "Ubuntu" } },
    });
    setActiveTab(wslTab);

    act(() => {
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
    });
    await flushAsync();

    expect(useAppStore.getState().localCurrentPath).toBe("C:/Users/richtera");
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
      root.render(<FileBrowser />);
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
          },
        ],
        operation: "copy",
        sourceMode: "local",
        sourcePath: "/home",
        sftpSessionId: null,
      },
    });

    await act(async () => {
      root.render(<FileBrowser />);
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
  };
  const dirEntry: FileEntry = {
    name: "projects",
    path: "/home/user/projects",
    isDirectory: true,
    size: 0,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
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
    },
    {
      name: "beta.txt",
      path: "/home/beta.txt",
      isDirectory: false,
      size: 20,
      modified: "",
      permissions: null,
    },
    {
      name: "gamma.txt",
      path: "/home/gamma.txt",
      isDirectory: false,
      size: 30,
      modified: "",
      permissions: null,
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
      root.render(<FileBrowser />);
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
