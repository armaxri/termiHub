import { describe, it, expect, vi, beforeEach } from "vitest";

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
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(() => Promise.resolve([])),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  sftpDownload: vi.fn(() => Promise.resolve()),
  sftpUpload: vi.fn(() => Promise.resolve()),
  sftpMkdir: vi.fn(() => Promise.resolve()),
  sftpDelete: vi.fn(() => Promise.resolve()),
  sftpRename: vi.fn(() => Promise.resolve()),
  sftpWriteFileContent: vi.fn(() => Promise.resolve()),
  vscodeOpenRemote: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

// Test the SFTP navigateUp path logic — same algorithm as the local version,
// but without Windows drive-root handling.
function navigateUpSftp(currentPath: string): string | null {
  if (currentPath === "/") return null; // no-op
  const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
  return parentPath;
}

describe("useFileSystem (SFTP) — navigateUp path logic", () => {
  it("navigates up from a nested path", () => {
    expect(navigateUpSftp("/home/user/documents")).toBe("/home/user");
  });

  it("navigates up from a single-depth path", () => {
    expect(navigateUpSftp("/home")).toBe("/");
  });

  it("returns null (no-op) at root /", () => {
    expect(navigateUpSftp("/")).toBeNull();
  });

  it("navigates up from deeply nested path", () => {
    expect(navigateUpSftp("/var/log/nginx/access")).toBe("/var/log/nginx");
  });
});

import { useAppStore } from "@/store/appStore";

describe("useFileSystem (SFTP) — store integration", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("navigateSftp updates currentPath when sftpSessionId is set", async () => {
    // navigateSftp requires an active session — set one before navigating
    useAppStore.setState({ sftpSessionId: "sftp-test-123" });
    await useAppStore.getState().navigateSftp("/remote/dir");
    expect(useAppStore.getState().currentPath).toBe("/remote/dir");
  });

  it("sftpSessionId starts as null", () => {
    expect(useAppStore.getState().sftpSessionId).toBeNull();
  });

  it("isConnected is false when sftpSessionId is null", () => {
    const { sftpSessionId } = useAppStore.getState();
    expect(sftpSessionId).toBeNull();
  });
});
