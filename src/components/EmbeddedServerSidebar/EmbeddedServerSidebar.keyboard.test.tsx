/**
 * A11Y-008: the Services (embedded-servers) sidebar must expose list semantics
 * and roving-tabindex keyboard navigation to assistive technology, matching the
 * other management sidebars (workspaces, tunnels).
 *
 * The list adopts the shared roving-tabindex + ARIA `tree`/`treeitem` model: the
 * container is a `tree`, each row a `treeitem`, exactly one row is tabbable at a
 * time, and Arrow keys move the roving focus between rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerSidebar } from "./EmbeddedServerSidebar";

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([{ name: "Loopback", addr: "127.0.0.1" }])),
  setEmbeddedServerRunLocation: vi.fn(() => Promise.resolve()),
}));

function makeServer(id: string, name: string): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType: "http",
    rootDirectory: "/tmp",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
  };
}

let container: HTMLDivElement;
let root: Root;

function seedStore(servers: EmbeddedServerConfig[]) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    embeddedServers: servers,
    embeddedServerStates: {},
    saveEmbeddedServer: vi.fn(),
    deleteEmbeddedServer: vi.fn(),
    startEmbeddedServer: vi.fn(),
    stopEmbeddedServer: vi.fn(),
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function press(key: string) {
  const list = query("server-list")!;
  act(() => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function renderSidebar() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerSidebar />
      </TooltipProvider>
    );
  });
}

describe("EmbeddedServerSidebar — keyboard navigation & list semantics (A11Y-008)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the list as a tree and rows as treeitems", () => {
    seedStore([makeServer("srv-1", "Alpha"), makeServer("srv-2", "Bravo")]);
    renderSidebar();

    const list = query("server-list")!;
    expect(list.getAttribute("role")).toBe("tree");
    expect(list.getAttribute("aria-label")).toBe("Services");

    const first = query("server-item-srv-1")!;
    expect(first.getAttribute("role")).toBe("treeitem");
    expect(first.getAttribute("aria-level")).toBe("1");
  });

  it("keeps a single roving-tabindex row (first row tabbable)", () => {
    seedStore([makeServer("srv-1", "Alpha"), makeServer("srv-2", "Bravo")]);
    renderSidebar();

    expect(query("server-item-srv-1")!.getAttribute("tabindex")).toBe("0");
    expect(query("server-item-srv-2")!.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the roving focus down with ArrowDown", () => {
    seedStore([makeServer("srv-1", "Alpha"), makeServer("srv-2", "Bravo")]);
    renderSidebar();

    press("ArrowDown");
    expect(document.activeElement).toBe(query("server-item-srv-2"));
    expect(query("server-item-srv-2")!.getAttribute("tabindex")).toBe("0");
  });
});
