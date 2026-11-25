/**
 * Run controls and labelled dots on tunnel rows (#5852): the row's Start /
 * Stop / Retry is always visible on the trailing edge (like a macro's Play);
 * the other actions are a hover group; the status dot names its state in a
 * tooltip and as its accessible name.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelListItem } from "./TunnelListItem";
import { NO_CONTEXT } from "@/test/serviceContext";
import { withTooltip } from "@/test/tooltip";
import type { TunnelConfig, TunnelState, TunnelStatus } from "@/types/tunnel";

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "Prod DB",
  sshConnectionId: "ssh-1",
  autoStart: false,
  reconnectOnDisconnect: false,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
};

const noop = () => {};
let container: HTMLDivElement;
let root: Root;

function render(status?: TunnelStatus) {
  const state = status ? ({ tunnelId: "tun-1", status, error: "boom" } as TunnelState) : undefined;
  act(() => {
    root.render(
      withTooltip(
        <TunnelListItem
          tunnel={TUNNEL}
          state={state}
          context={NO_CONTEXT}
          onStart={noop}
          onStop={noop}
          onReconnect={noop}
          onEdit={noop}
          onDuplicate={noop}
          onDelete={noop}
        />
      )
    );
  });
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const primaryLabels = () =>
  Array.from(
    container.querySelectorAll('[data-testid="tunnel-primary-tun-1"] button[aria-label]')
  ).map((b) => b.getAttribute("aria-label"));
const moreLabels = () =>
  Array.from(container.querySelectorAll(".sidebar-list-item__more button[aria-label]")).map((b) =>
    b.getAttribute("aria-label")
  );

describe("TunnelListItem — run control and labelled dot (#5852)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each<[TunnelStatus | undefined, string, string]>([
    [undefined, "Start", "Stopped"],
    ["disconnected", "Start", "Stopped"],
    ["connecting", "Stop", "Starting"],
    ["connected", "Stop", "Running"],
    ["reconnecting", "Stop", "Reconnecting"],
    ["error", "Retry", "Error"],
    ["waiting", "Stop waiting", "Waiting"],
    ["stopping", "Stop", "Stopping"],
    ["notReachable", "Stop", "Not reachable"],
  ])("status %s: the run control is %s and the dot reads %s", (status, control, dot) => {
    render(status);
    expect(primaryLabels()).toEqual([control]);
    const dotEl = q('[data-testid="tunnel-status-tun-1"]')!;
    expect(dotEl.getAttribute("aria-label")).toBe(dot);
    expect(dotEl.getAttribute("title")).toBe(dot);
    expect(dotEl.getAttribute("role")).toBe("img");
  });

  it("keeps the run control out of the hover group, and Edit/Duplicate/Delete in it", () => {
    render("connected");
    expect(moreLabels()).toEqual(["Edit", "Reconnect", "Duplicate", "Delete"]);
    const row = q('[data-testid="tunnel-item-tun-1"]')!;
    expect(row.classList.contains("sidebar-list-item--primary-action")).toBe(true);
    expect(q('[role="group"]')!.getAttribute("aria-label")).toBe("More actions for Prod DB");
  });

  it("an errored row offers Retry as the run control, and says why on the row", () => {
    render("error");
    expect(primaryLabels()).toEqual(["Retry"]);
    expect(moreLabels()).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(q('[data-testid="tunnel-reason-tun-1"]')!.textContent).toBe("boom");
  });

  it("a tunnel whose SSH connection was deleted has no run control", () => {
    render("missingConnection");
    expect(q('[data-testid="tunnel-primary-tun-1"]')).toBeNull();
    expect(q('[data-testid="tunnel-start-tun-1"]')).toBeNull();
    expect(q('[data-testid="tunnel-status-tun-1"]')!.getAttribute("title")).toBe(
      "Needs a connection"
    );
  });
});
