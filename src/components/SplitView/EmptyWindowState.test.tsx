import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import { EmptyWindowState } from "./EmptyWindowState";

// Standard mocks required when importing useAppStore.
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

// The empty-window CTA branches on the live saved-connection count and the
// number of open native windows; drive both through configurable hook mocks so
// each test controls the first-run vs. returning-user and single- vs. multi-
// window cases without a real bridge or window registry.
let mockConnections: SavedConnection[] = [];
let mockWindowCount = 1;

vi.mock("@/store/useProjectedConnections", () => ({
  useProjectedConnections: () => ({ connections: mockConnections, folders: [] }),
}));

vi.mock("@/hooks/useWindowInfo", () => ({
  useWindowInfo: () => ({ label: "main", name: "Main Window", count: mockWindowCount }),
}));

const connectSpy = vi.fn((_c: SavedConnection) => Promise.resolve({ status: "connected" }));
vi.mock("@/utils/connectSavedConnection", () => ({
  connectSavedConnection: (c: SavedConnection) => connectSpy(c),
}));

/** A saved SSH connection to `admin@<host>`. */
function fakeConnection(id = "c1", host = "box"): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type: "ssh", config: { host, username: "admin" } },
  } as unknown as SavedConnection;
}

/** Click the button carrying the given test id. */
function clickTestId(container: HTMLElement, testid: string): void {
  const btn = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("EmptyWindowState (#1902, UX-003)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    connectSpy.mockClear();
    mockConnections = [];
    mockWindowCount = 1;
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const buttonLabels = () =>
    Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());

  it("renders the empty-window call-to-action", () => {
    act(() => root.render(<EmptyWindowState />));
    expect(q("empty-window-state")).not.toBeNull();
    expect(container.textContent).toContain("This window is empty");
    expect(q("empty-window-new-terminal")).not.toBeNull();
  });

  it("launches a local shell into this window via New terminal", () => {
    const addLocalShellTab = vi.fn();
    useAppStore.setState({ addLocalShellTab });
    act(() => root.render(<EmptyWindowState />));

    clickTestId(container, "empty-window-new-terminal");

    expect(addLocalShellTab).toHaveBeenCalledWith();
  });

  describe("fresh profile (no saved connections)", () => {
    it("offers New terminal, New connection and Restore from backup… (R-085)", () => {
      act(() => root.render(<EmptyWindowState />));
      expect(buttonLabels()).toEqual(["New terminal", "New connection", "Restore from backup…"]);
      expect(container.textContent).toContain("restore your data from a backup");
      expect(q("empty-window-recent")).toBeNull();
    });

    it("routes New connection to the new-connection editor", () => {
      const openConnectionEditorTab = vi.fn();
      useAppStore.setState({ openConnectionEditorTab });
      act(() => root.render(<EmptyWindowState />));

      clickTestId(container, "empty-window-new-connection");

      expect(openConnectionEditorTab).toHaveBeenCalledWith("new");
    });

    it("opens the restore dialog from Restore from backup…", () => {
      act(() => root.render(<EmptyWindowState />));
      expect(document.querySelector('[data-testid="backup-restore-title"]')).toBeNull();

      clickTestId(container, "empty-window-restore");

      expect(document.querySelector('[data-testid="backup-restore-title"]')).not.toBeNull();
    });
  });

  describe("with saved connections (R-087, R-107)", () => {
    it("shows the connections as one-click buttons, without Open connection… or New connection", () => {
      mockConnections = [fakeConnection("web"), fakeConnection("db", "db-host")];
      act(() => root.render(<EmptyWindowState />));

      expect(buttonLabels()).toEqual(["New terminal", "web", "db"]);
      expect(container.textContent).not.toContain("Open connection…");
      expect(q("empty-window-new-connection")).toBeNull();
      expect(q("empty-window-restore")).toBeNull();
      expect(container.textContent).toContain("open one of your connections");
      expect(q("empty-window-recent")!.getAttribute("role")).toBe("group");
    });

    it("connects a connection with one click, through the sidebar's connect flow", () => {
      const web = fakeConnection("web");
      mockConnections = [web];
      act(() => root.render(<EmptyWindowState />));

      clickTestId(container, "empty-window-recent-web");

      expect(connectSpy).toHaveBeenCalledWith(web);
    });

    it("lists the most recently opened first under 'Recent connections'", () => {
      mockConnections = [fakeConnection("web"), fakeConnection("db", "db-host")];
      useAppStore.setState({
        sessionHistory: [
          {
            dedupKey: "ssh:admin@db-host:22",
            title: "admin@db-host",
            connectionType: "ssh",
            config: { type: "ssh", config: {} },
            firstUsed: 1,
            lastUsed: 2,
            useCount: 1,
            pinned: false,
            promoted: false,
          },
        ] as never,
      });
      act(() => root.render(<EmptyWindowState />));

      expect(buttonLabels()).toEqual(["New terminal", "db", "web"]);
      expect(container.textContent).toContain("Recent connections");
    });

    it("says 'Your connections' when none was opened yet", () => {
      mockConnections = [fakeConnection("web")];
      act(() => root.render(<EmptyWindowState />));
      expect(container.textContent).toContain("Your connections");
      expect(container.textContent).not.toContain("Recent connections");
    });

    it("offers at most five connections", () => {
      mockConnections = Array.from({ length: 7 }, (_, i) => fakeConnection(`c${i}`, `h${i}`));
      act(() => root.render(<EmptyWindowState />));
      expect(q("empty-window-recent")!.querySelectorAll("button")).toHaveLength(5);
    });
  });

  it("does not show the multi-window hint for a single empty window", () => {
    act(() => root.render(<EmptyWindowState />));
    expect(container.textContent).not.toContain("Move to window");
  });

  it("surfaces the multi-window hint only when more than one window is open", () => {
    mockWindowCount = 2;
    act(() => root.render(<EmptyWindowState />));

    expect(container.textContent).toContain("Move to window");
  });
});
