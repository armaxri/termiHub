/**
 * Tests for the "X Servers" section of the Open Connections panel (#1053):
 * the single shared X server is surfaced only when live (managed-running or
 * adopted-external). A managed server can be stopped via x_server_stop; an
 * adopted external server exposes no Stop control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { XServerStatusReport } from "@/types/xserver";

const xServerStatus = vi.fn<() => Promise<XServerStatusReport>>();
const xServerStop = vi.fn(() => Promise.resolve());
vi.mock("@/services/api", () => ({
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  xServerStatus: () => xServerStatus(),
  xServerStop: () => xServerStop(),
  xServerEnsure: vi.fn(() => Promise.resolve()),
  xServerInstallDependency: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/events", () => ({
  onXServerProgress: vi.fn(() => Promise.resolve(() => {})),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

/** Flush the async loadData (Promise.all) and its resulting state update. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OpenConnectionsModal — X Servers section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    xServerStatus.mockReset();
    xServerStop.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flush();
  }

  it("lists a managed running X server and stops it via x_server_stop", async () => {
    xServerStatus.mockResolvedValue({
      state: "running",
      platform: "windows",
      displayNumber: 0,
      managed: true,
      sessionCount: 0,
    });
    await renderModal();

    const section = document.querySelector('[data-testid="open-connections-x-servers-section"]');
    expect(section).not.toBeNull();

    const row = document.querySelector('[data-testid="open-connections-x-server-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("VcXsrv");
    expect(row?.textContent).toContain("display :0");
    expect(row?.querySelector(".oc-row__badge--managed")).not.toBeNull();

    const stopBtn = document.querySelector(
      '[data-testid="open-connections-x-server-stop"]'
    ) as HTMLButtonElement;
    expect(stopBtn).not.toBeNull();

    await act(async () => {
      stopBtn.click();
      await Promise.resolve();
    });
    await flush();

    expect(xServerStop).toHaveBeenCalledTimes(1);
    // Optimistically removed → row and section disappear.
    expect(document.querySelector('[data-testid="open-connections-x-server-row"]')).toBeNull();
  });

  it("shows the dependent session count next to the display", async () => {
    xServerStatus.mockResolvedValue({
      state: "running",
      platform: "windows",
      displayNumber: 0,
      managed: true,
      sessionCount: 2,
    });
    await renderModal();

    const row = document.querySelector('[data-testid="open-connections-x-server-row"]');
    expect(row?.textContent).toContain("display :0");
    expect(row?.textContent).toContain("2 sessions");
  });

  it("uses the singular form for a single dependent session", async () => {
    xServerStatus.mockResolvedValue({
      state: "adopted",
      platform: "linux",
      displayNumber: 0,
      managed: false,
      sessionCount: 1,
    });
    await renderModal();

    const row = document.querySelector('[data-testid="open-connections-x-server-row"]');
    expect(row?.textContent).toContain("1 session");
    expect(row?.textContent).not.toContain("1 sessions");
  });

  it("omits the session count when zero sessions depend on the server", async () => {
    xServerStatus.mockResolvedValue({
      state: "running",
      platform: "windows",
      displayNumber: 0,
      managed: true,
      sessionCount: 0,
    });
    await renderModal();

    const row = document.querySelector('[data-testid="open-connections-x-server-row"]');
    expect(row?.textContent).toContain("display :0");
    expect(row?.textContent).not.toContain("session");
  });

  it("lists an adopted external X server with no Stop or Kill All control", async () => {
    xServerStatus.mockResolvedValue({
      state: "adopted",
      platform: "linux",
      displayNumber: 10,
      managed: false,
      sessionCount: 0,
    });
    await renderModal();

    const section = document.querySelector('[data-testid="open-connections-x-servers-section"]');
    expect(section).not.toBeNull();

    const row = document.querySelector('[data-testid="open-connections-x-server-row"]');
    expect(row?.textContent).toContain("External X server");
    expect(row?.querySelector(".oc-row__badge--external")).not.toBeNull();

    // No per-row Stop button and no bulk Kill All button in the header.
    expect(document.querySelector('[data-testid="open-connections-x-server-stop"]')).toBeNull();
    expect(section?.querySelector(".oc-section__kill-all")).toBeNull();
  });

  it("offers a Set up affordance when the server is absent and opens the setup dialog", async () => {
    xServerStatus.mockResolvedValue({
      state: "absent",
      platform: "windows",
      managed: false,
      sessionCount: 0,
    });
    await renderModal();

    // The section still renders, now with a Set up affordance instead of a row.
    const section = document.querySelector('[data-testid="open-connections-x-servers-section"]');
    expect(section).not.toBeNull();
    expect(document.querySelector('[data-testid="open-connections-x-server-row"]')).toBeNull();

    const setupBtn = document.querySelector(
      '[data-testid="open-connections-x-server-setup"]'
    ) as HTMLButtonElement;
    expect(setupBtn).not.toBeNull();

    // The dialog is not open yet.
    expect(document.querySelector('[data-testid="x-server-setup-dialog"]')).toBeNull();

    await act(async () => {
      setupBtn.click();
      await Promise.resolve();
    });
    await flush();

    // Clicking Set up opens the consent dialog.
    expect(document.querySelector('[data-testid="x-server-setup-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="x-server-setup-consent"]')).not.toBeNull();
  });
});
