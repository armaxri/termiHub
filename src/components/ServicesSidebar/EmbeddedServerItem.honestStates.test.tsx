/**
 * What a file server's row says while it waits, stops or cannot be reached
 * (#6028): the same words, reasons and buttons as a tunnel's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { NO_CONTEXT } from "@/test/serviceContext";
import { TooltipProvider } from "@/components/ui";
import type { EmbeddedServerConfig, ServerState, ServerStatus } from "@/types/embeddedServer";

const config: EmbeddedServerConfig = {
  id: "srv-1",
  name: "Docs share",
  serverType: "http",
  rootDirectory: "/srv/docs",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: true,
  readOnly: false,
};
const WHY = "Waiting for agent Edge box. Starts by itself when the agent is connected.";

let container: HTMLDivElement;
let root: Root;
const onStop = vi.fn();

function render(status: ServerStatus) {
  const state: ServerState = {
    serverId: "srv-1",
    status,
    error: WHY,
    stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
  };
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerItem
          config={config}
          state={state}
          onStart={vi.fn()}
          onRestart={vi.fn()}
          context={NO_CONTEXT}
          onStop={onStop}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onUsePort={vi.fn()}
        />
      </TooltipProvider>
    );
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe("EmbeddedServerItem — honest states (#6028)", () => {
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

  it.each<[ServerStatus, string, string]>([
    ["waiting", "Waiting", "Cancel waiting"],
    ["notReachable", "Not reachable", "Stop"],
  ])("%s says so, says why, and can be stopped", (status, word, control) => {
    render(status);
    expect(q("server-status-srv-1")?.getAttribute("aria-label")).toBe(word);
    expect(q("server-reason-srv-1")?.textContent).toBe(WHY);
    const stop = q("server-stop-srv-1")!;
    expect(stop.getAttribute("aria-label")).toBe(control);
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledWith("srv-1");
    expect(q("server-start-srv-1")).toBeNull();
  });

  it("offers the same in the context menu", () => {
    render("waiting");
    act(() => {
      q("server-item-srv-1")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      );
    });
    expect(q("ctx-stop-srv-1")?.textContent).toContain("Cancel waiting");
    expect(q("ctx-start-srv-1")).toBeNull();
  });

  it("stopping says so and says why, and is not stopped a second time", () => {
    render("stopping");
    expect(q("server-status-srv-1")?.getAttribute("aria-label")).toBe("Stopping");
    expect(q("server-reason-srv-1")?.textContent).toBe(WHY);
    expect(q("server-primary-srv-1")).toBeNull();
  });

  it("a ring, not a green dot, when it is not known whether it runs", () => {
    render("notReachable");
    const classes = q("server-status-srv-1")!.classList;
    expect(classes.contains("status-dot--hollow")).toBe(true);
    expect(classes.contains("status-dot--success")).toBe(false);
  });

  it.each<ServerStatus>(["running", "stopped", "starting"])("%s has no reason line", (status) => {
    render(status);
    expect(q("server-reason-srv-1")).toBeNull();
  });

  it("an error says why once", () => {
    render("error");
    expect(q("server-reason-srv-1")?.textContent).toBe(WHY);
    expect(container.textContent?.split(WHY)).toHaveLength(2);
  });
});
