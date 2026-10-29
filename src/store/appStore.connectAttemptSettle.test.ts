import { describe, it, expect, beforeEach, vi } from "vitest";

// #5081: a connect attempt that the user aborts, that hits the client deadline,
// or that fails on a retry must actually END — the backend connect is cancelled
// and the session-lifecycle region leaves `connecting` — or the overlay keeps
// showing "Connecting…" forever with an emptied ring.

const { cancelConnecting, mirrorSessionIntent, sessionView } = vi.hoisted(() => ({
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  mirrorSessionIntent: vi.fn(),
  sessionView: { current: {} as Record<string, { status: string }> },
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() => Promise.resolve({ version: "1", externalConnectionFiles: [] })),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  cancelConnecting,
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/store/sessionBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/sessionBridge")>()),
  mirrorSessionIntent,
  currentSessionView: () => sessionView.current,
}));

import { useAppStore } from "./appStore";
import { ABORTED_CONNECT_MESSAGE } from "./reconnectHelpers";

const connectFailedFolds = () =>
  mirrorSessionIntent.mock.calls.filter((c) => c[0] === "session.connectFailed");

describe("ending a connect attempt (#5081)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    cancelConnecting.mockClear();
    mirrorSessionIntent.mockClear();
    sessionView.current = { "tab-1": { status: "connecting" } };
  });

  it("Abort cancels the backend connect of the first attempt and leaves connecting", () => {
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().abortTerminalConnect("tab-1");

    expect(cancelConnecting).toHaveBeenCalledWith("tab-1:0");
    expect(connectFailedFolds()).toEqual([
      ["session.connectFailed", "tab-1", ABORTED_CONNECT_MESSAGE],
    ]);
  });

  it("Abort on a retry cancels THAT attempt's connect id", () => {
    useAppStore.getState().retryTerminalSpawn("tab-1");
    useAppStore.getState().retryTerminalSpawn("tab-1");
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().abortTerminalConnect("tab-1");

    expect(cancelConnecting).toHaveBeenCalledWith("tab-1:2");
    expect(connectFailedFolds()).toHaveLength(1);
  });

  it("the client deadline ends the attempt the same way", () => {
    useAppStore.getState().retryTerminalSpawn("tab-1");
    useAppStore.getState().setTerminalConnecting("tab-1", true);
    useAppStore.getState().failTerminalConnectTimeout("tab-1", "connecting");

    expect(cancelConnecting).toHaveBeenCalledWith("tab-1:1");
    expect(connectFailedFolds()).toHaveLength(1);
    expect(useAppStore.getState().terminalSpawnErrorKinds["tab-1"]).toBe("timeout");
  });

  it("a failed attempt folds the region out of connecting (retries are not folded by the backend)", () => {
    useAppStore.getState().retryTerminalSpawn("tab-1");
    useAppStore.getState().settleFailedConnect("tab-1", "TCP connect failed: timed out");

    expect(connectFailedFolds()).toEqual([
      ["session.connectFailed", "tab-1", "TCP connect failed: timed out"],
    ]);
  });

  it("does not fold a tab whose region is no longer connecting", () => {
    sessionView.current = { "tab-1": { status: "failed" } };
    useAppStore.getState().settleFailedConnect("tab-1", "boom");
    sessionView.current = { "tab-1": { status: "reconnecting" } };
    useAppStore.getState().abortTerminalConnect("tab-1");

    expect(connectFailedFolds()).toEqual([]);
  });
});
