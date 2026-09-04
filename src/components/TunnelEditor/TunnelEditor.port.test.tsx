/**
 * Blank-port-policy tests for the TunnelEditor (#1444): a cleared port field
 * stays blank (`""`) — surfacing as an invalid/required field that blocks Save —
 * instead of the old `parseInt(...) || 0` coercion that snapped it back to "0".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-port";
const PANEL_ID = "panel-tun-port";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: null }} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function localPortInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-local-port"]')!;
}

function saveButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!;
}

/** Set a value on a React-controlled <input> and fire the native input event. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

setupConnectionsRegion();

describe("TunnelEditor — blank port policy (#1444)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [],
      saveTunnel: vi.fn(() => Promise.resolve()),
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedLayoutState({ rootPanel: ROOT_PANEL as any });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the local port as a number input", () => {
    render();
    const input = localPortInput();
    expect(input.type).toBe("number");
    expect(input.value).toBe("8080");
  });

  it("keeps a cleared port blank instead of snapping it back to 0", () => {
    render();
    setValue(localPortInput(), "");
    expect(localPortInput().value).toBe("");
  });

  it("disables Save while a port is blank", () => {
    render();
    setValue(localPortInput(), "");
    expect(saveButton().disabled).toBe(true);
  });
});
