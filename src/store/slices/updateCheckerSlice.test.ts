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

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => {
  const available = over.available ?? true;
  return {
    available,
    latestVersion: "0.2.0",
    releaseUrl: "https://example/0.2.0",
    releaseNotes: "notes",
    isSecurity: false,
    channel: "stable",
    outcome: available ? "updateAvailable" : "upToDate",
    ...over,
  };
};

/** A feed-less backend result (#5651): nothing was read from a release feed. */
const feedless = (outcome: UpdateInfo["outcome"], over: Partial<UpdateInfo> = {}): UpdateInfo =>
  info({ available: false, latestVersion: "0.1.0", releaseUrl: "", outcome, ...over });

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

  it.each(["skippedAutoOff", "skippedRateLimited"] as const)(
    "does not claim up-to-date when a startup check was %s (#5615, #5651)",
    async (outcome) => {
      mockedCheck.mockResolvedValueOnce(feedless(outcome));
      await store.getState().checkForUpdates(false);
      expect(store.getState().updateCheckState).toBe("idle");
      expect(store.getState().updateInfo).toBeNull();
      expect(mockedMirror).not.toHaveBeenCalled();
    }
  );

  it("keeps the previous result when a skipped check follows a real one (#5615)", async () => {
    mockedCheck.mockResolvedValueOnce(info({ available: false }));
    await store.getState().checkForUpdates(true);
    mockedCheck.mockResolvedValueOnce(feedless("skippedRateLimited"));
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateCheckState).toBe("up-to-date");
    expect(store.getState().updateInfo?.releaseUrl).toBe("https://example/0.2.0");
  });

  it("trusts the outcome, not releaseUrl: a feed-backed result without a URL is up to date (#5651)", async () => {
    mockedCheck.mockResolvedValueOnce(info({ available: false, releaseUrl: "" }));
    await store.getState().checkForUpdates(false);
    expect(store.getState().updateCheckState).toBe("up-to-date");
  });

  it.each([true, false])(
    "reports a failed check (force=%s) as an error with its reason (#5651)",
    async (force) => {
      const refreshed = { updates: { lastCheckTime: "2026-11-13T08:00:00Z" } };
      mockedGetSettings.mockResolvedValueOnce(refreshed as Awaited<ReturnType<typeof getSettings>>);
      mockedCheck.mockResolvedValueOnce(
        feedless("failed", { failureReason: "GitHub API returned HTTP 503" })
      );
      const logs = await captureLogs(() => store.getState().checkForUpdates(force));
      expect(store.getState().updateCheckState).toBe("error");
      expect(store.getState().updateCheckFailureReason).toBe("GitHub API returned HTTP 503");
      expect(store.getState().updateInfo).toBeNull();
      expect(logs.some((m) => m.includes("HTTP 503"))).toBe(true);
      // The backend stamps lastCheckTime on failure too; the page picks it up.
      expect(mockedMirror).toHaveBeenCalledWith("settings.replace", { settings: refreshed });
    }
  );

  it("clears the failure reason after a later successful check", async () => {
    mockedCheck.mockResolvedValueOnce(feedless("failed", { failureReason: "offline" }));
    await store.getState().checkForUpdates(true);
    mockedCheck.mockResolvedValueOnce(info({ available: false }));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("up-to-date");
    expect(store.getState().updateCheckFailureReason).toBeNull();
  });

  it("keeps the no-check build result so the page can say so", async () => {
    mockedCheck.mockResolvedValueOnce(feedless("notChecking", { channel: "none" }));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("up-to-date");
    expect(store.getState().updateInfo?.outcome).toBe("notChecking");
  });

  it("sets error state when the check throws", async () => {
    mockedCheck.mockRejectedValueOnce(new Error("network"));
    await store.getState().checkForUpdates(true);
    expect(store.getState().updateCheckState).toBe("error");
    expect(store.getState().updateCheckFailureReason).toBe("network");
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
