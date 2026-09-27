/**
 * TunnelEditor + external connection files (#3619): the SSH connection select
 * offers every SSH connection in the unified view (main store + enabled external
 * files), and an id held by more than one connection file — which the backend
 * refuses to host a tunnel on — is listed once, disabled, never picked as the
 * default, and flagged when an existing tunnel is bound to it.
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
import type { TunnelConfig } from "@/types/tunnel";
import type { TunnelEditorMeta } from "@/types/terminal";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-ambiguous";
const PANEL_ID = "panel-tun-ambiguous";

function ssh(id: string, name: string, sourceFile?: string): SavedConnection {
  return {
    id,
    name,
    config: { type: "ssh", config: { host: `${id}-host`, username: "u" } },
    folderId: null,
    ...(sourceFile ? { sourceFile } : {}),
  };
}

const ROOT_PANEL = {
  type: "leaf",
  id: PANEL_ID,
  tabs: [{ id: TAB_ID }],
  activeTabId: TAB_ID,
};

const BOUND_TO_AMBIGUOUS: TunnelConfig = {
  id: "tun-ambiguous",
  name: "Ambiguous",
  sshConnectionId: "db",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "localhost", remotePort: 80 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

let container: HTMLDivElement;
let root: Root;

function render(meta: TunnelEditorMeta) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={meta} isVisible={true} />
      </TooltipProvider>
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function savedConfig(): TunnelConfig {
  const save = useAppStore.getState().saveTunnel as unknown as {
    mock: { calls: [TunnelConfig][] };
  };
  return save.mock.calls[0][0];
}

function sshFieldError(): string | null {
  const field = container.querySelector('[data-testid="tunnel-editor-ssh-connection-field"]');
  return field?.querySelector('[role="alert"]')?.textContent ?? null;
}

setupConnectionsRegion();

describe("TunnelEditor — SSH connections from external files (#3619)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [BOUND_TO_AMBIGUOUS],
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

  it("a new tunnel may be bound to an SSH connection from an external file", async () => {
    seedConnectionsRegion({ connections: [ssh("ext-ssh", "External SSH", "/shared.json")] });
    render({ tunnelId: null, sshConnectionId: "ext-ssh" });
    setInput(
      container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-name"]')!,
      "External"
    );
    click(container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!);
    await flush();
    expect(savedConfig().sshConnectionId).toBe("ext-ssh");
    expect(sshFieldError()).toBeNull();
  });

  it("never defaults a new tunnel to an ambiguous id", async () => {
    seedConnectionsRegion({
      connections: [ssh("db", "db"), ssh("db", "db", "/shared.json"), ssh("web", "web")],
    });
    render({ tunnelId: null, sshConnectionId: "db" });
    setInput(
      container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-name"]')!,
      "Fallback"
    );
    click(container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!);
    await flush();
    expect(savedConfig().sshConnectionId).toBe("web");
  });

  it("flags an existing tunnel bound to an id held by several connection files", () => {
    seedConnectionsRegion({
      connections: [ssh("db", "db"), ssh("db", "db", "/shared.json"), ssh("web", "web")],
    });
    render({ tunnelId: "tun-ambiguous" });
    expect(sshFieldError()).toContain("more than one connection file");
  });

  it("does not flag a unique id", () => {
    seedConnectionsRegion({ connections: [ssh("db", "db"), ssh("web", "web", "/shared.json")] });
    render({ tunnelId: "tun-ambiguous" });
    expect(sshFieldError()).toBeNull();
  });
});
