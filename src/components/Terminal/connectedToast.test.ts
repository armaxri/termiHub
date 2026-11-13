import { describe, it, expect, beforeEach, vi } from "vitest";

const success = vi.fn((_message: string, _opts?: unknown) => "id");
const dismiss = vi.fn((_id?: unknown) => undefined);

vi.mock("@/components/ui", () => ({
  toast: {
    success: (message: string, opts?: unknown) => success(message, opts),
    dismiss: (id?: unknown) => dismiss(id),
  },
}));

import {
  connectedToastId,
  dismissStaleConnectedToasts,
  hasLeftConnected,
  showConnectedToast,
} from "./connectedToast";
import type { TabStatusMaps } from "@/utils/tabStatus";

function maps(overrides: Partial<TabStatusMaps> = {}): TabStatusMaps {
  return {
    terminalConnecting: {},
    terminalReconnectingTabs: {},
    terminalSpawnErrors: {},
    terminalDisconnectErrors: {},
    terminalExitedTabs: {},
    ...overrides,
  };
}

describe("connected toast (#5618)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Forget any toast an earlier test left tracked.
    dismissStaleConnectedToasts(
      ["t1", "t2", "local"],
      maps({ terminalExitedTabs: { t1: true, t2: true, local: true } })
    );
    vi.clearAllMocks();
  });

  it("gives each tab a stable id so a reconnect replaces its toast", () => {
    showConnectedToast("t1", "prod-db", "ssh");
    showConnectedToast("t1", "prod-db", "ssh");
    expect(success).toHaveBeenCalledTimes(2);
    for (const call of success.mock.calls) {
      expect(call[0]).toBe("Connected");
      expect(call[1]).toMatchObject({ id: connectedToastId("t1"), description: "prod-db" });
    }
  });

  it("shows no toast for a local shell", () => {
    showConnectedToast("local", "Terminal", "local");
    expect(success).not.toHaveBeenCalled();
  });

  it("dismisses the toast when the tab disconnects", () => {
    showConnectedToast("t1", "drop-me", "ssh");
    dismissStaleConnectedToasts(["t1"], maps());
    expect(dismiss).not.toHaveBeenCalled();
    dismissStaleConnectedToasts(["t1"], maps({ terminalExitedTabs: { t1: true } }));
    expect(dismiss).toHaveBeenCalledWith(connectedToastId("t1"));
  });

  it("dismisses the toast when the tab starts reconnecting", () => {
    showConnectedToast("t2", "serial", "serial");
    dismissStaleConnectedToasts(["t2"], maps({ terminalReconnectingTabs: { t2: true } }));
    expect(dismiss).toHaveBeenCalledWith(connectedToastId("t2"));
  });

  it("dismisses each tab's toast once and leaves other tabs alone", () => {
    showConnectedToast("t1", "a", "ssh");
    showConnectedToast("t2", "b", "telnet");
    const dropped = maps({ terminalDisconnectErrors: { t1: "gone" } });
    dismissStaleConnectedToasts(["t1", "t2"], dropped);
    dismissStaleConnectedToasts(["t1", "t2"], dropped);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith(connectedToastId("t1"));
  });

  it("does not treat a first connect in flight as leaving connected", () => {
    expect(hasLeftConnected(maps({ terminalConnecting: { t1: true } }), "t1")).toBe(false);
    expect(hasLeftConnected(maps({ terminalEvicted: { t1: true } }), "t1")).toBe(true);
    expect(hasLeftConnected(maps({ terminalSessionLost: { t1: true } }), "t1")).toBe(true);
  });
});
