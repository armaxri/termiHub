/**
 * TunnelEditor + per-connection port forwards (PROD-023): a new tunnel opened
 * from a connection's "Port Forwarding" section is pre-bound to that SSH
 * connection with "start with connection" on, the flag round-trips on save, and
 * an existing tunnel keeps (and can clear) its saved flag.
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

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => "toast-id"),
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: toastMock };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-pf";
const PANEL_ID = "panel-tun-pf";

const SSH_CONN: SavedConnection = {
  id: "ssh-1",
  name: "My SSH",
  config: { type: "ssh", config: { host: "h", username: "u" } },
  folderId: null,
};

const SSH_CONN_2: SavedConnection = {
  id: "ssh-2",
  name: "Other SSH",
  config: { type: "ssh", config: { host: "h2", username: "u" } },
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

function nameInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="tunnel-editor-name"]')!;
}
function saveButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!;
}
function startWithConnectionToggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`#start-with-connection-${TAB_ID}`)!;
}
function savedConfig(): TunnelConfig {
  const save = useAppStore.getState().saveTunnel as unknown as {
    mock: { calls: [TunnelConfig][] };
  };
  return save.mock.calls[0][0];
}

/** Set a value on a React-controlled <input> and fire the native input event. */
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

setupConnectionsRegion();

const EXISTING: TunnelConfig = {
  id: "tun-existing",
  name: "Existing",
  sshConnectionId: "ssh-1",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "localhost", remotePort: 80 },
  },
  autoStart: false,
  startWithConnection: true,
  reconnectOnDisconnect: false,
};

describe("TunnelEditor — start with connection (PROD-023)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedConnectionsRegion({ connections: [SSH_CONN, SSH_CONN_2] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [EXISTING],
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

  it("a plain new tunnel defaults to the first SSH connection with the flag off", async () => {
    render({ tunnelId: null });
    expect(startWithConnectionToggle().getAttribute("aria-checked")).toBe("false");
    setInput(nameInput(), "Plain");
    click(saveButton());
    await flush();
    expect(savedConfig().sshConnectionId).toBe("ssh-1");
    expect(savedConfig().startWithConnection).toBe(false);
  });

  it("a new tunnel opened from a connection is pre-bound with the flag on", async () => {
    render({ tunnelId: null, sshConnectionId: "ssh-2" });
    expect(startWithConnectionToggle().getAttribute("aria-checked")).toBe("true");
    setInput(nameInput(), "From connection");
    click(saveButton());
    await flush();
    expect(savedConfig().sshConnectionId).toBe("ssh-2");
    expect(savedConfig().startWithConnection).toBe(true);
  });

  it("ignores a prefill that is not a saved SSH connection", async () => {
    render({ tunnelId: null, sshConnectionId: "gone" });
    setInput(nameInput(), "Fallback");
    click(saveButton());
    await flush();
    expect(savedConfig().sshConnectionId).toBe("ssh-1");
  });

  it("an existing tunnel keeps its saved flag and can clear it", async () => {
    render({ tunnelId: "tun-existing" });
    expect(startWithConnectionToggle().getAttribute("aria-checked")).toBe("true");
    click(startWithConnectionToggle());
    click(saveButton());
    await flush();
    expect(savedConfig().id).toBe("tun-existing");
    expect(savedConfig().startWithConnection).toBe(false);
  });
});
