import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RecentSessionsSidebar } from "./RecentSessionsSidebar";
import { withTooltip } from "@/test/tooltip";
import type { SessionHistoryEntry } from "@/types/sessionHistory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));

const { writeClipboard, toastSuccess, toastError } = vi.hoisted(() => ({
  writeClipboard: vi.fn().mockResolvedValue(undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => writeClipboard(...args),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, success: toastSuccess, error: toastError },
  };
});

import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function type(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const entries: SessionHistoryEntry[] = [
  {
    dedupKey: "ssh:admin@prod:22",
    title: "admin@prod",
    connectionType: "ssh",
    config: { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
    firstUsed: 1000,
    lastUsed: 5000,
    useCount: 3,
    pinned: true,
    promoted: false,
  },
  {
    dedupKey: "serial:/dev/ttyUSB0:115200",
    title: "/dev/ttyUSB0",
    connectionType: "serial",
    config: { type: "serial", config: { device: "/dev/ttyUSB0", baudRate: 115200 } },
    firstUsed: 100,
    lastUsed: 200,
    useCount: 1,
    pinned: false,
    promoted: false,
  },
];

const addTab = vi.fn();
const splitPanel = vi.fn();
const pinHistoryEntry = vi.fn().mockResolvedValue(undefined);
const removeHistoryEntry = vi.fn().mockResolvedValue(undefined);
const clearSessionHistory = vi.fn().mockResolvedValue(undefined);

setupConnectionsRegion();
setupSettingsRegion();

describe("RecentSessionsSidebar", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    seedConnectionsRegion({ folders: [] });
    useAppStore.setState({
      sessionHistory: [],
      connectionTypes: [],
      addTab,
      splitPanel,
      requestPassword: vi.fn(),
      pinHistoryEntry,
      removeHistoryEntry,
      clearSessionHistory,
      markHistoryPromoted: vi.fn().mockResolvedValue(undefined),
      addConnection: vi.fn(),
    });
    seedSettings({ defaultUser: "root" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => root.render(withTooltip(<RecentSessionsSidebar />)));
  }

  it("shows the empty state when there is no history", () => {
    render();
    expect(query("recent-sessions-empty")).not.toBeNull();
    expect(query("recent-sessions-list")).toBeNull();
  });

  it("renders a row per history entry", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    expect(query("recent-sessions-list")).not.toBeNull();
    expect(query("recent-session-ssh:admin@prod:22")).not.toBeNull();
    expect(query("recent-session-serial:/dev/ttyUSB0:115200")).not.toBeNull();
    expect(query("recent-session-name-ssh:admin@prod:22")?.textContent).toBe("admin@prod");
  });

  it("filters the list by the search query", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    type("recent-sessions-search", "ttyusb");
    expect(query("recent-session-serial:/dev/ttyUSB0:115200")).not.toBeNull();
    expect(query("recent-session-ssh:admin@prod:22")).toBeNull();
  });

  it("shows a no-results state when nothing matches", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    type("recent-sessions-search", "nonexistent");
    expect(query("recent-sessions-no-results")).not.toBeNull();
  });

  it("opens an SSH tab from the quick-connect bar", () => {
    render();
    type("quick-connect-input", "me@example.com:2200");
    act(() => (query("quick-connect-submit") as HTMLButtonElement).click());
    expect(addTab).toHaveBeenCalledTimes(1);
    const [, connType, config] = addTab.mock.calls[0];
    expect(connType).toBe("ssh");
    expect(config).toEqual({
      type: "ssh",
      config: { host: "example.com", port: 2200, username: "me" },
    });
  });

  it("shows an error toast for an invalid quick-connect entry", () => {
    render();
    type("quick-connect-input", "user@");
    act(() => (query("quick-connect-submit") as HTMLButtonElement).click());
    expect(addTab).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("reconnects on the row Connect action", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    act(() => (query("recent-session-connect-ssh:admin@prod:22") as HTMLButtonElement).click());
    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab.mock.calls[0][1]).toBe("ssh");
  });

  it("opens the session in a new panel from the context menu", async () => {
    useAppStore.setState({ sessionHistory: entries });
    render();

    // Open the row's context menu, then invoke "Connect in New Panel".
    const row = query("recent-session-serial:/dev/ttyUSB0:115200")!;
    act(() => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const item = query("recent-session-menu-connect-new-panel-serial:/dev/ttyUSB0:115200");
    expect(item).not.toBeNull();

    act(() => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Splits into a new panel first, then opens the session there.
    expect(splitPanel).toHaveBeenCalledTimes(1);
    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab.mock.calls[0][1]).toBe("serial");
  });

  it("toggles pin via the row action", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    // The pinned SSH row's action unpins it.
    act(() => (query("recent-session-pin-ssh:admin@prod:22") as HTMLButtonElement).click());
    expect(pinHistoryEntry).toHaveBeenCalledWith("ssh:admin@prod:22", false);
  });

  it("removes an entry via the row action", () => {
    useAppStore.setState({ sessionHistory: entries });
    render();
    act(() =>
      (query("recent-session-remove-serial:/dev/ttyUSB0:115200") as HTMLButtonElement).click()
    );
    expect(removeHistoryEntry).toHaveBeenCalledWith("serial:/dev/ttyUSB0:115200");
  });
});
