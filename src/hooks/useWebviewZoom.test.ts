import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

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

import { useAppStore } from "@/store/appStore";
import { useWebviewZoom } from "./useWebviewZoom";

function ZoomHarness() {
  useWebviewZoom();
  return null;
}

describe("useWebviewZoom", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    useAppStore.setState(useAppStore.getInitialState());
    document.documentElement.style.zoom = "";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.style.zoom = "";
  });

  it("does not set CSS zoom at default zoom level (1.0)", () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(ZoomHarness));
    });
    expect(document.documentElement.style.zoom).toBe("");
  });

  it("sets CSS zoom after zoomIn", () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(ZoomHarness));
    });
    act(() => {
      useAppStore.getState().zoomIn();
    });
    expect(document.documentElement.style.zoom).toBe("1.1");
  });

  it("sets CSS zoom after zoomOut", () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(ZoomHarness));
    });
    act(() => {
      useAppStore.getState().zoomOut();
    });
    expect(document.documentElement.style.zoom).toBe("0.91");
  });

  it("clears CSS zoom after zoomReset", () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(ZoomHarness));
    });
    act(() => {
      useAppStore.getState().zoomIn();
      useAppStore.getState().zoomIn();
    });
    act(() => {
      useAppStore.getState().zoomReset();
    });
    expect(document.documentElement.style.zoom).toBe("");
  });

  it("clears CSS zoom on unmount", () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(ZoomHarness));
    });
    act(() => {
      useAppStore.getState().zoomIn();
    });
    expect(document.documentElement.style.zoom).toBe("1.1");
    act(() => root.unmount());
    expect(document.documentElement.style.zoom).toBe("");
  });
});
