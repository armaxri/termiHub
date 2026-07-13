import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A settable callback the mocked `onSpawnRequest` hands the event stream to, so
// tests can drive `spawn-request` events directly (mirrors useTransferEvents).
let emit: ((payload: SpawnRequestPayload) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@/services/events", () => ({
  onSpawnRequest: vi.fn((cb: (payload: SpawnRequestPayload) => void) => {
    emit = cb;
    return Promise.resolve(unlisten);
  }),
}));

const resolveContainerSpawn = vi.fn();
vi.mock("@/services/api", () => ({
  resolveContainerSpawn: (location: string, image?: string, mount?: string) =>
    resolveContainerSpawn(location, image, mount),
}));

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    error: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    info: vi.fn((_message: unknown, _opts?: unknown) => undefined),
    loading: vi.fn((_message: unknown, _opts?: unknown) => "toast-id"),
    dismiss: vi.fn((_id?: unknown) => undefined),
  },
}));

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useSpawnRequests } from "./useSpawnRequests";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { getAllLeaves } from "@/utils/panelTree";
import type { SpawnRequestPayload } from "@/services/events";
import type { ContainerSpawn } from "@/services/api";
import type { TerminalTab } from "@/types/terminal";

const SAMPLE_SPAWN: ContainerSpawn = {
  settings: {
    image: "alpine:3",
    volumes: [{ hostPath: "/home/user/app", containerPath: "/workspace", readOnly: false }],
    workingDirectory: "/workspace",
    removeOnExit: false,
  },
  title: "Container: alpine:3 (Spawned)",
  spawned: true,
};

function containerRequest(overrides: Partial<SpawnRequestPayload> = {}): SpawnRequestPayload {
  return {
    location: "/home/user/app",
    container_image: "alpine:3",
    container_mount: "/workspace",
    ...overrides,
  };
}

/** Collect every terminal tab across the live root panel. */
function allTabs(): TerminalTab[] {
  return getAllLeaves(useAppStore.getState().rootPanel).flatMap((leaf) => leaf.tabs);
}

describe("useSpawnRequests — container spawn wiring (#1446)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    emit = undefined;
    resolveContainerSpawn.mockReset();
    resolveContainerSpawn.mockResolvedValue(SAMPLE_SPAWN);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useSpawnRequests();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // The subscription is set up asynchronously inside an effect.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("resolves a container spawn with the request args", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest());
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).toHaveBeenCalledWith("/home/user/app", "alpine:3", "/workspace");
  });

  it("opens a Docker tab with the resolved settings and title, marked spawned", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest());
      await Promise.resolve();
    });

    const tab = allTabs().find((t) => t.spawned);
    expect(tab).toBeDefined();
    expect(tab?.connectionType).toBe("docker");
    expect(tab?.config.type).toBe("docker");
    expect(tab?.config.config).toEqual(SAMPLE_SPAWN.settings);
    expect(tab?.title).toBe(SAMPLE_SPAWN.title);
    expect(tab?.spawned).toBe(true);
  });

  it("shows a confirmation toast on a successful spawn", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest());
      await Promise.resolve();
    });

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.success).mock.calls[0][0])).toContain("/home/user/app");
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("surfaces a recoverable error toast when resolution fails", async () => {
    resolveContainerSpawn.mockRejectedValue("no such location");
    await mountHook();

    await act(async () => {
      emit!(containerRequest());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("no such location");
    expect(allTabs().some((t) => t.spawned)).toBe(false);
  });

  it("ignores a non-container spawn (SI-2 owns local/WSL/SSH)", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app" });
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(allTabs().some((t) => t.spawned)).toBe(false);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    await mountHook();
    act(() => root.unmount());
    // Re-create the root so afterEach's unmount is a no-op.
    root = createRoot(container);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("useSpawnRequests — kind discriminator (#1465)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    emit = undefined;
    resolveContainerSpawn.mockReset();
    resolveContainerSpawn.mockResolvedValue(SAMPLE_SPAWN);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mountHook(): Promise<void> {
    function Harness() {
      useSpawnRequests();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("routes an explicit container kind to the resolver", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest({ kind: "container" }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).toHaveBeenCalledWith("/home/user/app", "alpine:3", "/workspace");
  });

  it("ignores an explicit local/WSL/SSH kind even when container fields are present", async () => {
    await mountHook();

    // Container fields present but the authoritative kind says local → SI-2's
    // job, not ours. The explicit discriminator wins over field presence.
    await act(async () => {
      emit!(containerRequest({ kind: "local" }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(allTabs().some((t) => t.spawned)).toBe(false);
  });

  it("falls back to presence inference for an auto kind (container)", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest({ kind: "auto" }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).toHaveBeenCalledWith("/home/user/app", "alpine:3", "/workspace");
  });

  it("falls back to presence inference for an auto kind (non-container)", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app", kind: "auto" });
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(allTabs().some((t) => t.spawned)).toBe(false);
  });

  it("unsubscribes on unmount", async () => {
    await mountHook();
    act(() => root.unmount());
    // Re-create the root so afterEach's unmount is a no-op.
    root = createRoot(container);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
