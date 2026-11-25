/**
 * Run controls and labelled dots on service rows (#5852): Start / Stop is
 * always visible on the row's trailing edge; the other actions are a hover
 * group; the status dot names its state in a tooltip and as its accessible
 * name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  autoStart: false,
  readOnly: false,
};

let container: HTMLDivElement;
let root: Root;

function render(status?: ServerStatus) {
  const state = status ? ({ serverId: "srv-1", status, error: "boom" } as ServerState) : undefined;
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerItem
          config={config}
          state={state}
          onStart={vi.fn()}
          onRestart={vi.fn()}
          context={NO_CONTEXT}
          onStop={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    );
  });
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const labels = (sel: string) =>
  Array.from(container.querySelectorAll(`${sel} button[aria-label]`)).map((b) =>
    b.getAttribute("aria-label")
  );

describe("EmbeddedServerItem — run control and labelled dot (#5852)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each<[ServerStatus | undefined, string, string]>([
    [undefined, "Start", "Stopped"],
    ["stopped", "Start", "Stopped"],
    ["starting", "Stop", "Starting"],
    ["running", "Stop", "Running"],
    ["stopping", "Stop", "Stopping"],
    ["error", "Retry", "Error"],
    ["waiting", "Stop waiting", "Waiting"],
    ["notReachable", "Stop", "Not reachable"],
  ])("status %s: the run control is %s and the dot reads %s", (status, control, dot) => {
    render(status);
    expect(labels('[data-testid="server-primary-srv-1"]')).toEqual([control]);
    const dotEl = q('[data-testid="server-status-srv-1"]')!;
    expect(dotEl.getAttribute("aria-label")).toBe(dot);
    expect(dotEl.getAttribute("title")).toBe(dot);
  });

  it("puts activity, edit and the menu in the hover group", () => {
    render("running");
    expect(labels(".sidebar-list-item__more")).toEqual(["Activity", "Edit", "More"]);
    expect(q('[role="group"]')!.getAttribute("aria-label")).toBe("More actions for Docs share");
  });
});
