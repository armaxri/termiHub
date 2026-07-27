import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression suite for #2068 — store load/persist failures must not vanish into
 * an invisible `console.error`. Every catch block in appStore now routes through
 * `frontendLog("app_store", …)` so the failure reaches the LogViewer, and the
 * user-facing load/persist failures additionally surface a recoverable
 * `toast.error`. These tests lock in both behaviours:
 *   - failures are logged via frontendLog (never a bare console.error), and
 *   - user-facing load/persist failures toast, while best-effort background
 *     loads log only (no toast spam).
 */

// Mock the toast hub so we can assert (or assert the absence of) feedback.
const toastError = vi.fn((_message: unknown, _opts?: unknown) => undefined);
vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: (message: unknown, opts?: unknown) =>
      opts === undefined ? toastError(message) : toastError(message, opts),
    loading: vi.fn(() => "toast-id"),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
  persistConnection: vi.fn(() => Promise.resolve("id")),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", () => ({
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  getDefaultShell: vi.fn(() => Promise.resolve(null)),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/services/workspaceApi", () => ({
  getWorkspaces: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { onFrontendLog } from "@/utils/frontendLog";
import type { LogEntry } from "@/types/terminal";
import { loadConnections, saveSettings, reloadExternalConnections } from "@/services/storage";
import { getWorkspaces } from "@/services/workspaceApi";

/** Flush the fire-and-forget promise chains. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let logs: LogEntry[] = [];
let unsubscribe: () => void = () => {};

function logged(substring: string): boolean {
  return logs.some((e) => e.target === "frontend::app_store" && e.message.includes(substring));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  logs = [];
  unsubscribe = onFrontendLog((entry) => logs.push(entry));
});

afterEach(() => {
  unsubscribe();
});

describe("#2068 — user-facing load/persist failures log and toast", () => {
  it("loadFromBackend logs and toasts when connections fail to load", async () => {
    vi.mocked(loadConnections).mockRejectedValueOnce(new Error("db corrupt"));

    await useAppStore.getState().loadFromBackend();
    await flush();

    expect(logged("Failed to load connections from backend")).toBe(true);
    expect(logged("db corrupt")).toBe(true);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("db corrupt"),
      expect.objectContaining({ id: "load-connections-error" })
    );
  });

  it("updateSettings logs and toasts when the save fails", async () => {
    vi.mocked(saveSettings).mockRejectedValueOnce(new Error("disk full"));

    await useAppStore.getState().updateSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    });
    await flush();

    expect(logged("Failed to save settings")).toBe(true);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
      expect.objectContaining({ id: "save-settings-error" })
    );
  });

  it("reloadExternalConnections logs and toasts on failure", async () => {
    vi.mocked(reloadExternalConnections).mockRejectedValueOnce(new Error("bad file"));

    await useAppStore.getState().reloadExternalConnections();
    await flush();

    expect(logged("Failed to reload external connections")).toBe(true);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("bad file"),
      expect.objectContaining({ id: "reload-external-connections-error" })
    );
  });
});

describe("#2068 — best-effort background loads log only, no toast", () => {
  it("loadWorkspaces logs the failure but does not toast", async () => {
    vi.mocked(getWorkspaces).mockRejectedValueOnce(new Error("no dir"));

    await useAppStore.getState().loadWorkspaces();
    await flush();

    expect(logged("Failed to load workspaces")).toBe(true);
    expect(logged("no dir")).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
  });
});
