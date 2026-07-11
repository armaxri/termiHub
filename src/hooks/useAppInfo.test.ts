import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import type { AppInfo } from "@/services/api";
import { useAppInfo, useDesktopVersion, resetAppInfoCache } from "./useAppInfo";

vi.mock("@/services/api", () => ({
  getAppInfo: vi.fn(),
}));

import { getAppInfo } from "@/services/api";

const mockGetAppInfo = vi.mocked(getAppInfo);

const APP_INFO: AppInfo = {
  version: "1.2.3",
  gitHash: "abcdef1",
  isDev: false,
  buildBranch: "develop",
};

/** Helper component that exposes the full app info via a callback. */
function AppInfoReader({ onState }: { onState: (s: AppInfo | null) => void }) {
  const info = useAppInfo();
  onState(info);
  return null;
}

/** Helper component that exposes the desktop version via a callback. */
function VersionReader({ onState }: { onState: (s: string | null) => void }) {
  const version = useDesktopVersion();
  onState(version);
  return null;
}

describe("useAppInfo", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetAppInfoCache();
    mockGetAppInfo.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetAppInfoCache();
  });

  it("resolves with the full app info", async () => {
    mockGetAppInfo.mockResolvedValue(APP_INFO);

    let latest: AppInfo | null | undefined;
    await act(async () => {
      root.render(createElement(AppInfoReader, { onState: (s) => (latest = s) }));
    });

    expect(latest).toEqual(APP_INFO);
  });

  it("exposes the version through the useDesktopVersion wrapper", async () => {
    mockGetAppInfo.mockResolvedValue(APP_INFO);

    let latest: string | null | undefined;
    await act(async () => {
      root.render(createElement(VersionReader, { onState: (s) => (latest = s) }));
    });

    expect(latest).toBe("1.2.3");
  });

  it("degrades to null when the fetch fails", async () => {
    mockGetAppInfo.mockRejectedValue(new Error("ipc unavailable"));

    let latest: AppInfo | null | undefined = APP_INFO;
    await act(async () => {
      root.render(createElement(AppInfoReader, { onState: (s) => (latest = s) }));
    });

    expect(latest).toBeNull();
  });

  it("fetches app info at most once across many consumers", async () => {
    mockGetAppInfo.mockResolvedValue(APP_INFO);

    // Render several consumers (both hooks) mounted at the same time.
    await act(async () => {
      root.render(
        createElement("div", null, [
          createElement(AppInfoReader, { key: "a", onState: () => {} }),
          createElement(AppInfoReader, { key: "b", onState: () => {} }),
          createElement(VersionReader, { key: "c", onState: () => {} }),
          createElement(VersionReader, { key: "d", onState: () => {} }),
        ])
      );
    });

    // Unmount and re-render a fresh consumer — should hit the cache.
    act(() => root.unmount());
    root = createRoot(container);
    let second: AppInfo | null | undefined;
    act(() => {
      root.render(createElement(AppInfoReader, { onState: (s) => (second = s) }));
    });

    expect(second).toEqual(APP_INFO);
    expect(mockGetAppInfo).toHaveBeenCalledTimes(1);
  });
});
