/**
 * Regression tests for FEC2-005 / FES2-005 (#4375): every Tauri listener setup
 * must unregister a listener whose registration resolves only *after* the
 * effect was torn down (StrictMode's mount → unmount → mount, a fast phase
 * change). Each mocked registration stays pending until the test resolves it,
 * so the test can unmount first and then let registration complete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Pending = { resolve: () => void; unlisten: ReturnType<typeof vi.fn> };
const pending: Pending[] = [];

/** A registration that resolves to a fresh unlisten mock only when the test says so. */
function deferredRegistration(): Promise<() => void> {
  const unlisten = vi.fn();
  return new Promise((resolve) => {
    pending.push({ resolve: () => resolve(unlisten), unlisten });
  });
}

vi.mock("@/services/events", () => ({
  onAgentUpdateAvailable: vi.fn(() => deferredRegistration()),
  onRemoteAgentUpdatePending: vi.fn(() => deferredRegistration()),
  onEmbeddedServerStatusChanged: vi.fn(() => deferredRegistration()),
  onCredentialStoreLocked: vi.fn(() => deferredRegistration()),
  onCredentialStoreUnlocked: vi.fn(() => deferredRegistration()),
  onCredentialStoreStatusChanged: vi.fn(() => deferredRegistration()),
  onCredentialStoreUnlockNeeded: vi.fn(() => deferredRegistration()),
  onXServerConsentNeeded: vi.fn(() => deferredRegistration()),
  onXServerProgress: vi.fn(() => deferredRegistration()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onDragDropEvent: vi.fn(() => deferredRegistration()),
  }),
}));

const xServerEnsure = vi.fn(() => Promise.resolve({}));
vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  xServerEnsure: () => xServerEnsure(),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  frontendLog: vi.fn(),
}));

import { useAgentUpdateEvents } from "./useAgentUpdateEvents";
import { useAgentUpdatePendingEvents } from "./useAgentUpdatePendingEvents";
import { useEmbeddedServerEvents } from "./useEmbeddedServerEvents";
import { useCredentialStoreEvents } from "./useCredentialStoreEvents";
import { useOsFileDrop } from "./useOsFileDrop";
import { XServerConnectConsent } from "@/components/OpenConnections/XServerConnectConsent";
import { driveXServerEnsure } from "@/components/OpenConnections/xServerProvisioning";

function hookHost(useHook: () => void): React.FC {
  return function Host() {
    useHook();
    return null;
  };
}

function useDropHost(): void {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useOsFileDrop(ref, () => {});
}

const cases: Array<[string, React.FC]> = [
  ["useAgentUpdateEvents", hookHost(useAgentUpdateEvents)],
  ["useAgentUpdatePendingEvents", hookHost(useAgentUpdatePendingEvents)],
  ["useEmbeddedServerEvents", hookHost(useEmbeddedServerEvents)],
  ["useCredentialStoreEvents", hookHost(useCredentialStoreEvents)],
  ["useOsFileDrop", hookHost(useDropHost)],
  ["XServerConnectConsent", XServerConnectConsent],
];

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("Tauri listener disposed guard (#4375)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pending.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it.each(cases)(
    "%s unregisters every listener whose registration resolves after unmount",
    async (_name, Component) => {
      act(() => root.render(<Component />));
      // Registrations may be chained (one awaited after another); keep
      // resolving until no new one appears, unmounting before the first resolves.
      act(() => root.unmount());
      let seen = 0;
      while (seen < pending.length) {
        for (; seen < pending.length; seen++) pending[seen].resolve();
        await flush();
      }
      expect(pending.length).toBeGreaterThan(0);
      for (const p of pending) expect(p.unlisten).toHaveBeenCalledTimes(1);
    }
  );

  it("driveXServerEnsure unregisters a late progress listener and skips the ensure call", async () => {
    const dispose = driveXServerEnsure({
      onProgress: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    });
    dispose();
    pending.forEach((p) => p.resolve());
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0].unlisten).toHaveBeenCalledTimes(1);
    expect(xServerEnsure).not.toHaveBeenCalled();
  });
});
