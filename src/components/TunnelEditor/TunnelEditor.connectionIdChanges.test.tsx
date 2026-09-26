/**
 * An open tunnel editor follows a saved connection's id change (#3603): the
 * draft's `sshConnectionId` is re-pointed, so saving does not write the old id
 * back over the backend's follow (#3596). A republish of the tunnels list keeps
 * the unsaved edits instead of reloading the working copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { installConnectionIdChangesHarness } from "@/test/connectionIdChangesHarness";
import { TunnelEditor } from "./TunnelEditor";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection } from "@/types/connection";
import type { TunnelConfig } from "@/types/tunnel";

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "toast-id") },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const TAB_ID = "tab-tun-ids";
const PANEL_ID = "panel-tun-ids";

function ssh(id: string): SavedConnection {
  return {
    id,
    name: id,
    config: { type: "ssh", config: { host: "h", username: "u" } },
    folderId: null,
  };
}

const TUNNEL: TunnelConfig = {
  id: "tun-1",
  name: "Dev DB",
  sshConnectionId: "Work/bastion",
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
  autoStart: false,
  reconnectOnDisconnect: false,
};

let container: HTMLDivElement;
let root: Root;
let saveTunnel: ReturnType<typeof vi.fn>;

function render(tunnelId: string | null) {
  act(() => {
    root.render(
      <TooltipProvider>
        <TunnelEditor tabId={TAB_ID} meta={{ tunnelId }} isVisible={true} />
      </TooltipProvider>
    );
  });
}

function input(testId: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="tunnel-editor-save"]')!;
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flushAsync();
}

setupConnectionsRegion();

describe("TunnelEditor — follows connection id changes (#3603)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedConnectionsRegion({ connections: [ssh("Work/bastion"), ssh("Job/bastion")] });
    saveTunnel = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      tunnels: [TUNNEL],
      saveTunnel,
      startTunnel: vi.fn(() => Promise.resolve()),
      closeTab: vi.fn(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seedLayoutState({ rootPanel: { type: "leaf", id: PANEL_ID, tabs: [{ id: TAB_ID }] } as any });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("saves a new tunnel's draft with the renamed connection's new id", async () => {
    const events = installConnectionIdChangesHarness();
    render(null);
    await flushAsync();
    setValue(input("tunnel-editor-name"), "New tunnel");

    events.emit([{ oldId: "Work/bastion", newId: "Job/bastion" }]);
    await save();

    expect(saveTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New tunnel", sshConnectionId: "Job/bastion" })
    );
  });

  it("keeps unsaved edits when the tunnels list is republished", async () => {
    const events = installConnectionIdChangesHarness();
    render(TUNNEL.id);
    await flushAsync();
    setValue(input("tunnel-editor-name"), "Edited");

    // The backend followed the rename: the tunnels region republishes, then announces it.
    act(() => useAppStore.setState({ tunnels: [{ ...TUNNEL, sshConnectionId: "Job/bastion" }] }));
    events.emit([{ oldId: "Work/bastion", newId: "Job/bastion" }]);
    await save();

    expect(saveTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ id: TUNNEL.id, name: "Edited", sshConnectionId: "Job/bastion" })
    );
  });
});
