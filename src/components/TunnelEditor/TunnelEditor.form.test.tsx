/**
 * Form-migration tests for the TunnelEditor (UISF-011): after the move to
 * react-hook-form + zod, a valid config for each tunnel type still submits the
 * exact `tunnelType` payload, switching the type resets its config to that
 * type's defaults, edited fields are persisted, and an invalid host/port blocks
 * Save — the discriminated `local`/`remote`/`dynamic` union stays faithful.
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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-form";
const PANEL_ID = "panel-tun-form";

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
let saveTunnel: (config: TunnelConfig) => Promise<void>;

function render() {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId: null }} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function q(testid: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
}

function byId(id: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`#${id}`)!;
}

/** Set a value on a React-controlled input and fire the native input event. */
function setValue(el: HTMLInputElement, value: string) {
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

setupConnectionsRegion();

describe("TunnelEditor — form migration (UISF-011)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveTunnel = vi.fn(() => Promise.resolve());
    seedConnectionsRegion({ connections: [SSH_CONN] });
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [],
      saveTunnel,
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

  it("submits a valid local config with the SSH connection and default forward", async () => {
    render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "Local DB");
    click(q("tunnel-editor-save"));
    await flush();
    expect(vi.mocked(saveTunnel)).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveTunnel).mock.calls[0][0];
    expect(saved.name).toBe("Local DB");
    expect(saved.sshConnectionId).toBe("ssh-1");
    expect(saved.tunnelType).toEqual({
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 8080, remoteHost: "localhost", remotePort: 80 },
    });
  });

  it("switching to dynamic resets the config to the dynamic defaults on submit", async () => {
    render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "SOCKS");
    click(q("tunnel-type-dynamic"));
    click(q("tunnel-editor-save"));
    await flush();
    const saved = vi.mocked(saveTunnel).mock.calls[0][0];
    expect(saved.tunnelType).toEqual({
      type: "dynamic",
      config: { localHost: "127.0.0.1", localPort: 1080 },
    });
  });

  it("switching to remote submits the remote-forward defaults", async () => {
    render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "Reverse");
    click(q("tunnel-type-remote"));
    click(q("tunnel-editor-save"));
    await flush();
    const saved = vi.mocked(saveTunnel).mock.calls[0][0];
    expect(saved.tunnelType).toEqual({
      type: "remote",
      config: { remoteHost: "0.0.0.0", remotePort: 8080, localHost: "127.0.0.1", localPort: 3000 },
    });
  });

  it("persists an edited local port through Save", async () => {
    render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "Edited");
    setValue(q("tunnel-editor-local-port") as HTMLInputElement, "9999");
    click(q("tunnel-editor-save"));
    await flush();
    const saved = vi.mocked(saveTunnel).mock.calls[0][0];
    expect(saved.tunnelType.type).toBe("local");
    if (saved.tunnelType.type === "local") {
      expect(saved.tunnelType.config.localPort).toBe(9999);
    }
  });

  it("blocks Save while a forwarding host is blank", () => {
    render();
    setValue(q("tunnel-editor-name") as HTMLInputElement, "Bad host");
    // Name is valid, so Save is enabled until the host is cleared.
    expect((q("tunnel-editor-save") as HTMLButtonElement).disabled).toBe(false);
    setValue(byId(`tunnel-local-host-${TAB_ID}`), "");
    expect((q("tunnel-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });
});
