import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { UpdateInfo } from "@/types/connection";
import { onFrontendLog } from "@/utils/frontendLog";

vi.mock("@/services/api", () => ({
  checkForUpdates: vi.fn(),
  skipUpdateVersion: vi.fn(() => Promise.resolve()),
  clearSkippedVersion: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/storage", () => ({
  getSettings: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../settingsBridge", () => ({
  currentSettingsView: vi.fn(() => ({ updates: {} })),
  mirrorSettingsIntent: vi.fn(),
}));

import {
  checkForUpdates as apiCheckForUpdates,
  skipUpdateVersion as apiSkipUpdateVersion,
  clearSkippedVersion as apiClearSkippedVersion,
} from "@/services/api";
import { getSettings } from "@/services/storage";
import { currentSettingsView, mirrorSettingsIntent } from "../settingsBridge";
import { createUpdateCheckerSlice, type UpdateCheckerSlice } from "./updateCheckerSlice";

const mockedCheck = vi.mocked(apiCheckForUpdates);
const mockedSkip = vi.mocked(apiSkipUpdateVersion);
const mockedClear = vi.mocked(apiClearSkippedVersion);
const mockedView = vi.mocked(currentSettingsView);
const mockedMirror = vi.mocked(mirrorSettingsIntent);
const mockedGetSettings = vi.mocked(getSettings);

const makeStore = () =>
  create<UpdateCheckerSlice>()(
    createUpdateCheckerSlice as unknown as StateCreator<UpdateCheckerSlice>
  );

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  available: true,
  latestVersion: "0.2.0",
  releaseUrl: "https://example/0.2.0",
  releaseNotes: "notes",
  isSecurity: false,
  channel: "stable",
  ...over,
});

const setSkipped = (version: string | undefined) =>
  mockedView.mockReturnValue({ updates: { skippedVersion: version } } as ReturnType<
    typeof currentSettingsView
  >);

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const messages: string[] = [];
  const off = onFrontendLog((entry) => messages.push(entry.message));
  try {
    await fn();
  } finally {
    off();
  }
  return messages;
}

describe("updateCheckerSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    setSkipped(undefined);
    store = makeStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to idle with no update info", () => {
    expect(store.getState().updateCheckState).toBe("idle");
    expect(store.getState().updateInfo).toBeNull();
    expect(store.getState().updateNotificationDismissed).toBe(false);
  });

  it("marks an available, non-skipped update as available and shows the popup", async () => {
    mockedCheck.mockResolvedValueOnce(info());
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("available");
    expect(store.getState().updateInfo).toEqual(info());
    expect(store.getState().updateNotificationDismissed).toBe(false);
  });

  it("keeps a previously-skipped non-security version dismissed", async () => {
    setSkipped("0.2.0");
    mockedCheck.mockResolvedValueOnce(info());
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateCheckState).toBe("available");
    expect(store.getState().updateNotificationDismissed).toBe(true);
  });

  it("still shows a security update even if that version was skipped", async () => {
    setSkipped("0.2.0");
    mockedCheck.mockResolvedValueOnce(info({ isSecurity: true }));
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateNotificationDismissed).toBe(false);
  });

  it("reports up-to-date when no update is available", async () => {
    mockedCheck.mockResolvedValueOnce(info({ available: false }));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("up-to-date");
  });

  it("mirrors the refreshed settings after a completed check so lastCheckTime shows (#5615)", async () => {
    const refreshed = { updates: { lastCheckTime: "2026-11-13T08:00:00Z" } };
    mockedGetSettings.mockResolvedValueOnce(refreshed as Awaited<ReturnType<typeof getSettings>>);
    mockedCheck.mockResolvedValueOnce(info({ available: false }));
    await store.getState().checkForUpdates(false);
    expect(mockedMirror).toHaveBeenCalledWith("settings.replace", { settings: refreshed });
  });

  it("does not claim up-to-date when a startup check was skipped without consulting a feed (#5615)", async () => {
    // Auto-check off / rate-limited: the backend returns a feed-less result.
    mockedCheck.mockResolvedValueOnce(info({ available: false, releaseUrl: "" }));
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateCheckState).toBe("idle");
    expect(store.getState().updateInfo).toBeNull();
  });

  it("keeps the previous result when a skipped check follows a real one (#5615)", async () => {
    mockedCheck.mockResolvedValueOnce(info({ available: false }));
    await store.getState().checkForUpdates(true);
    mockedCheck.mockResolvedValueOnce(info({ available: false, releaseUrl: "" }));
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateCheckState).toBe("up-to-date");
    expect(store.getState().updateInfo?.releaseUrl).toBe("https://example/0.2.0");
  });

  it("reports a failed manual check as an error, not up-to-date (#5615)", async () => {
    // The backend swallows feed errors into a feed-less "no update" result.
    mockedCheck.mockResolvedValueOnce(info({ available: false, releaseUrl: "" }));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("error");
  });

  it("keeps the no-check build result so the page can say so", async () => {
    mockedCheck.mockResolvedValueOnce(info({ available: false, releaseUrl: "", channel: "none" }));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("up-to-date");
    expect(store.getState().updateInfo?.channel).toBe("none");
  });

  it("sets error state when the check throws", async () => {
    mockedCheck.mockRejectedValueOnce(new Error("network"));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("error");
  });

  it("dismissUpdateNotification sets the dismissed flag", () => {
    store.getState().dismissUpdateNotification();
    expect(store.getState().updateNotificationDismissed).toBe(true);
  });

  it("skipUpdate is a no-op when there is no update info", async () => {
    await store.getState().skipUpdate();
    expect(mockedSkip).not.toHaveBeenCalled();
    expect(mockedMirror).not.toHaveBeenCalled();
  });

  it("skipUpdate persists, dismisses, and mirrors the refreshed settings", async () => {
    store.setState({ updateInfo: info() });
    await store.getState().skipUpdate();
    expect(mockedSkip).toHaveBeenCalledWith("0.2.0");
    expect(store.getState().updateNotificationDismissed).toBe(true);
    expect(mockedMirror).toHaveBeenCalledWith("settings.replace", expect.anything());
  });

  it("skipUpdate swallows and logs a rejection", async () => {
    store.setState({ updateInfo: info() });
    mockedSkip.mockRejectedValueOnce(new Error("save failed"));
    const logs = await captureLogs(() => store.getState().skipUpdate());
    expect(logs.some((m) => m.includes("save failed"))).toBe(true);
    expect(mockedMirror).not.toHaveBeenCalled();
  });

  it("clearSkippedUpdateVersion clears and mirrors the refreshed settings", async () => {
    await store.getState().clearSkippedUpdateVersion();
    expect(mockedClear).toHaveBeenCalled();
    expect(mockedMirror).toHaveBeenCalledWith("settings.replace", expect.anything());
  });

  it("clearSkippedUpdateVersion swallows and logs a rejection", async () => {
    mockedClear.mockRejectedValueOnce(new Error("clear failed"));
    const logs = await captureLogs(() => store.getState().clearSkippedUpdateVersion());
    expect(logs.some((m) => m.includes("clear failed"))).toBe(true);
    expect(mockedMirror).not.toHaveBeenCalled();
  });
});
