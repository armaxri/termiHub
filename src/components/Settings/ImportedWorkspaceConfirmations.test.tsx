/**
 * #4445: Settings → Security lists the imported workspace commands and inline
 * connections confirmed on this machine and lets the user revoke them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import {
  importedCommandKey,
  importedConnectionKey,
  resolveImportTrust,
} from "@/services/workspaceImportTrust";
import { loadWorkspace } from "@/services/workspaceApi";
import type { WorkspaceDefinition, WorkspaceTabGroupDef } from "@/types/workspace";
import { ImportedItemsSection } from "@/components/WorkspaceEditor/ImportedItemsSection";
import { ImportedWorkspaceConfirmations } from "./ImportedWorkspaceConfirmations";

vi.mock("@/services/workspaceApi", () => ({ loadWorkspace: vi.fn() }));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const mockedLoad = vi.mocked(loadWorkspace);

setupSettingsRegion();

const INLINE = { type: "ssh", config: { host: "build.example.com", username: "ci" } };

const GROUPS: WorkspaceTabGroupDef[] = [
  {
    name: "Main",
    layout: {
      type: "leaf",
      tabs: [
        { title: "Build", pendingInitialCommand: "make deploy" },
        { title: "Remote", inlineConfig: INLINE, inlineConfigUnconfirmed: true },
      ],
    },
  },
];

const DEFINITION: WorkspaceDefinition = { id: "ws-1", name: "Imported", tabGroups: GROUPS };

/** Waits for an outcome that depends on WebCrypto hashing (no fixed turn count). */
async function until(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
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

describe("ImportedWorkspaceConfirmations (#4445)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let cmdKey: string;
  let connKey: string;
  const staleKey = "cmd:" + "ab".repeat(32);

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({
      workspaces: [{ id: "ws-1", name: "Imported", connectionCount: 2 }],
    });
    mockedLoad.mockResolvedValue(DEFINITION);
    cmdKey = await importedCommandKey("make deploy");
    connKey = await importedConnectionKey(INLINE);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const dialogButton = (suffix: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-testid="imported-confirmations-dialog-${suffix}"]`
    );

  async function render(withEditor = false) {
    await act(async () => {
      root.render(
        <>
          <ImportedWorkspaceConfirmations />
          {withEditor && <ImportedItemsSection tabGroupDefs={GROUPS} />}
        </>
      );
    });
  }

  it("shows an empty state without a Revoke All action when nothing is confirmed", async () => {
    await render();
    expect(byTestId("imported-confirmations-count")?.textContent).toContain(
      "No imported commands or connections"
    );
    expect(byTestId("imported-confirmations-revoke-all")).toBeNull();
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("lists confirmations per workspace and unmatched keys as no longer used", async () => {
    seedSettings({ workspaceImportAllowlist: [cmdKey, connKey, staleKey] });
    await render();

    expect(byTestId("imported-confirmations-count")?.textContent).toContain("3 imported items");
    await until(() => expect(byTestId("imported-confirmations-group-ws-Imported")).not.toBeNull());

    const group = byTestId("imported-confirmations-group-ws-Imported")!;
    expect(group.textContent).toContain("Workspace “Imported”");
    expect(group.textContent).toContain("make deploy");
    expect(group.textContent).toContain("Build (Main) · runs");
    expect(group.textContent).toContain("ssh ci@build.example.com");
    expect(group.textContent).toContain("Remote (Main) · opens");

    const unused = byTestId("imported-confirmations-group-unused")!;
    expect(unused.textContent).toContain("No longer used");
    expect(unused.textContent).toContain("Command abababababab");
  });

  it("revokes one confirmation after the dialog confirms, and persists it", async () => {
    seedSettings({ workspaceImportAllowlist: [cmdKey, connKey] });
    await render();
    await until(() => expect(byTestId(`imported-confirmation-revoke-${cmdKey}`)).not.toBeNull());

    await act(async () => byTestId(`imported-confirmation-revoke-${cmdKey}`)!.click());
    expect(dialogButton("confirm")?.textContent).toContain("Revoke");
    // Nothing changes until the dialog is confirmed.
    expect(currentSettingsView().workspaceImportAllowlist).toEqual([cmdKey, connKey]);

    await act(async () => dialogButton("confirm")!.click());
    await until(() => expect(currentSettingsView().workspaceImportAllowlist).toEqual([connKey]));
    await until(() => expect(byTestId(`imported-confirmation-${cmdKey}`)).toBeNull());
    expect(byTestId(`imported-confirmation-${connKey}`)).not.toBeNull();
  });

  it("cancelling the dialog keeps the confirmation", async () => {
    seedSettings({ workspaceImportAllowlist: [cmdKey] });
    await render();
    await until(() => expect(byTestId(`imported-confirmation-revoke-${cmdKey}`)).not.toBeNull());

    await act(async () => byTestId(`imported-confirmation-revoke-${cmdKey}`)!.click());
    await act(async () => dialogButton("cancel")!.click());
    expect(currentSettingsView().workspaceImportAllowlist).toEqual([cmdKey]);
  });

  it("revokes all confirmations and leaves an empty, persisted allowlist", async () => {
    seedSettings({ workspaceImportAllowlist: [cmdKey, connKey, staleKey] });
    await render();

    await act(async () => byTestId("imported-confirmations-revoke-all")!.click());
    expect(dialogButton("confirm")?.textContent).toContain("Revoke All");
    await act(async () => dialogButton("confirm")!.click());

    await until(() => expect(currentSettingsView().workspaceImportAllowlist).toEqual([]));
    expect(byTestId("imported-confirmations-count")?.textContent).toContain(
      "No imported commands or connections"
    );
    expect(byTestId("imported-confirmations-revoke-all")).toBeNull();
  });

  it("a revoked command asks for confirmation again in the editor and at launch", async () => {
    seedSettings({ workspaceImportAllowlist: [cmdKey] });
    await render(true);
    const editorRow = () => byTestId("workspace-imported-item-0-0-0-cmd")?.textContent ?? "";
    await until(() => expect(editorRow()).toContain("Confirmed on this machine"));

    await until(() => expect(byTestId(`imported-confirmation-revoke-${cmdKey}`)).not.toBeNull());
    await act(async () => byTestId(`imported-confirmation-revoke-${cmdKey}`)!.click());
    await act(async () => dialogButton("confirm")!.click());

    await until(() => expect(editorRow()).not.toContain("Confirmed on this machine"));
    expect(byTestId("workspace-imported-confirm-0-0-0-cmd")).not.toBeNull();

    // The next launch keeps the command held instead of typing it.
    const launched = await resolveImportTrust(
      GROUPS,
      currentSettingsView().workspaceImportAllowlist
    );
    const tab = (launched[0].layout as { tabs: Array<Record<string, unknown>> }).tabs[0];
    expect(tab.pendingInitialCommand).toBe("make deploy");
    expect(tab.initialCommand).toBeUndefined();
  });

  it("treats every key as no longer used when a workspace fails to load", async () => {
    mockedLoad.mockRejectedValue(new Error("gone"));
    seedSettings({ workspaceImportAllowlist: [cmdKey] });
    await render();
    await until(() =>
      expect(byTestId("imported-confirmations-group-unused")?.textContent).toContain(
        "No longer used"
      )
    );
  });
});
