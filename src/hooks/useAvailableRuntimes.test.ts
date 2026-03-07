import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { createElement } from "react";
import { useAvailableRuntimes, resetRuntimeCache } from "./useAvailableRuntimes";

vi.mock("@/services/api", () => ({
  checkDockerAvailable: vi.fn(),
  checkPodmanAvailable: vi.fn(),
}));

import { checkDockerAvailable, checkPodmanAvailable } from "@/services/api";

const mockDockerAvailable = vi.mocked(checkDockerAvailable);
const mockPodmanAvailable = vi.mocked(checkPodmanAvailable);

/** Helper component that exposes hook state via a callback. */
function HookReader({
  onState,
}: {
  onState: (s: ReturnType<typeof useAvailableRuntimes>) => void;
}) {
  const state = useAvailableRuntimes();
  onState(state);
  return null;
}

describe("useAvailableRuntimes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetRuntimeCache();
    mockDockerAvailable.mockReset();
    mockPodmanAvailable.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetRuntimeCache();
  });

  it("starts loading then resolves with availability", async () => {
    let resolve1!: (v: boolean) => void;
    let resolve2!: (v: boolean) => void;
    mockDockerAvailable.mockImplementation(() => new Promise((r) => (resolve1 = r)));
    mockPodmanAvailable.mockImplementation(() => new Promise((r) => (resolve2 = r)));

    let latest: ReturnType<typeof useAvailableRuntimes> | undefined;
    act(() => {
      root.render(createElement(HookReader, { onState: (s) => (latest = s) }));
    });

    expect(latest!.loading).toBe(true);

    await act(async () => {
      resolve1(true);
      resolve2(false);
    });

    expect(latest!.loading).toBe(false);
    expect(latest!.dockerAvailable).toBe(true);
    expect(latest!.podmanAvailable).toBe(false);
  });

  it("detects both runtimes available", async () => {
    mockDockerAvailable.mockResolvedValue(true);
    mockPodmanAvailable.mockResolvedValue(true);

    let latest: ReturnType<typeof useAvailableRuntimes> | undefined;
    await act(async () => {
      root.render(createElement(HookReader, { onState: (s) => (latest = s) }));
    });

    expect(latest!.loading).toBe(false);
    expect(latest!.dockerAvailable).toBe(true);
    expect(latest!.podmanAvailable).toBe(true);
  });

  it("handles API errors gracefully", async () => {
    mockDockerAvailable.mockRejectedValue(new Error("not found"));
    mockPodmanAvailable.mockRejectedValue(new Error("not found"));

    let latest: ReturnType<typeof useAvailableRuntimes> | undefined;
    await act(async () => {
      root.render(createElement(HookReader, { onState: (s) => (latest = s) }));
    });

    expect(latest!.loading).toBe(false);
    expect(latest!.dockerAvailable).toBe(false);
    expect(latest!.podmanAvailable).toBe(false);
  });

  it("uses cached result on subsequent renders", async () => {
    mockDockerAvailable.mockResolvedValue(true);
    mockPodmanAvailable.mockResolvedValue(false);

    let latest: ReturnType<typeof useAvailableRuntimes> | undefined;
    await act(async () => {
      root.render(createElement(HookReader, { onState: (s) => (latest = s) }));
    });

    expect(latest!.dockerAvailable).toBe(true);
    expect(latest!.podmanAvailable).toBe(false);

    // Unmount and re-render — should use cache
    act(() => root.unmount());
    root = createRoot(container);

    let second: ReturnType<typeof useAvailableRuntimes> | undefined;
    act(() => {
      root.render(createElement(HookReader, { onState: (s) => (second = s) }));
    });

    // Cached: loading should be false immediately
    expect(second!.loading).toBe(false);
    expect(second!.dockerAvailable).toBe(true);
    expect(second!.podmanAvailable).toBe(false);

    // API should have been called only once
    expect(mockDockerAvailable).toHaveBeenCalledTimes(1);
    expect(mockPodmanAvailable).toHaveBeenCalledTimes(1);
  });
});
