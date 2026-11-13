/**
 * A tab opened on a session that already connected (the saved-credential
 * pre-connect) never runs the terminal's own connect, so it must register
 * itself in the backend lifecycle region as connected (#5608). Without that the
 * region never lists the tab: no live status and no reconnect after a drop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  closeTerminal: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve("stored-secret")),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/services/events", () => ({
  onConnectProgress: vi.fn(() => Promise.resolve(vi.fn())),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

vi.mock("@/store/sessionBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/sessionBridge")>()),
  mirrorSessionAlreadyConnected: vi.fn(),
}));

import { toast } from "@/components/ui";
import { createTerminal } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { mirrorSessionAlreadyConnected } from "@/store/sessionBridge";
import type { SavedConnection } from "@/types/connection";
import { connectSavedConnection } from "./connectSavedConnection";

const mirrored = vi.mocked(mirrorSessionAlreadyConnected);

function sshPassword(): SavedConnection {
  return {
    id: "conn-1",
    name: "web-1",
    folderId: null,
    config: {
      type: "ssh",
      config: { host: "h.example", username: "ops", authMethod: "password", savePassword: true },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(toast, "loading").mockReturnValue("connecting-toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: vi.fn(() => "tab-new") as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "master_password", status: "unlocked" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectSavedConnection — tab on a live session (#5608)", () => {
  it("registers the pre-connected tab in the lifecycle region", async () => {
    const result = await connectSavedConnection(sshPassword());
    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: "session-1" });
    expect(mirrored).toHaveBeenCalledExactlyOnceWith("tab-new");
  });

  it("leaves a tab that connects itself to the terminal's own connect", async () => {
    vi.mocked(createTerminal).mockRejectedValueOnce(new Error("network down"));
    await connectSavedConnection(sshPassword());
    expect(mirrored).not.toHaveBeenCalled();
  });
});
