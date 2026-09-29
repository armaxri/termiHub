/**
 * A tunnel whose SSH connection was deleted (#2850).
 *
 * The backend keeps the tunnel, stops it if it ran, and projects the
 * `missingConnection` status. The sidebar row must say so, must not offer to
 * start it, and must offer to choose another SSH connection (open the editor).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelListItem } from "./TunnelListItem";
import { withTooltip } from "@/test/tooltip";
import { t } from "@/i18n/catalog";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";
import type { SavedConnection } from "@/types/connection";

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "My Tunnel",
  sshConnectionId: "deleted-ssh",
  autoStart: false,
  reconnectOnDisconnect: false,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "example.com", remotePort: 80 },
  },
};

function stateOf(status: TunnelStatus): TunnelState {
  return {
    tunnelId: "tun-1",
    status,
    stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
  };
}

const noop = () => {};
let container: HTMLDivElement;
let root: Root;

function renderItem(
  status: TunnelStatus,
  handlers: Partial<{ onStart: (id: string) => void; onEdit: (id: string) => void }> = {}
): void {
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={stateOf(status)}
          connections={[] as SavedConnection[]}
          onStart={handlers.onStart ?? noop}
          onStop={noop}
          onReconnect={noop}
          onEdit={handlers.onEdit ?? noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

describe("TunnelListItem — SSH connection deleted (#2850)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says the SSH connection was deleted", () => {
    renderItem("missingConnection");
    const notice = q("tunnel-missing-connection-tun-1");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(t("tunnel.missingConnection.detail"));
    expect(q("tunnel-status-tun-1")?.getAttribute("aria-label")).toBe(
      t("tunnel.missingConnection.status")
    );
  });

  it("does not offer to start, stop or retry the tunnel", () => {
    renderItem("missingConnection");
    expect(q("tunnel-start-tun-1")).toBeNull();
    expect(q("tunnel-stop-tun-1")).toBeNull();
    expect(q("tunnel-retry-tun-1")).toBeNull();
  });

  it("opens the editor to choose another SSH connection", () => {
    const onEdit = vi.fn();
    renderItem("missingConnection", { onEdit });
    const choose = q("tunnel-choose-connection-tun-1") as HTMLButtonElement;
    expect(choose.textContent).toBe(t("tunnel.missingConnection.choose"));
    act(() => {
      choose.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onEdit).toHaveBeenCalledWith("tun-1");
  });

  it("shows no notice once the tunnel is resolved", () => {
    renderItem("disconnected");
    expect(q("tunnel-missing-connection-tun-1")).toBeNull();
    expect(q("tunnel-start-tun-1")).not.toBeNull();
  });
});
