/**
 * What a tunnel's row says while it waits, stops or cannot be reached (#6028):
 * the state in words, why, and a way out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelListItem } from "./TunnelListItem";
import { NO_CONTEXT } from "@/test/serviceContext";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "Prod DB",
  sshConnectionId: "ssh-1",
  autoStart: true,
  reconnectOnDisconnect: false,
  host: { kind: "agent", agentId: "edge" },
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
};
const WHY = "Agent Edge box is offline. It may still run there; termiHub cannot tell.";

let container: HTMLDivElement;
let root: Root;
const onStop = vi.fn();

function render(status: TunnelStatus, extra: Partial<TunnelState> = {}) {
  const state: TunnelState = {
    tunnelId: "tun-1",
    status,
    error: WHY,
    stats: { bytesSent: 9, bytesReceived: 9, activeConnections: 1, totalConnections: 1 },
    ...extra,
  };
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={state}
          context={NO_CONTEXT}
          onStart={vi.fn()}
          onStop={onStop}
          onReconnect={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onUsePort={vi.fn()}
        />
      )
    );
  });
}

const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe("TunnelListItem — honest states (#6028)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onStop.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each<[TunnelStatus, string, string]>([
    ["waiting", "Waiting", "Stop waiting"],
    ["notReachable", "Not reachable", "Stop"],
  ])("%s says so, says why, and can be stopped", (status, word, control) => {
    render(status);
    expect(q("tunnel-status-tun-1")?.getAttribute("aria-label")).toBe(word);
    expect(q("tunnel-reason-tun-1")?.textContent).toBe(WHY);
    const stop = q("tunnel-stop-tun-1")!;
    expect(stop.getAttribute("aria-label")).toBe(control);
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledWith("tun-1");
    expect(q("tunnel-start-tun-1")).toBeNull();
    // Reconnect needs something that runs.
    expect(q("tunnel-reconnect-tun-1")).toBeNull();
  });

  it("stopping says so and says why, and is not stopped a second time", () => {
    render("stopping");
    expect(q("tunnel-status-tun-1")?.getAttribute("aria-label")).toBe("Stopping");
    expect(q("tunnel-reason-tun-1")?.textContent).toBe(WHY);
    expect(q("tunnel-primary-tun-1")).toBeNull();
  });

  it("a ring, not a green dot, when it is not known whether it runs", () => {
    render("notReachable");
    const classes = q("tunnel-status-tun-1")!.classList;
    expect(classes.contains("status-dot--hollow")).toBe(true);
    expect(classes.contains("status-dot--success")).toBe(false);
  });

  it("shows no address while it is not reachable", () => {
    render("notReachable", { boundAddress: "127.0.0.1:5432", reachableFrom: "agentOnly" });
    expect(q("tunnel-address-tun-1")).toBeNull();
  });

  it.each<TunnelStatus>(["connected", "disconnected", "connecting"])(
    "%s has no reason line",
    (status) => {
      render(status);
      expect(q("tunnel-reason-tun-1")).toBeNull();
    }
  );

  it("an error says why once", () => {
    render("error");
    expect(q("tunnel-reason-tun-1")?.textContent).toBe(WHY);
    expect(container.textContent?.split(WHY)).toHaveLength(2);
  });

  it("reconnecting says why, and can try again now", () => {
    const retryTunnelNow = vi.fn(() => Promise.resolve());
    useAppStore.setState({ retryTunnelNow });
    render("reconnecting");
    expect(q("tunnel-reason-tun-1")?.textContent).toBe(`${WHY} Retry now`);
    act(() => q("tunnel-retry-now-tun-1")!.click());
    expect(retryTunnelNow).toHaveBeenCalledWith("tun-1");
    useAppStore.setState(useAppStore.getInitialState());
  });
});
