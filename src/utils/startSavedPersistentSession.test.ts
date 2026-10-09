import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A persistent session of a saved connection resolves its schema field
 * secrets (an inline jump-host hop's password, a plugin secret) through the
 * same unlock-and-prompt flow as a regular connect (#4454, #4429).
 */

const { mockStartPersistentSession, mockResolveFieldSecrets } = vi.hoisted(() => ({
  mockStartPersistentSession: vi.fn().mockResolvedValue("mock-session-id"),
  mockResolveFieldSecrets: vi.fn(),
}));

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
  startPersistentSession: mockStartPersistentSession,
  stopPersistentSession: vi.fn(() => Promise.resolve()),
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
  adoptPersistentSession: vi.fn(() => Promise.resolve()),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/utils/fieldSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/fieldSecrets")>()),
  resolveFieldSecrets: mockResolveFieldSecrets,
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { useAppStore } from "@/store/appStore";
import { startSavedPersistentSession } from "./startSavedPersistentSession";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { toast } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";

setupConnectionsRegion();
setupSettingsRegion();
setupAgentsRegion();

/** A saved SSH connection whose inline hop's password lives in the store. */
const JUMP_SSH: SavedConnection = {
  id: "target",
  name: "Target",
  config: {
    type: "ssh",
    config: {
      host: "target",
      username: "me",
      authMethod: "key",
      proxyJump: [{ host: "bastion", username: "ops", authMethod: "password" }],
    },
  },
  folderId: null,
  sourceFile: "/shared/team.json",
};

describe("startSavedPersistentSession", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    seedConnectionsRegion({ connections: [JUMP_SSH] });
  });

  it("starts the session with the resolved field secrets", async () => {
    const resolved = {
      ...JUMP_SSH.config.config,
      proxyJump: [{ host: "bastion", username: "ops", authMethod: "password", password: "hop" }],
    };
    mockResolveFieldSecrets.mockResolvedValueOnce({ status: "resolved", settings: resolved });

    await startSavedPersistentSession("target");

    expect(mockResolveFieldSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: JUMP_SSH.config.config,
        connectionId: "target",
        sourceFile: "/shared/team.json",
        unattended: false,
      })
    );
    expect(mockStartPersistentSession).toHaveBeenCalledWith("target", "ssh", resolved);
  });

  it("does not start the session when the user cancels the prompt", async () => {
    mockResolveFieldSecrets.mockResolvedValueOnce({
      status: "canceled",
      reason: "Connect canceled — jump host password is required.",
    });

    await startSavedPersistentSession("target");

    expect(mockStartPersistentSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().persistentSessions["target"]).toBeUndefined();
    expect(vi.mocked(toast).info).toHaveBeenCalledWith(
      "Connect canceled — jump host password is required."
    );
  });

  it("skips the resolver for a connection that needs no field secret", async () => {
    seedConnectionsRegion({
      connections: [
        { id: "shell", name: "Shell", config: { type: "local", config: {} }, folderId: null },
      ],
    });

    await startSavedPersistentSession("shell");

    expect(mockResolveFieldSecrets).not.toHaveBeenCalled();
    expect(mockStartPersistentSession).toHaveBeenCalledWith("shell", "local", {});
  });
});
