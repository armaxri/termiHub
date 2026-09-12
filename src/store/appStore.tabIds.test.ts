import { describe, it, expect, vi } from "vitest";

// Mock service modules before importing the store (mirrors appStore.test.ts).
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
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({ monitoring: false, fileBrowser: true })),
}));

/**
 * Load a fresh, independent copy of the `appStore` module — the unit-test analog
 * of a second desktop window. Each desktop window runs its own JS context with
 * its own module-level state (its own tab-id source); `vi.resetModules()` plus a
 * fresh dynamic import reproduces exactly that isolation in one test process.
 */
async function freshWindowStore() {
  vi.resetModules();
  const mod = await import("./appStore");
  return mod.useAppStore;
}

describe("appStore — globally unique tab ids (FES-004)", () => {
  it("two independent windows mint distinct ids for their first tab", async () => {
    const windowA = await freshWindowStore();
    const windowB = await freshWindowStore();

    const idA = windowA.getState().addTab("bash", "local");
    const idB = windowB.getState().addTab("bash", "local");

    // A per-window monotonic counter both starts at 0 and hands each window's
    // first tab `tab-1`, colliding across windows. Because tab ids double as
    // cross-window / shared-region keys (persistent-session attach, hand-off,
    // projection region keys), a collision lets a cross-window operation target
    // the wrong window's tab. Globally-unique ids make that impossible.
    expect(idA).not.toBe(idB);
  });

  it("mints distinct ids for successive tabs within one window", async () => {
    const windowA = await freshWindowStore();

    const first = windowA.getState().addTab("one", "local");
    const second = windowA.getState().addTab("two", "local");

    expect(first).not.toBe(second);
  });

  it("keeps the readable `tab-` prefix so ids stay debuggable", async () => {
    const windowA = await freshWindowStore();

    const id = windowA.getState().addTab("bash", "local");

    expect(id.startsWith("tab-")).toBe(true);
  });
});
