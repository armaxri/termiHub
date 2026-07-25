/**
 * Tests for the fleet-onboard dialog (#1961): it stamps N saved connections
 * from a chosen template connection and persists them via the store's bulk-add.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { FleetOnboardDialog } from "./FleetOnboardDialog";
import { TooltipProvider } from "@/components/ui";
import type { InventoryHost, SavedConnection } from "@/types/connection";

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
    useAppStore.setState({ connections, folders: [] });
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

  it("builds one connection per row from the default template and bulk-adds them", () => {
    renderWith(
      [sshConnection("prod-template")],
      [
        { host: "web1.internal", label: "Web 1" },
        { host: "web2.internal", label: "Web 2" },
      ]
    );

    expect(q("fleet-onboard-dialog")).not.toBeNull();
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

    act(() => q("fleet-onboard-import").click());
    const built = bulkAddConnections.mock.calls[0][0];
    // web1 already exists at root → only web2 is added.
    expect(built).toHaveLength(1);
    expect(built[0].config.config.host).toBe("web2.internal");
  });
});
