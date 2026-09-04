import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Settable callbacks the mocked subscriptions hand their event streams to, so
// tests can drive `spawn-request` / `spawn-picker-requested` events directly
// (mirrors useTransferEvents).
let emit: ((payload: SpawnRequestPayload) => void) | undefined;
let emitPicker: ((payload: SpawnRequestPayload) => void) | undefined;
const unlisten = vi.fn();
const unlistenPicker = vi.fn();

vi.mock("@/services/events", () => ({
  onSpawnRequest: vi.fn((cb: (payload: SpawnRequestPayload) => void) => {
    emit = cb;
    return Promise.resolve(unlisten);
  }),
  onSpawnPickerRequested: vi.fn((cb: (payload: SpawnRequestPayload) => void) => {
    emitPicker = cb;
    return Promise.resolve(unlistenPicker);
  }),
}));

const resolveContainerSpawn = vi.fn();
const resolveShellSpawn = vi.fn();
const takePendingSpawn = vi.fn();
const rememberSpawnChoice = vi.fn();
vi.mock("@/services/api", () => ({
  resolveContainerSpawn: (
    location: string,
    entryId?: string,
    image?: string,
    mount?: string,
    runtime?: string
  ) => resolveContainerSpawn(location, entryId, image, mount, runtime),
  resolveShellSpawn: (
    location?: string,
    connection?: string,
    entryId?: string,
    kind?: string,
    shell?: string
  ) => resolveShellSpawn(location, connection, entryId, kind, shell),
  takePendingSpawn: () => takePendingSpawn(),
  rememberSpawnChoice: (entryId: string, target: unknown) => rememberSpawnChoice(entryId, target),
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
import { applySpawnChoice, useSpawnChoiceHandler, useSpawnRequests } from "./useSpawnRequests";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { getAllLeaves } from "@/utils/panelTree";
import type { SpawnRequestPayload } from "@/services/events";
import type { SpawnChoice } from "@/types/spawn";
import type { ContainerSpawn, ShellSpawn } from "@/services/api";
import type { TerminalTab } from "@/types/terminal";
import { layoutState } from "@/test/layoutState";

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
  return getAllLeaves(layoutState().rootPanel).flatMap((leaf) => leaf.tabs);
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
      "/workspace",
      undefined
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
      "/workspace",
      undefined
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
      "/workspace",
      undefined
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
    expect(resolveShellSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      undefined,
      "local",
      undefined
    );
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
      "/workspace",
      undefined
    );
  });

  it("falls back to presence inference for an auto kind (non-container → shell)", async () => {
    await mountHook();

    await act(async () => {
      emit!({ location: "/home/user/app", kind: "auto" });
      await Promise.resolve();
    });

    expect(resolveContainerSpawn).not.toHaveBeenCalled();
    expect(resolveShellSpawn).toHaveBeenCalledWith(
      "/home/user/app",
      undefined,
      undefined,
      "auto",
      undefined
    );
    expect(allTabs().find((t) => t.spawned)?.connectionType).toBe("local");
  });

  // ---- Session Picker routing (SI-3, #1366) ------------------------------

  it("raises the picker instead of spawning when a picker request arrives", async () => {
    await mountHook();

    await act(async () => {
      emitPicker!({ location: "/home/user/app", pick: true });
      await Promise.resolve();
    });

    // The whole point of --pick: decide first, resolve nothing yet.
    expect(useAppStore.getState().spawnPickerVisible).toBe(true);
    expect(useAppStore.getState().spawnPickerRequest?.location).toBe("/home/user/app");
    expect(resolveShellSpawn).not.toHaveBeenCalled();
    expect(resolveContainerSpawn).not.toHaveBeenCalled();
  });

  it("routes a drained cold-start pending spawn on its own pick flag", async () => {
    // The cold-start path hands over the request itself, not the event that
    // would have classified it, so `pick` has to be honored here too.
    takePendingSpawn.mockResolvedValue({ location: "/home/user/app", pick: true });
    await mountHook();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().spawnPickerVisible).toBe(true);
    expect(resolveShellSpawn).not.toHaveBeenCalled();
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

describe("useSpawnRequests — WSL/SSH backend wiring (#1511)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const WSL_SPAWN: ShellSpawn = {
    type: "wsl",
    settings: { distribution: "Ubuntu", startingDirectory: "/mnt/c/Users/foo/app" },
    title: "app (Spawned)",
    spawned: true,
    missing: false,
  };

  const SSH_SPAWN: ShellSpawn = {
    type: "ssh",
    settings: { host: "example.com", port: 22, username: "me" },
    title: "Web (Spawned)",
    spawned: true,
    missing: false,
    cdPath: "/srv/app",
  };

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
      await Promise.resolve();
    });
  }

  it("opens a WSL distribution tab with the resolved distro + startingDirectory", async () => {
    resolveShellSpawn.mockResolvedValue(WSL_SPAWN);
    await mountHook();

    await act(async () => {
      emit!({ location: "C:\\Users\\foo\\app", kind: "wsl" });
      await Promise.resolve();
    });

    expect(resolveShellSpawn).toHaveBeenCalledWith(
      "C:\\Users\\foo\\app",
      undefined,
      undefined,
      "wsl",
      undefined
    );
    const tab = allTabs().find((t) => t.spawned);
    expect(tab?.connectionType).toBe("wsl");
    expect(tab?.config.type).toBe("wsl");
    expect(tab?.config.config).toEqual(WSL_SPAWN.settings);
    // WSL uses a real starting directory, not a post-connect cd.
    expect(tab?.initialCommand).toBeUndefined();
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("opens an SSH tab from the saved connection and cd's into the target after connect", async () => {
    resolveShellSpawn.mockResolvedValue(SSH_SPAWN);
    await mountHook();

    await act(async () => {
      emit!({ location: "/srv/app", connection: "Prod/Web", kind: "ssh" });
      await Promise.resolve();
    });

    expect(resolveShellSpawn).toHaveBeenCalledWith(
      "/srv/app",
      "Prod/Web",
      undefined,
      "ssh",
      undefined
    );
    const tab = allTabs().find((t) => t.spawned);
    expect(tab?.connectionType).toBe("ssh");
    expect(tab?.config.type).toBe("ssh");
    expect(tab?.config.config).toEqual(SSH_SPAWN.settings);
    // SSH has no start cwd → cd runs after connect via the tab's initialCommand.
    expect(tab?.initialCommand).toBe("cd '/srv/app'");
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error toast when SSH resolution fails (unknown connection)", async () => {
    resolveShellSpawn.mockRejectedValue("SSH connection 'nope' not found");
    await mountHook();

    await act(async () => {
      emit!({ location: "/srv/app", connection: "nope", kind: "ssh" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain("not found");
    expect(allTabs().some((t) => t.spawned)).toBe(false);
  });
});

describe("applySpawnChoice — folding a picker choice back into its request (SI-3, #1366)", () => {
  const REQUEST: SpawnRequestPayload = {
    location: "/home/user/app",
    entry_id: "entry-1",
    pick: true,
    kind: "auto",
  };

  it("pins the local kind and the picked shell", () => {
    const { request, picked } = applySpawnChoice(REQUEST, {
      target: { kind: "local", shell: "zsh" },
      newWindow: false,
      remember: false,
    });

    // The pick is explicit now, so the `auto` inference must not re-guess it.
    expect(request.kind).toBe("local");
    expect(picked).toEqual({ shell: "zsh" });
    // The request's own context survives the fold.
    expect(request.location).toBe("/home/user/app");
    expect(request.entry_id).toBe("entry-1");
  });

  it("pins the wsl kind and carries the distribution as the picked shell", () => {
    const { request, picked } = applySpawnChoice(REQUEST, {
      target: { kind: "wsl", distro: "Ubuntu-22.04" },
      newWindow: false,
      remember: false,
    });

    expect(request.kind).toBe("wsl");
    expect(picked).toEqual({ shell: "Ubuntu-22.04" });
  });

  it("pins the container kind with its image, mount and runtime", () => {
    const { request, picked } = applySpawnChoice(REQUEST, {
      target: { kind: "container", runtime: "podman", image: "alpine:3", mount: "/src" },
      newWindow: false,
      remember: false,
    });

    expect(request.kind).toBe("container");
    expect(request.container_image).toBe("alpine:3");
    expect(request.container_mount).toBe("/src");
    expect(picked).toEqual({ runtime: "podman" });
  });

  it("applies the picker's new-window toggle over the request's", () => {
    const { request } = applySpawnChoice(
      { ...REQUEST, new_window: false },
      { target: { kind: "local", shell: "bash" }, newWindow: true, remember: false }
    );

    expect(request.new_window).toBe(true);
  });
});

describe('useSpawnChoiceHandler — persisting "Remember this choice" (#1561)', () => {
  /** Render the hook and hand back its confirm handler. */
  function choiceHandler(): (req: SpawnRequestPayload, choice: SpawnChoice) => Promise<void> {
    let handler!: ReturnType<typeof useSpawnChoiceHandler>;
    function Probe() {
      handler = useSpawnChoiceHandler();
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      createRoot(host).render(React.createElement(Probe));
    });
    return handler;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    rememberSpawnChoice.mockResolvedValue(undefined);
    resolveShellSpawn.mockResolvedValue(SAMPLE_SHELL_SPAWN);
    resolveContainerSpawn.mockResolvedValue(SAMPLE_SPAWN);
  });

  const REQ: SpawnRequestPayload = { location: "/proj", entry_id: "open", pick: true };

  it("saves the picked local shell onto the triggering entry", async () => {
    const handler = choiceHandler();

    await act(async () => {
      await handler(REQ, {
        target: { kind: "local", shell: "fish" },
        newWindow: false,
        remember: true,
      });
    });

    expect(rememberSpawnChoice).toHaveBeenCalledWith("open", { kind: "local", shell: "fish" });
  });

  it("saves the picked container runtime, image and mount", async () => {
    const handler = choiceHandler();

    await act(async () => {
      await handler(REQ, {
        target: { kind: "container", runtime: "podman", image: "alpine:3", mount: "/workspace" },
        newWindow: false,
        remember: true,
      });
    });

    expect(rememberSpawnChoice).toHaveBeenCalledWith("open", {
      kind: "container",
      runtime: "podman",
      image: "alpine:3",
      mount: "/workspace",
    });
  });

  it("saves the picked WSL distribution", async () => {
    const handler = choiceHandler();

    await act(async () => {
      await handler(REQ, {
        target: { kind: "wsl", distro: "Ubuntu-22.04" },
        newWindow: false,
        remember: true,
      });
    });

    expect(rememberSpawnChoice).toHaveBeenCalledWith("open", {
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
  });

  it("saves nothing when the box is left unticked", async () => {
    const handler = choiceHandler();

    await act(async () => {
      await handler(REQ, {
        target: { kind: "local", shell: "fish" },
        newWindow: false,
        remember: false,
      });
    });

    expect(rememberSpawnChoice).not.toHaveBeenCalled();
  });

  // A bare `termiHub spawn --pick` from a terminal has no entry to remember onto.
  it("saves nothing when the spawn came from no context-menu entry", async () => {
    const handler = choiceHandler();

    await act(async () => {
      await handler(
        { location: "/proj", pick: true },
        { target: { kind: "local", shell: "fish" }, newWindow: false, remember: true }
      );
    });

    expect(rememberSpawnChoice).not.toHaveBeenCalled();
  });

  // Remembering is a side effect of the spawn, never a precondition for it.
  it("still opens the session when remembering fails", async () => {
    rememberSpawnChoice.mockRejectedValue(new Error("disk full"));
    const handler = choiceHandler();

    await act(async () => {
      await handler(REQ, {
        target: { kind: "local", shell: "fish" },
        newWindow: false,
        remember: true,
      });
    });

    expect(resolveShellSpawn).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("could not remember"));
  });
});
