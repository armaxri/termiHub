/**
 * Tests for {@link passwordReentry} — inline password re-entry for VNC/RDP and
 * FTP tabs (#5377).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { storeCredential } from "@/services/api";
import { ensureCredentialStoreUnlocked } from "@/utils/ensureCredentialStoreUnlocked";
import { setConnectionsViewForTest } from "@/store/connectionsBridge";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import type { SavedConnection } from "@/types/connection";
import {
  graphicalConnectFailed,
  graphicalConnectSucceeded,
} from "@/utils/graphicalSecretOnceConnected";
import { passwordReentryTarget, reconnectGraphicalWithPassword } from "./passwordReentry";

vi.mock("@/services/api", () => ({
  storeCredential: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));

const mockedStore = vi.mocked(storeCredential);
const mockedUnlock = vi.mocked(ensureCredentialStoreUnlocked);

const SAVED = {
  id: "Lab/Desk",
  name: "Desk",
  config: { type: "rdp", config: {} },
  sourceFile: "/team.json",
} as unknown as SavedConnection;

const RDP = {
  type: "rdp",
  config: { host: "desk.lan", username: "ada", password: "old", savePassword: true },
};

function addRdpTab(connectionId?: string): string {
  return useAppStore
    .getState()
    .addTab("Desk", "rdp", RDP, { contentType: "remote-desktop", connectionId });
}

function tabPassword(tabId: string): unknown {
  const tab = activeTreeTabs(useAppStore.getState()).find((t) => t.id === tabId);
  return (tab?.config.config as Record<string, unknown>).password;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUnlock.mockResolvedValue(true);
  useAppStore.setState(useAppStore.getInitialState());
  setConnectionsViewForTest({ folders: [], connections: [SAVED] });
});

describe("passwordReentryTarget", () => {
  it("is a password target carrying host, user and the Save default", () => {
    expect(passwordReentryTarget(RDP, "Lab/Desk", true)).toEqual({
      authMethod: "password",
      host: "desk.lan",
      username: "ada",
      keyPath: "",
      agentHosted: false,
      credentialId: "Lab/Desk",
      saveDefault: true,
    });
  });

  it("offers no Save for an unsaved tab, an unknown id, or when saving is off", () => {
    expect(passwordReentryTarget(RDP, undefined, true)?.credentialId).toBeNull();
    expect(passwordReentryTarget(RDP, "Gone/x", true)?.credentialId).toBeNull();
    expect(passwordReentryTarget(RDP, "Lab/Desk", false)?.credentialId).toBeNull();
  });

  it("is null without a config", () => {
    expect(passwordReentryTarget(undefined, "Lab/Desk", true)).toBeNull();
  });
});

describe("reconnectGraphicalWithPassword", () => {
  it("puts the password on the tab and reconnects", async () => {
    const tabId = addRdpTab("Lab/Desk");
    const reconnect = vi.fn();
    const target = passwordReentryTarget(RDP, "Lab/Desk", true)!;
    const ok = await reconnectGraphicalWithPassword(
      tabId,
      target,
      { secret: "new", save: false },
      reconnect
    );
    expect(ok).toBe(true);
    expect(tabPassword(tabId)).toBe("new");
    expect(reconnect).toHaveBeenCalledOnce();
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("saves only once the reconnect succeeds", async () => {
    const tabId = addRdpTab("Lab/Desk");
    const target = passwordReentryTarget(RDP, "Lab/Desk", true)!;
    await reconnectGraphicalWithPassword(tabId, target, { secret: "new", save: true }, vi.fn());
    expect(mockedStore).not.toHaveBeenCalled();
    graphicalConnectSucceeded(tabId);
    await flush();
    expect(mockedStore).toHaveBeenCalledWith("Lab/Desk", "password", "new", "/team.json");
  });

  it("never saves a password the server rejects again", async () => {
    const tabId = addRdpTab("Lab/Desk");
    const target = passwordReentryTarget(RDP, "Lab/Desk", true)!;
    await reconnectGraphicalWithPassword(tabId, target, { secret: "typo", save: true }, vi.fn());
    graphicalConnectFailed(tabId);
    graphicalConnectSucceeded(tabId);
    await flush();
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("still reconnects, unsaved, when the store unlock is declined", async () => {
    mockedUnlock.mockResolvedValueOnce(false);
    const tabId = addRdpTab("Lab/Desk");
    const reconnect = vi.fn();
    const target = passwordReentryTarget(RDP, "Lab/Desk", true)!;
    const ok = await reconnectGraphicalWithPassword(
      tabId,
      target,
      { secret: "new", save: true },
      reconnect
    );
    expect(ok).toBe(false);
    expect(reconnect).toHaveBeenCalledOnce();
    graphicalConnectSucceeded(tabId);
    await flush();
    expect(mockedStore).not.toHaveBeenCalled();
  });
});
