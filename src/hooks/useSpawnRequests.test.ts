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
const resolveShellSpawn = vi.fn();
const takePendingSpawn = vi.fn();
vi.mock("@/services/api", () => ({
  resolveContainerSpawn: (location: string, entryId?: string, image?: string, mount?: string) =>
    resolveContainerSpawn(location, entryId, image, mount),
  resolveShellSpawn: (location?: string, connection?: string, entryId?: string, kind?: string) =>
    resolveShellSpawn(location, connection, entryId, kind),
  takePendingSpawn: () => takePendingSpawn(),
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
import type { ContainerSpawn, ShellSpawn } from "@/services/api";
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

const SAMPLE_SHELL_SPAWN: ShellSpawn = {
  settings: { startingDirectory: "/home/user/app", shellIntegration: true },
  title: "app (Spawned)",
  spawned: true,
  missing: false,
};

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
    resolveShellSpawn.mockReset();
    resolveShellSpawn.mockResolvedValue(SAMPLE_SHELL_SPAWN);
    takePendingSpawn.mockReset();
    takePendingSpawn.mockResolvedValue(null);
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

    expect(resolveContainerSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      "alpine:3",
      "/workspace"
    );
  });

  it("forwards the triggering entry_id so a saved preference can be honored (#1447)", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest({ entry_id: "entry-1", container_image: undefined }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      "entry-1",
      undefined,
      "/workspace"
    );
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

  it("opens a shell tab for a non-container spawn (SI-2 local/WSL/SSH)", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app" });
      await Promise.resolve();
    });

    // A non-container spawn is routed to the shell resolver, not the container one.
    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(resolveShellSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      undefined,
      undefined
    );
    const tab = allTabs().find((t) => t.spawned);
    expect(tab?.connectionType).toBe("local");
    expect(tab?.config.type).toBe("local");
    expect(tab?.config.config).toEqual(SAMPLE_SHELL_SPAWN.settings);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
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
    resolveShellSpawn.mockReset();
    resolveShellSpawn.mockResolvedValue(SAMPLE_SHELL_SPAWN);
    takePendingSpawn.mockReset();
    takePendingSpawn.mockResolvedValue(null);
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

    expect(resolveContainerSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      "alpine:3",
      "/workspace"
    );
  });

  it("routes an explicit local kind to the shell resolver even when container fields are present", async () => {
    await mountHook();

    // Container fields present but the authoritative kind says local → SI-2's
    // shell open path, not the container one. The discriminator wins over
    // field presence.
    await act(async () => {
      emit!(containerRequest({ kind: "local" }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(resolveShellSpawn).toHaveBeenCalledWith("/home/user/app", undefined, undefined, "local");
    expect(allTabs().find((t) => t.spawned)?.connectionType).toBe("local");
  });

  it("falls back to presence inference for an auto kind (container)", async () => {
    await mountHook();

    await act(async () => {
      emit!(containerRequest({ kind: "auto" }));
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      "alpine:3",
      "/workspace"
    );
  });

  it("falls back to presence inference for an auto kind (non-container → shell)", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app", kind: "auto" });
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(resolveShellSpawn).toHaveBeenCalledWith("/home/user/app", undefined, undefined, "auto");
    expect(allTabs().find((t) => t.spawned)?.connectionType).toBe("local");
  });

  it("unsubscribes on unmount", async () => {
    await mountHook();
    act(() => root.unmount());
    // Re-create the root so afterEach's unmount is a no-op.
    root = createRoot(container);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("useSpawnRequests — shell spawn wiring (#1365, SI-2)", () => {
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
    resolveShellSpawn.mockReset();
    resolveShellSpawn.mockResolvedValue(SAMPLE_SHELL_SPAWN);
    takePendingSpawn.mockReset();
    takePendingSpawn.mockResolvedValue(null);
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
    // Two microtask flushes: subscribe, then drain the pending spawn.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("opens a shell tab at the resolved directory and confirms with a toast", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app", kind: "local" });
      await Promise.resolve();
    });

    const tab = allTabs().find((t) => t.spawned);
    expect(tab?.connectionType).toBe("local");
    expect(tab?.config.config).toEqual(SAMPLE_SHELL_SPAWN.settings);
    expect(tab?.title).toBe(SAMPLE_SHELL_SPAWN.title);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("warns with an info toast when the target path was missing", async () => {
    resolveShellSpawn.mockResolvedValue({
      ...SAMPLE_SHELL_SPAWN,
      settings: { startingDirectory: "/home/user", shellIntegration: true },
      missing: true,
    });
    await mountHook();

    await act(async () => {
      emit!({ location: "/no/such/dir", kind: "local" });
      await Promise.resolve();
    });

    expect(allTabs().some((t) => t.spawned)).toBe(true);
    expect(vi.mocked(toast.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("surfaces a recoverable error toast when shell resolution fails", async () => {
    resolveShellSpawn.mockRejectedValue("boom");
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app", kind: "local" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("boom");
    expect(allTabs().some((t) => t.spawned)).toBe(false);
  });

  it("drains and opens a cold-start pending spawn once subscribed", async () => {
    // A spawn parked before the UI was ready is picked up via take_pending_spawn.
    takePendingSpawn.mockResolvedValue({ location: "/home/user/app", kind: "local" });
    await mountHook();

    expect(takePendingSpawn).toHaveBeenCalledTimes(1);
    const tab = allTabs().find((t) => t.spawned);
    expect(tab?.connectionType).toBe("local");
    expect(tab?.config.config).toEqual(SAMPLE_SHELL_SPAWN.settings);
  });
});
