import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { resetPluginHostPlatformCache, usePluginHostPlatform } from "./usePluginHostPlatform";

vi.mock("@/services/api", () => ({
  getPluginHostPlatform: vi.fn(),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { getPluginHostPlatform } from "@/services/api";

const mockGet = vi.mocked(getPluginHostPlatform);

function Reader({ onState }: { onState: (s: string | null) => void }) {
  onState(usePluginHostPlatform());
  return null;
}

describe("usePluginHostPlatform (#3507)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetPluginHostPlatformCache();
    mockGet.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(): Promise<(string | null)[]> {
    const seen: (string | null)[] = [];
    await act(async () => {
      root.render(createElement(Reader, { onState: (s) => seen.push(s) }));
    });
    return seen;
  }

  it("fetches the host triple once and caches it across consumers", async () => {
    mockGet.mockResolvedValue("aarch64-apple-darwin");
    const first = await mount();
    expect(first[0]).toBeNull();
    expect(first[first.length - 1]).toBe("aarch64-apple-darwin");

    act(() => root.unmount());
    root = createRoot(container);
    const second = await mount();
    expect(second[0]).toBe("aarch64-apple-darwin");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("stays null when the fetch fails", async () => {
    mockGet.mockRejectedValue(new Error("no ipc"));
    const seen = await mount();
    expect(seen[seen.length - 1]).toBeNull();
  });
});
