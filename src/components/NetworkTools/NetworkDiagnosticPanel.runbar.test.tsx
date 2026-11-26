/**
 * The tab-level "Run on" is shown only for a tool it applies to: an HTTP monitor
 * chooses its machine per monitor, so its tab has none (F-009).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { NetworkDiagnosticMeta } from "@/types/terminal";
import { NetworkDiagnosticPanel } from "./NetworkDiagnosticPanel";

vi.mock("./NetworkToolRunLocation", () => ({
  NetworkToolRunLocation: ({ tool }: { tool: string }) => <div data-testid={`runbar-${tool}`} />,
}));
vi.mock("./HttpMonitorPanel", () => ({ HttpMonitorPanel: () => <div /> }));
vi.mock("./PingPanel", () => ({ PingPanel: () => <div /> }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (tool: string) =>
  act(() =>
    root.render(
      <NetworkDiagnosticPanel meta={{ tool } as NetworkDiagnosticMeta} isVisible={true} />
    )
  );

describe("the tab-level Run on", () => {
  it("is not on an HTTP monitor tab", () => {
    render("http-monitor");
    expect(container.querySelector('[data-testid="runbar-http-monitor"]')).toBeNull();
    expect(container.querySelector(".network-diagnostic__runbar")).toBeNull();
  });

  it("is on a tool that runs as a whole", () => {
    render("ping");
    expect(container.querySelector('[data-testid="runbar-ping"]')).not.toBeNull();
  });
});
