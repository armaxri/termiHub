/**
 * Connection rows show the name and, when set, the user's short description
 * muted under it — never host/user settings (#5757). The sidebar filter also
 * matches the description.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) => React.createElement("div", { ref: sectionRef, "data-testid": `agent-node-${agent.id}` }),
}));

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  const id = overrides.id ?? "conn-1";
  return {
    id,
    name: overrides.name ?? `Connection ${id}`,
    folderId: null,
    config: { type: "local", config: {} } as SavedConnection["config"],
    ...overrides,
  };
}

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

async function render(_container: HTMLElement, root: Root) {
  await act(async () => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
  await flushAsync();
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — names and descriptions (#5757)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("shows only the name for a connection without a description", async () => {
    seedConnectionsRegion({
      connections: [
        makeConnection({
          id: "conn-1",
          name: "prod-web",
          config: {
            type: "ssh",
            config: { host: "10.0.0.4", username: "deploy", port: 22 },
          } as SavedConnection["config"],
        }),
      ],
    });
    await render(container, root);
    const row = q("connection-item-conn-1")!;
    expect(row.textContent).toBe("prod-web");
    expect(row.textContent).not.toContain("10.0.0.4");
    expect(row.textContent).not.toContain("deploy");
    expect(q("connection-description-conn-1")).toBeNull();
    expect(row.classList.contains("connection-tree__item--described")).toBe(false);
  });

  it("shows the description muted under the name when set", async () => {
    seedConnectionsRegion({
      connections: [makeConnection({ id: "conn-1", name: "prod-web", description: "Shop front" })],
    });
    await render(container, root);
    const row = q("connection-item-conn-1")!;
    const description = q("connection-description-conn-1")!;
    expect(description.textContent).toBe("Shop front");
    expect(description.classList.contains("connection-tree__description")).toBe(true);
    expect(row.classList.contains("connection-tree__item--described")).toBe(true);
    expect(row.textContent).toBe("prod-webShop front");
  });

  it("finds a connection by its description in the sidebar filter", async () => {
    seedConnectionsRegion({
      connections: [
        makeConnection({ id: "conn-1", name: "box-a", description: "Shop front" }),
        makeConnection({ id: "conn-2", name: "box-b" }),
      ],
    });
    await render(container, root);
    const input = q("connection-filter-input") as HTMLInputElement;
    typeInto(input, "shop");
    expect(q("connection-item-conn-1")).not.toBeNull();
    expect(q("connection-item-conn-2")).toBeNull();
  });
});
