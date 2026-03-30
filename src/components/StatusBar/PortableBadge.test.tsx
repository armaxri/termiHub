import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { PortableBadge } from "./PortableBadge";

// Standard mocks required when importing useAppStore
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

describe("PortableBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when not in portable mode", () => {
    useAppStore.setState({ isPortableMode: false });
    act(() => {
      root.render(<PortableBadge />);
    });
    expect(container.querySelector('[data-testid="portable-badge"]')).toBeNull();
  });

  it("renders the badge when in portable mode", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });
    act(() => {
      root.render(<PortableBadge />);
    });
    const badge = container.querySelector('[data-testid="portable-badge"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("Portable");
  });

  it("includes the data directory path in the tooltip when portableDataDir is set", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/opt/termihub/data" });
    act(() => {
      root.render(<PortableBadge />);
    });
    const badge = container.querySelector('[data-testid="portable-badge"]') as HTMLElement;
    expect(badge.title).toContain("/opt/termihub/data");
    expect(badge.title).toContain("Portable mode");
  });

  it("shows generic tooltip when portableDataDir is null", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: null });
    act(() => {
      root.render(<PortableBadge />);
    });
    const badge = container.querySelector('[data-testid="portable-badge"]') as HTMLElement;
    expect(badge.title).toBe("Portable mode");
  });

  it("badge disappears after switching from portable to installed mode", () => {
    useAppStore.setState({ isPortableMode: true, portableDataDir: "/data" });
    act(() => {
      root.render(<PortableBadge />);
    });
    expect(container.querySelector('[data-testid="portable-badge"]')).not.toBeNull();

    act(() => {
      useAppStore.setState({ isPortableMode: false });
    });

    expect(container.querySelector('[data-testid="portable-badge"]')).toBeNull();
  });
});
