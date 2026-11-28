import { describe, it, expect, beforeEach, vi } from "vitest";

// #6163: saving a connection whose sessions are open says that they keep the old
// settings, and "Reconnect now" reconnects them with the saved ones, in place.

const closeTerminalMock = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock("@/services/api", () => ({
  closeTerminal: (...args: unknown[]) => closeTerminalMock(...args),
  detachPersistentTab: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn(), loading: vi.fn() },
}));

import { toast } from "@/components/ui";
import { useAppStore } from "./appStore";
import type { SavedConnection } from "@/types/connection";
import {
  announceSessionsOnOldSettings,
  reconnectWithSavedSettings,
  sessionsOnOldSettings,
} from "./savedConnectionSessions";

const before: SavedConnection = {
  id: "Build box",
  name: "Build box",
  folderId: null,
  config: { type: "ssh", config: { host: "old.example", port: 22, username: "me" } },
};
const after: SavedConnection = {
  ...before,
  config: { type: "ssh", config: { host: "new.example", port: 22, username: "me" } },
};

function openTab(sessionId: string | null, connectionId = before.id, persistent?: string): string {
  return useAppStore.getState().addTab("Build box", "ssh", before.config, {
    contentType: "terminal",
    sessionId: sessionId ?? undefined,
    connectionId,
    persistentConnectionId: persistent,
  });
}

function tabConfig(tabId: string) {
  return useAppStore.getState().tabContent[tabId]?.config;
}

describe("sessions on a saved connection's old settings (#6163)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    closeTerminalMock.mockClear();
    vi.mocked(toast.info).mockClear();
  });

  it("says nothing when no session of the connection is open", () => {
    openTab("other", "Another box");
    announceSessionsOnOldSettings(before, after);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("says nothing when the save changed nothing a session uses", () => {
    openTab("s1");
    announceSessionsOnOldSettings(before, { ...before, description: "a note" });
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("tells about one open session and offers Reconnect now", () => {
    openTab("s1");
    announceSessionsOnOldSettings(before, after);
    expect(toast.info).toHaveBeenCalledWith(
      "1 open session of “Build box” keeps the old settings until it reconnects",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Reconnect now" }),
      })
    );
  });

  it("counts several, and leaves out persistent and not-connected tabs", () => {
    openTab("s1");
    openTab("s2");
    openTab("s3", before.id, "persist-1"); // keeps running in the background
    openTab(null); // never connected
    expect(sessionsOnOldSettings(before.id)).toHaveLength(2);
    announceSessionsOnOldSettings(before, after);
    expect(toast.info).toHaveBeenCalledWith(
      "2 open sessions of “Build box” keep the old settings until they reconnect",
      expect.anything()
    );
  });

  it("Reconnect now reconnects each in place with the saved settings", () => {
    const a = openTab("s1");
    const b = openTab("s2");
    reconnectWithSavedSettings([a, b], after.config);
    for (const [tab, session] of [
      [a, "s1"],
      [b, "s2"],
    ]) {
      expect(tabConfig(tab)).toEqual(after.config);
      // The old session is closed as the user's own, and the tab reconnects.
      expect(closeTerminalMock).toHaveBeenCalledWith(session, true);
      expect(useAppStore.getState().terminalRetryCounters[tab]).toBe(1);
    }
  });
});
