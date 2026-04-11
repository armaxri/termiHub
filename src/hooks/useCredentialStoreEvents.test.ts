import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/services/events", () => ({
  onCredentialStoreLocked: vi.fn(),
  onCredentialStoreUnlocked: vi.fn(),
  onCredentialStoreStatusChanged: vi.fn(),
  onCredentialStoreUnlockNeeded: vi.fn(),
}));

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
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getCredentialStoreStatus: vi.fn(() => Promise.resolve({ mode: "none", status: "unlocked" })),
}));

import {
  onCredentialStoreLocked,
  onCredentialStoreUnlocked,
  onCredentialStoreStatusChanged,
  onCredentialStoreUnlockNeeded,
} from "@/services/events";
import { useAppStore } from "@/store/appStore";
import { useCredentialStoreEvents } from "./useCredentialStoreEvents";

const mockOnLocked = vi.mocked(onCredentialStoreLocked);
const mockOnUnlocked = vi.mocked(onCredentialStoreUnlocked);
const mockOnStatusChanged = vi.mocked(onCredentialStoreStatusChanged);
const mockOnUnlockNeeded = vi.mocked(onCredentialStoreUnlockNeeded);

function HookConsumer() {
  useCredentialStoreEvents();
  return null;
}

describe("useCredentialStoreEvents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let lockedHandler: (() => void) | undefined;
  let unlockedHandler: (() => void) | undefined;
  let statusChangedHandler: ((status: unknown) => void) | undefined;
  let unlockNeededHandler: (() => void) | undefined;
  const unlistenLocked = vi.fn();
  const unlistenUnlocked = vi.fn();
  const unlistenStatusChanged = vi.fn();
  const unlistenUnlockNeeded = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());

    mockOnLocked.mockImplementation((cb) => {
      lockedHandler = cb;
      return Promise.resolve(unlistenLocked);
    });
    mockOnUnlocked.mockImplementation((cb) => {
      unlockedHandler = cb;
      return Promise.resolve(unlistenUnlocked);
    });
    mockOnStatusChanged.mockImplementation((cb) => {
      statusChangedHandler = cb as (status: unknown) => void;
      return Promise.resolve(unlistenStatusChanged);
    });
    mockOnUnlockNeeded.mockImplementation((cb) => {
      unlockNeededHandler = cb;
      return Promise.resolve(unlistenUnlockNeeded);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("registers all four event listeners on mount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    expect(mockOnLocked).toHaveBeenCalledTimes(1);
    expect(mockOnUnlocked).toHaveBeenCalledTimes(1);
    expect(mockOnStatusChanged).toHaveBeenCalledTimes(1);
    expect(mockOnUnlockNeeded).toHaveBeenCalledTimes(1);
  });

  it("does NOT open unlock dialog when locked event fires (auto-lock is silent)", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(false);

    await act(async () => {
      lockedHandler?.();
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
  });

  it("opens unlock dialog when unlock-needed event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(false);

    await act(async () => {
      unlockNeededHandler?.();
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(true);
  });

  it("closes unlock dialog when unlocked event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    // Open it via the unlock-needed event (demand-driven)
    await act(async () => {
      unlockNeededHandler?.();
    });
    expect(useAppStore.getState().unlockDialogOpen).toBe(true);

    // Then close it when the store is unlocked
    await act(async () => {
      unlockedHandler?.();
    });

    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
  });

  it("resolves requestUnlock() with true when unlocked event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    // Capture the promise without awaiting — it will resolve once the unlock event fires
    const unlockPromise = useAppStore.getState().requestUnlock();

    // Simulate successful unlock from backend
    await act(async () => {
      unlockedHandler?.();
    });

    const result = await unlockPromise;
    expect(result).toBe(true);
    expect(useAppStore.getState().unlockDialogOpen).toBe(false);
    expect(useAppStore.getState().unlockResolve).toBeNull();
  });

  it("resolves requestUnlock() with false when dialog is closed without unlock", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    // Capture the promise without awaiting
    const unlockPromise = useAppStore.getState().requestUnlock();

    // Simulate the user closing the dialog without unlocking
    await act(async () => {
      useAppStore.getState().setUnlockDialogOpen(false);
    });

    const result = await unlockPromise;
    expect(result).toBe(false);
    expect(useAppStore.getState().unlockResolve).toBeNull();
  });

  it("updates credential store status when status-changed event fires", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    const newStatus = { mode: "master_password", status: "locked" };
    await act(async () => {
      statusChangedHandler?.(newStatus);
    });

    expect(useAppStore.getState().credentialStoreStatus).toEqual(newStatus);
  });

  it("unsubscribes all listeners on unmount", async () => {
    await act(async () => {
      root.render(createElement(HookConsumer));
    });

    act(() => root.unmount());
    // Create a fresh root to avoid afterEach double-unmount
    root = createRoot(container);

    expect(unlistenLocked).toHaveBeenCalledTimes(1);
    expect(unlistenUnlocked).toHaveBeenCalledTimes(1);
    expect(unlistenStatusChanged).toHaveBeenCalledTimes(1);
    expect(unlistenUnlockNeeded).toHaveBeenCalledTimes(1);
  });
});
