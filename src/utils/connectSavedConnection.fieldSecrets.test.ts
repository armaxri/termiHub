/**
 * The saved-connection connect flow fills in schema field secrets (#4429): a
 * VNC SSH-tunnel password that lives in the credential store — or nowhere,
 * with credential storage "none" — is taken from the store behind the unlock
 * gate, else prompted for, before the tab opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveFieldSecrets: vi.fn(() => Promise.resolve({})),
  storeFieldSecrets: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

import { toast } from "@/components/ui";
import { resolveFieldSecrets, storeFieldSecrets } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { SavedConnection } from "@/types/connection";
import type { ConnectionTypeInfo } from "@/types/generated/ConnectionTypeInfo";
import { connectSavedConnection } from "./connectSavedConnection";

const mockedResolveFieldSecrets = vi.mocked(resolveFieldSecrets);
const mockedStoreFieldSecrets = vi.mocked(storeFieldSecrets);

const VNC_TYPE = {
  typeId: "vnc",
  displayName: "VNC",
  icon: "monitor",
  capabilities: { graphical: true, terminal: false },
  schema: {
    groups: [
      {
        key: "sshTunnel",
        label: "SSH Tunnel",
        fields: [
          { key: "useSshTunnel", label: "Tunnel", fieldType: { type: "boolean" }, required: false },
          {
            key: "sshAuthMethod",
            label: "SSH Auth",
            fieldType: { type: "select", options: [{ value: "password", label: "Password" }] },
            required: false,
          },
          {
            key: "sshPassword",
            label: "SSH Password",
            fieldType: { type: "password" },
            required: false,
            visibleWhen: { field: "useSshTunnel", equals: true },
          },
        ],
      },
    ],
  },
} as unknown as ConnectionTypeInfo;

const DESK: SavedConnection = {
  id: "Desk",
  name: "Desk",
  folderId: null,
  config: {
    type: "vnc",
    config: {
      host: "desk",
      useSshTunnel: true,
      sshHost: "gw",
      sshUsername: "ops",
      sshAuthMethod: "password",
    },
  },
};

let addTabSpy: ReturnType<typeof vi.fn>;
let requestUnlockSpy: ReturnType<typeof vi.fn>;
let requestPasswordSpy: ReturnType<typeof vi.fn>;

function setup(mode: "none" | "master_password", status: "unavailable" | "locked" | "unlocked") {
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTabSpy as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    requestUnlock: requestUnlockSpy as unknown as ReturnType<
      typeof useAppStore.getState
    >["requestUnlock"],
    requestPassword: requestPasswordSpy as unknown as ReturnType<
      typeof useAppStore.getState
    >["requestPassword"],
    credentialStoreStatus: { mode, status },
    connectionTypes: [VNC_TYPE],
  });
}

/** The settings the opened tab connects with. */
function openedSettings(): Record<string, unknown> {
  expect(addTabSpy).toHaveBeenCalledTimes(1);
  return addTabSpy.mock.calls[0][2].config as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  addTabSpy = vi.fn(() => "tab-new");
  requestUnlockSpy = vi.fn(() => Promise.resolve(true));
  requestPasswordSpy = vi.fn(() =>
    Promise.resolve({ password: "typed-gateway", shouldSave: false })
  );
  mockedResolveFieldSecrets.mockResolvedValue({});
  vi.spyOn(toast, "loading").mockReturnValue("toast");
  vi.spyOn(toast, "dismiss").mockImplementation(() => {});
  vi.spyOn(toast, "info").mockImplementation(() => "toast");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectSavedConnection — schema field secrets (#4429)", () => {
  it("with credential storage none prompts for the tunnel password and connects", async () => {
    setup("none", "unavailable");
    const result = await connectSavedConnection(DESK);
    expect(result.status).toBe("opened");
    expect(requestPasswordSpy).toHaveBeenCalledWith(
      "gw",
      "ops",
      expect.stringContaining("SSH Password"),
      "password",
      // The connection's name titles the prompt (#4475).
      { allowSave: false, label: "Desk" }
    );
    expect(openedSettings().sshPassword).toBe("typed-gateway");
    expect(mockedResolveFieldSecrets).not.toHaveBeenCalled();
    expect(mockedStoreFieldSecrets).not.toHaveBeenCalled();
  });

  it("with a locked store asks to unlock, then connects with the stored password", async () => {
    setup("master_password", "locked");
    mockedResolveFieldSecrets.mockResolvedValue({ fields: { sshPassword: "stored-gateway" } });
    const result = await connectSavedConnection(DESK);
    expect(requestUnlockSpy).toHaveBeenCalledTimes(1);
    expect(requestPasswordSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("opened");
    expect(openedSettings().sshPassword).toBe("stored-gateway");
  });

  it("cancelling the prompt opens nothing and says which secret was missing", async () => {
    setup("master_password", "unlocked");
    requestPasswordSpy.mockResolvedValue(null);
    const result = await connectSavedConnection(DESK);
    expect(result).toEqual({ status: "canceled" });
    expect(addTabSpy).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Connect canceled — SSH Password is required.");
  });

  it("unattended with no saved tunnel password is refused without prompting", async () => {
    setup("master_password", "unlocked");
    const result = await connectSavedConnection(DESK, { unattended: true });
    expect(result.status).toBe("refused");
    expect(requestPasswordSpy).not.toHaveBeenCalled();
    expect(addTabSpy).not.toHaveBeenCalled();
  });
});
