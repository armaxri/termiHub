/**
 * Tests for the fleet-onboard dialog (#1961): it stamps N saved connections
 * from a chosen template connection and persists them via the store's bulk-add.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { FleetOnboardDialog } from "./FleetOnboardDialog";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo, InventoryHost, SavedConnection } from "@/types/connection";

vi.mock("@/services/api", () => ({}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function sshConnection(id: string, settings: Record<string, unknown> = {}): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type: "ssh", config: { host: "template.host", username: "deploy", ...settings } },
  };
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

/** A registry entry whose schema exposes the given field keys. */
function typeInfo(typeId: string, fieldKeys: string[]): ConnectionTypeInfo {
  return {
    typeId,
    displayName: typeId,
    icon: typeId,
    schema: {
      groups: [
        {
          key: "main",
          label: "Main",
          fields: fieldKeys.map((key) => ({
            key,
            label: key,
            fieldType: { type: "text" },
            required: false,
          })),
        },
      ],
    },
    capabilities: {} as ConnectionTypeInfo["capabilities"],
  } as ConnectionTypeInfo;
}

function openSelect(testId: string) {
  const trigger = q(testId) as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function optionLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");
}

function pickTemplate(label: string) {
  openSelect("fleet-onboard-template");
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  ) as HTMLElement | undefined;
  expect(option).toBeTruthy();
  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const isDisabled = (testId: string) => (q(testId) as HTMLButtonElement).disabled;

setupConnectionsRegion();

describe("FleetOnboardDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let bulkAddConnections: Mock<(connections: SavedConnection[]) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    bulkAddConnections = vi.fn<(connections: SavedConnection[]) => void>();
    useAppStore.setState({ bulkAddConnections });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWith(connections: SavedConnection[], rows: InventoryHost[]) {
    seedConnectionsRegion({ connections, folders: [] });
    act(() =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(FleetOnboardDialog, {
            open: true,
            onOpenChange: () => {},
            rows,
            sourceLabel: "a CSV inventory",
          }),
        })
      )
    );
  }

  it("builds one connection per row from the picked template and bulk-adds them", () => {
    renderWith(
      [sshConnection("prod-template")],
      [
        { host: "web1.internal", label: "Web 1" },
        { host: "web2.internal", label: "Web 2" },
      ]
    );

    expect(q("fleet-onboard-dialog")).not.toBeNull();
    pickTemplate("prod-template");
    act(() => q("fleet-onboard-import").click());

    expect(bulkAddConnections).toHaveBeenCalledTimes(1);
    const built = bulkAddConnections.mock.calls[0][0];
    expect(built).toHaveLength(2);
    expect(built[0].config.config.host).toBe("web1.internal");
    expect(built[0].config.config.username).toBe("deploy");
    expect(built[0].name).toBe("Web 1");
    expect(built[1].config.config.host).toBe("web2.internal");
  });

  it("shows an empty state and does not bulk-add when no template connection exists", () => {
    renderWith([], [{ host: "web1.internal", label: "Web 1" }]);

    expect(q("fleet-onboard-no-templates")).not.toBeNull();
    // The import button is disabled with no template.
    act(() => q("fleet-onboard-import").click());
    expect(bulkAddConnections).not.toHaveBeenCalled();
  });

  it("skips hosts already present in the target folder", () => {
    renderWith(
      [
        sshConnection("prod-template"),
        {
          ...sshConnection("existing"),
          config: { type: "ssh", config: { host: "web1.internal" } },
        },
      ],
      [
        { host: "web1.internal", label: "Web 1" },
        { host: "web2.internal", label: "Web 2" },
      ]
    );

    pickTemplate("prod-template");
    act(() => q("fleet-onboard-import").click());
    const built = bulkAddConnections.mock.calls[0][0];
    // web1 already exists at root → only web2 is added.
    expect(built).toHaveLength(1);
    expect(built[0].config.config.host).toBe("web2.internal");
  });

  it("does not pre-select a template: Add stays disabled until the user picks one", () => {
    renderWith(
      [sshConnection("alpha"), sshConnection("beta")],
      [{ host: "web1.internal", label: "Web 1" }]
    );

    expect(isDisabled("fleet-onboard-import")).toBe(true);
    act(() => q("fleet-onboard-import").click());
    expect(bulkAddConnections).not.toHaveBeenCalled();

    pickTemplate("beta");
    expect(isDisabled("fleet-onboard-import")).toBe(false);
    act(() => q("fleet-onboard-import").click());
    expect(bulkAddConnections).toHaveBeenCalledTimes(1);
  });

  it("offers only host-based connection types as templates", () => {
    useAppStore.setState({
      connectionTypes: [
        typeInfo("ssh", ["host", "port", "username"]),
        typeInfo("telnet", ["host", "port"]),
        typeInfo("serial", ["port", "baudRate"]),
        typeInfo("local", ["shell"]),
      ],
    });
    renderWith(
      [
        sshConnection("ssh-box"),
        { id: "tel", name: "tel-box", folderId: null, config: { type: "telnet", config: {} } },
        {
          id: "ser",
          name: "serial-box",
          folderId: null,
          config: { type: "serial", config: { port: "/dev/ttyUSB0" } },
        },
        { id: "loc", name: "local-box", folderId: null, config: { type: "local", config: {} } },
      ],
      [{ host: "web1.internal", label: "Web 1" }]
    );

    openSelect("fleet-onboard-template");
    const labels = optionLabels();
    expect(labels.some((l) => l.includes("ssh-box"))).toBe(true);
    expect(labels.some((l) => l.includes("tel-box"))).toBe(true);
    expect(labels.some((l) => l.includes("serial-box"))).toBe(false);
    expect(labels.some((l) => l.includes("local-box"))).toBe(false);
  });

  it("shows the empty state when no host-based template exists", () => {
    useAppStore.setState({ connectionTypes: [typeInfo("local", ["shell"])] });
    renderWith(
      [{ id: "loc", name: "local-box", folderId: null, config: { type: "local", config: {} } }],
      [{ host: "web1.internal", label: "Web 1" }]
    );
    expect(q("fleet-onboard-no-templates")).not.toBeNull();
  });

  it("keeps the picked template when the connections projection changes while open", () => {
    const alpha = sshConnection("alpha", { username: "alpha-user" });
    const beta = sshConnection("beta", { username: "beta-user" });
    renderWith([alpha, beta], [{ host: "web1.internal", label: "Web 1" }]);

    pickTemplate("beta");
    expect(isDisabled("fleet-onboard-import")).toBe(false);

    // The projection re-emits (e.g. another window added a connection).
    act(() => {
      seedConnectionsRegion({ connections: [alpha, beta, sshConnection("gamma")], folders: [] });
    });

    expect(isDisabled("fleet-onboard-import")).toBe(false);
    act(() => q("fleet-onboard-import").click());
    const built = bulkAddConnections.mock.calls[0][0];
    expect(built).toHaveLength(1);
    expect(built[0].config.config.username).toBe("beta-user");
  });
});
