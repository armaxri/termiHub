import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalFilesOnlyPanel } from "./TerminalFilesOnlyPanel";
import { withTooltip } from "@/test/tooltip";
import { useAppStore, getActiveTab } from "@/store/appStore";
import {
  effectiveFilesOnly,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  FakeSessionTransport,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("lucide-react", () => ({
  FolderOpen: () => null,
  Loader2: () => null,
  Check: () => null,
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const filesOnly = () => ({ ...connected(), filesOnly: true });

describe("TerminalFilesOnlyPanel (#4078)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    transport = new FakeSessionTransport();
    setSessionTransportForTest(transport);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stopSessionSubscription();
    setSessionTransportForTest(null);
  });

  async function render(tabId: string): Promise<void> {
    act(() => root.render(withTooltip(<TerminalFilesOnlyPanel tabId={tabId} />)));
    await flush();
  }

  const panel = () => container.querySelector("[data-testid='terminal-files-only-panel']");
  const openFiles = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='terminal-files-only-open-files']");

  it("shows the no-shell notice with an Open Files button for a files-only tab", async () => {
    transport.setSession("tab-1", filesOnly());
    await render("tab-1");

    expect(panel()).not.toBeNull();
    // Announced once through the overlay's live region (#4514), not the wrapper.
    expect(panel()?.getAttribute("role")).toBeNull();
    expect(
      panel()?.querySelector("[data-testid='content-overlay-live']")?.getAttribute("role")
    ).toBe("status");
    expect(panel()?.textContent).toContain("This host doesn't allow a shell.");
    expect(panel()?.textContent).toContain("Files are available in the sidebar.");
    const button = openFiles();
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("Open Files");
  });

  it("renders nothing for a normal live session", async () => {
    transport.setSession("tab-1", connected());
    await render("tab-1");
    expect(panel()).toBeNull();
  });

  it("renders nothing once a files-only session ended", async () => {
    transport.setSession("tab-1", { ...disconnected("user"), filesOnly: true });
    await render("tab-1");
    expect(panel()).toBeNull();
  });

  it("Open Files focuses the tab and opens the Files sidebar", async () => {
    const store = useAppStore.getState();
    const tabId = store.addTab("SFTP host", "ssh");
    const otherId = useAppStore.getState().addTab("Other", "local");
    expect(getActiveTab(useAppStore.getState())?.id).toBe(otherId);
    useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: true });
    transport.setSession(tabId, filesOnly());
    await render(tabId);

    act(() => openFiles()?.click());
    await flush();

    const state = useAppStore.getState();
    expect(getActiveTab(state)?.id).toBe(tabId);
    expect(state.sidebarView).toBe("files");
    expect(state.sidebarCollapsed).toBe(false);
  });

  it("Open Files leaves an already-open Files sidebar open", async () => {
    const tabId = useAppStore.getState().addTab("SFTP host", "ssh");
    useAppStore.setState({ sidebarView: "files", sidebarCollapsed: false });
    transport.setSession(tabId, filesOnly());
    await render(tabId);

    act(() => openFiles()?.click());
    await flush();

    expect(useAppStore.getState().sidebarView).toBe("files");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe("effectiveFilesOnly (#4078)", () => {
  it("is true only for a live, unexited files-only session", () => {
    expect(effectiveFilesOnly(filesOnly())).toBe(true);
    expect(effectiveFilesOnly(connected())).toBe(false);
    expect(effectiveFilesOnly(undefined)).toBe(false);
    expect(effectiveFilesOnly({ ...disconnected("unexpected"), filesOnly: true })).toBe(false);
    expect(effectiveFilesOnly(withExit(filesOnly(), { reason: "clean", code: 0 }))).toBe(false);
  });
});
