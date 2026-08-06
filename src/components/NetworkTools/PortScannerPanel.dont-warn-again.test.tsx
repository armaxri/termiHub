/**
 * Tests for the Port Scanner large-scan warning "Don't warn again" opt-out
 * (#1877). The warning already migrated onto the shared ConfirmDialog primitive
 * (#1876); this covers persisting and honouring the opt-out.
 *
 * Covers: confirming with the checkbox ticked persists
 * `warnLargePortScan: false`; once opted out, the next large scan starts
 * directly without the warning; cancelling does not persist the opt-out; and
 * re-enabling the setting brings the warning back.
 */
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

// The store's updateSettings persists via the storage service — mock it so the
// optimistic store update lands without touching a real Tauri backend.
vi.mock("@/services/storage", async () => {
  const actual = await vi.importActual<typeof import("@/services/storage")>("@/services/storage");
  return { ...actual, saveSettings: vi.fn(() => Promise.resolve()) };
});

vi.mock("@/services/networkApi", () => ({
  networkPortScan: vi.fn(() => Promise.resolve("task-1")),
  networkPortScanCancel: vi.fn(() => Promise.resolve()),
  onScanResult: vi.fn(() => Promise.resolve(() => {})),
  onScanComplete: vi.fn(() => Promise.resolve(() => {})),
  onScanError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { networkPortScan, onScanComplete } from "@/services/networkApi";
import { currentSettingsView } from "@/store/settingsBridge";
import { PortScannerPanel } from "./PortScannerPanel";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Query into the modal, which Radix portals onto document.body. */
function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

async function renderPanel() {
  await act(async () => {
    root.render(<PortScannerPanel prefillHost="192.168.1.1" />);
  });
  await flush();
}

async function setPorts(value: string) {
  await act(async () => {
    setInputValue(
      container.querySelector<HTMLInputElement>('[data-testid="port-scanner-ports"]')!,
      value
    );
  });
  await flush();
}

async function clickRun() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="port-scanner-run"]')!.click();
  });
  await flush();
}

async function click(selector: string) {
  await act(async () => {
    q<HTMLButtonElement>(selector)!.click();
  });
  await flush();
}

/**
 * Drive the running scan to completion via the captured onScanComplete handler
 * so the panel leaves the "running" state and the Start button reappears.
 */
async function completeScan() {
  const calls = vi.mocked(onScanComplete).mock.calls;
  const handler = calls[calls.length - 1][0] as (p: {
    taskId: string;
    summary: {
      total: number;
      open: number;
      closed: number;
      filtered: number;
      elapsedMs: number;
    };
  }) => void;
  await act(async () => {
    handler({
      taskId: "task-1",
      summary: { total: 2000, open: 1, closed: 1998, filtered: 1, elapsedMs: 1000 },
    });
  });
  await flush();
}

setupSettingsRegion();

describe("PortScannerPanel — large-scan don't-warn-again opt-out (#1877)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Reset the persisted preference to the default (warn on) before each test.
    seedSettings({ warnLargePortScan: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("persists warnLargePortScan: false when confirmed with the box ticked", async () => {
    await renderPanel();
    await setPorts("1-2000");
    await clickRun();

    // Tick the "don't warn again" checkbox, then confirm.
    await click('[data-testid="port-scan-warn-dont-ask-again"]');
    await click('[data-testid="port-scan-warn-confirm"]');

    expect(currentSettingsView().warnLargePortScan).toBe(false);
    expect(networkPortScan).toHaveBeenCalledTimes(1);
  });

  it("skips the warning on the next large scan once opted out", async () => {
    await renderPanel();
    await setPorts("1-2000");
    await clickRun();
    await click('[data-testid="port-scan-warn-dont-ask-again"]');
    await click('[data-testid="port-scan-warn-confirm"]');
    expect(networkPortScan).toHaveBeenCalledTimes(1);
    await completeScan();

    // A second large scan must start directly, with no warning modal.
    await clickRun();
    expect(q('[data-testid="port-scan-warn-modal"]')).toBeNull();
    expect(networkPortScan).toHaveBeenCalledTimes(2);
  });

  it("does not persist the opt-out when the warning is cancelled", async () => {
    await renderPanel();
    await setPorts("1-2000");
    await clickRun();

    // Tick the box but cancel — the preference must stay unchanged.
    await click('[data-testid="port-scan-warn-dont-ask-again"]');
    await click('[data-testid="port-scan-warn-cancel"]');

    expect(currentSettingsView().warnLargePortScan).toBe(true);
    expect(networkPortScan).not.toHaveBeenCalled();

    // The next large scan still warns (opt-out was discarded on cancel).
    await clickRun();
    expect(q('[data-testid="port-scan-warn-modal"]')).not.toBeNull();
  });

  it("warns again once the setting is re-enabled", async () => {
    // Start opted out (e.g. re-enabling from General settings sets this true).
    seedSettings({ warnLargePortScan: false });
    await renderPanel();
    await setPorts("1-2000");
    await clickRun();
    // Opted out → scan runs immediately, no modal.
    expect(q('[data-testid="port-scan-warn-modal"]')).toBeNull();
    expect(networkPortScan).toHaveBeenCalledTimes(1);
    await completeScan();

    // Re-enable the warning, as the General settings toggle would.
    act(() => {
      seedSettings({ warnLargePortScan: true });
    });
    await flush();
    await clickRun();
    expect(q('[data-testid="port-scan-warn-modal"]')).not.toBeNull();
  });
});
