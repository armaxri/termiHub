/**
 * Names, not settings (#5770): a service row shows its name and an error;
 * the protocol, address, folder and traffic are in its tooltip, which is also
 * the row's accessible description.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { EmbeddedServerItem } from "./EmbeddedServerItem";
import { TooltipProvider } from "@/components/ui";
import type { EmbeddedServerConfig, ServerState } from "@/types/embeddedServer";

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

function render(state?: ServerState) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerItem
          config={config}
          state={state}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    );
  });
}

const row = () => container.querySelector<HTMLElement>('[data-testid="server-item-srv-1"]')!;

describe("EmbeddedServerItem — names, not settings (#5770)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows only the name; the protocol, port and folder are in the tooltip", () => {
    render();
    const text = row().textContent ?? "";
    expect(text).toContain("Docs share");
    for (const setting of ["HTTP", "8080", "/srv/docs", "Run on"]) {
      expect(text).not.toContain(setting);
    }
    const tip = row().getAttribute("aria-description") ?? "";
    expect(tip).toContain("HTTP · http://127.0.0.1:8080");
    expect(tip).toContain("Serves /srv/docs");
  });

  it("puts the traffic of a running server in the tooltip", () => {
    render({
      serverId: "srv-1",
      status: "running",
      stats: { activeConnections: 3, totalConnections: 3, bytesSent: 0, bytesReceived: 0 },
    });
    expect(row().textContent).not.toContain("conn");
    expect(row().getAttribute("aria-description")).toContain("3 connections");
  });

  it("keeps an error on the row", () => {
    render({
      serverId: "srv-1",
      status: "error",
      error: "Port 8080 is in use",
      stats: { activeConnections: 0, totalConnections: 0, bytesSent: 0, bytesReceived: 0 },
    });
    expect(row().textContent).toContain("Port 8080 is in use");
  });
});
