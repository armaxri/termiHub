/**
 * A tab opened on a session that already connected (the saved-credential
 * pre-connect) never runs the terminal's own connect (#5608). It is opened bound
 * to that session, and the terminal's bind (`setTabSessionId` →
 * `mirrorSessionLive`) registers it in the lifecycle region — covered for every
 * such path in `src/store/liveSessionTabRegistration.test.ts` (#5645).
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

import { toast } from "@/components/ui";
import { createTerminal } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import { connectSavedConnection } from "./connectSavedConnection";

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
  it("opens the pre-connected tab bound to its live session", async () => {
    const result = await connectSavedConnection(sshPassword());
    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: "session-1" });
    const addTab = vi.mocked(useAppStore.getState().addTab);
    expect(addTab).toHaveBeenCalledOnce();
    expect(addTab.mock.calls[0][3]).toMatchObject({ sessionId: "session-1" });
  });

  it("leaves a tab that connects itself unbound, to the terminal's own connect", async () => {
    vi.mocked(createTerminal).mockRejectedValueOnce(new Error("network down"));
    await connectSavedConnection(sshPassword());
    const addTab = vi.mocked(useAppStore.getState().addTab);
    expect(addTab.mock.calls[0]?.[3]?.sessionId).toBeUndefined();
  });
});
