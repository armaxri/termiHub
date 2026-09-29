/**
 * Repointing a tunnel whose SSH connection was deleted (#2850).
 *
 * The backend keeps such a tunnel in the `missingConnection` state; the editor
 * must flag the deleted connection on the SSH field and let the user choose
 * another one — saving the new id resolves the tunnel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-missing";
const PANEL_ID = "panel-tun-missing";

function ssh(id: string, name: string): SavedConnection {
  return {
    id,
    name,
    config: { type: "ssh", config: { host: `${id}-host`, username: "u" } },
    folderId: null,
  };
}

const ORPHANED: TunnelConfig = {
  id: "tun-missing",
  name: "Orphaned",
  sshConnectionId: "deleted-ssh",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "localhost", remotePort: 80 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: ORPHANED.id }} isVisible={true} />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function sshFieldError(): string | null {
  return (
    q("tunnel-editor-ssh-connection-field")?.querySelector('[role="alert"]')?.textContent ?? null
  );
}

function pickSshConnection(label: string) {
  const trigger = q("tunnel-editor-ssh-connection") as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => o.textContent === label
  ) as HTMLElement | undefined;
  expect(option).toBeTruthy();
  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

setupConnectionsRegion();

describe("TunnelEditor — SSH connection deleted (#2850)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [ORPHANED],
      tunnelStates: {
        [ORPHANED.id]: {
          tunnelId: ORPHANED.id,
          status: "missingConnection",
          stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
        },
      },
      saveTunnel: vi.fn(() => Promise.resolve()),
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
    });
    seedLayoutState({
      rootPanel: {
        type: "leaf",
        id: PANEL_ID,
        tabs: [{ id: TAB_ID }],
        activeTabId: TAB_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    seedConnectionsRegion({ connections: [ssh("web", "web"), ssh("db", "db")] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("flags the deleted SSH connection", async () => {
    await render();
    expect(sshFieldError()).toBe(t("tunnel.editor.missingConnection"));
  });

  it("repoints the tunnel at the chosen SSH connection", async () => {
    await render();
    pickSshConnection("web");
    await flush();
    expect(sshFieldError()).toBeNull();

    act(() => {
      q("tunnel-editor-save")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const save = vi.mocked(useAppStore.getState().saveTunnel);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ id: ORPHANED.id, sshConnectionId: "web" });
  });

  it("does not flag a tunnel whose SSH connection exists", async () => {
    useAppStore.setState({ tunnels: [{ ...ORPHANED, sshConnectionId: "db" }] });
    await render();
    expect(sshFieldError()).toBeNull();
  });
});
