import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "./appStore";

/**
 * The live framebuffer resolution surfaced to the store (#1709) — keyed by
 * session id, fed from the remote-desktop frame path, and cleared when a
 * session ends. This is the substrate the shared status-bar segment reads.
 */
describe("appStore remote-desktop resolution", () => {
  beforeEach(() => {
    useAppStore.setState({ remoteDesktopResolutions: {} });
  });

  it("starts empty", () => {
    expect(useAppStore.getState().remoteDesktopResolutions).toEqual({});
  });

  it("records and overwrites a session's resolution", () => {
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    expect(useAppStore.getState().remoteDesktopResolutions.s1).toEqual({ width: 800, height: 600 });

    useAppStore.getState().setRemoteDesktopResolution("s1", 1920, 1080);
    expect(useAppStore.getState().remoteDesktopResolutions.s1).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("keeps sessions independent by id", () => {
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    useAppStore.getState().setRemoteDesktopResolution("s2", 1024, 768);
    expect(useAppStore.getState().remoteDesktopResolutions).toEqual({
      s1: { width: 800, height: 600 },
      s2: { width: 1024, height: 768 },
    });
  });

  it("does not create a new object reference for an unchanged resolution", () => {
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    const before = useAppStore.getState().remoteDesktopResolutions;
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    expect(useAppStore.getState().remoteDesktopResolutions).toBe(before);
  });

  it("clears a session's resolution without disturbing others", () => {
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    useAppStore.getState().setRemoteDesktopResolution("s2", 1024, 768);

    useAppStore.getState().clearRemoteDesktopResolution("s1");

    expect(useAppStore.getState().remoteDesktopResolutions).toEqual({
      s2: { width: 1024, height: 768 },
    });
  });

  it("clearing an unknown session is a no-op", () => {
    useAppStore.getState().setRemoteDesktopResolution("s1", 800, 600);
    const before = useAppStore.getState().remoteDesktopResolutions;
    useAppStore.getState().clearRemoteDesktopResolution("nope");
    expect(useAppStore.getState().remoteDesktopResolutions).toBe(before);
  });
});
