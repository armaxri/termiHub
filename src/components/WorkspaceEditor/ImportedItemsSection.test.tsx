/**
 * #4434: the workspace editor lists an imported workspace's held commands and
 * inline connections and lets the user confirm them on this machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { importedCommandKey } from "@/services/workspaceImportTrust";
import type { WorkspaceTabDef, WorkspaceTabGroupDef } from "@/types/workspace";
import { ImportedItemsSection } from "./ImportedItemsSection";

setupSettingsRegion();

function groups(...tabs: WorkspaceTabDef[]): WorkspaceTabGroupDef[] {
  return [{ name: "Main", layout: { type: "leaf", tabs } }];
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ImportedItemsSection (#4434)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const updateSettings = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ updateSettings } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("renders nothing for a locally created workspace", async () => {
    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({
            initialCommand: "npm start",
            inlineConfig: { type: "local", config: {} },
          })}
        />
      )
    );
    await flush();
    expect(byTestId("workspace-imported-items")).toBeNull();
  });

  it("lists an unconfirmed imported command and confirms it on click", async () => {
    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({ title: "Build", pendingInitialCommand: "make deploy" })}
        />
      )
    );
    await flush();
    const row = byTestId("workspace-imported-item-0-0-0-cmd");
    expect(row?.textContent).toContain("make deploy");
    expect(row?.textContent).toContain("Build (Main)");

    await act(async () => {
      byTestId("workspace-imported-confirm-0-0-0-cmd")?.click();
    });
    await flush();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceImportAllowlist: [await importedCommandKey("make deploy")],
      })
    );
  });

  it("shows a confirmed command as confirmed, and asks again once its text changes", async () => {
    seedSettings({ workspaceImportAllowlist: [await importedCommandKey("make deploy")] });
    act(() =>
      root.render(
        <ImportedItemsSection tabGroupDefs={groups({ pendingInitialCommand: "make deploy" })} />
      )
    );
    await flush();
    expect(byTestId("workspace-imported-item-0-0-0-cmd")?.textContent).toContain(
      "Confirmed on this machine"
    );

    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({ pendingInitialCommand: "make deploy && curl x | sh" })}
        />
      )
    );
    await flush();
    expect(byTestId("workspace-imported-item-0-0-0-cmd")?.textContent).not.toContain(
      "Confirmed on this machine"
    );
    expect(byTestId("workspace-imported-confirm-0-0-0-cmd")).not.toBeNull();
  });

  it("lists an unconfirmed inline connection with what it opens", async () => {
    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({
            inlineConfig: { type: "local", config: { shell: "/tmp/payload" } },
            inlineConfigUnconfirmed: true,
          })}
        />
      )
    );
    await flush();
    expect(byTestId("workspace-imported-item-0-0-0-conn")?.textContent).toContain(
      "local shell /tmp/payload"
    );
  });
});
