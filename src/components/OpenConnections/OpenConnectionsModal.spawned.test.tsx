/**
 * Tests for the "Spawned Containers" section of the Open Connections panel
 * (#1446, #1466): spawned containers (opened from a CLI/context-menu spawn, no
 * saved connection id) are tracked separately from configured Docker
 * connections and are not double-listed under "Local Sessions".
 *
 * Grouping is driven by the authoritative backend marker
 * (`LocalSessionInfo.spawned`, #1466) so a spawned container stays under
 * "Spawned Containers" — and killable — even after its owning tab is closed
 * (the orphan case the panel exists to surface). The frontend tab flag still
 * feeds the tab badge and is honoured as a fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab } from "@/types/terminal";
import type { LocalSessionInfo } from "@/services/api";

const closeTerminal = vi.fn((_id: string, _intentional?: boolean) => Promise.resolve());
const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: (id: string, intentional?: boolean) => closeTerminal(id, intentional),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  pruneDeadAgents: vi.fn(() => Promise.resolve([])),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false, sessionCount: 0 })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorStopAll: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

/** The spawned container session as reported by the backend registry. */
const SPAWNED_SESSION: LocalSessionInfo = {
  id: "sess-spawn",
  title: "Container: alpine:3 (Spawned)",
  connectionType: "docker",
  alive: true,
  spawned: true,
};

/** A normal local session (never spawned). */
const PLAIN_SESSION: LocalSessionInfo = {
  id: "sess-plain",
  title: "My Shell",
  connectionType: "local",
  alive: true,
  spawned: false,
};

function spawnedTab(id: string, title: string, sessionId: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId,
    title,
    connectionType: "docker",
    contentType: "terminal",
    config: { type: "docker", config: {} },
    panelId,
    isActive: true,
    spawned: true,
  };
}

function rowsMatching(text: string): Element[] {
  return Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(text)
  );
}

function sectionTitleFor(text: string): string | undefined {
  // Walk up from the matching row to its section wrapper and read the header.
  const row = rowsMatching(text)[0];
  const section = row?.closest("[data-testid='open-connections-spawned-section']");
  if (section) return "Spawned Containers";
  return row
    ?.closest("div")
    ?.parentElement?.querySelector(".oc-section__title")
    ?.textContent?.trim();
}

describe("OpenConnectionsModal — Spawned Containers section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    closeTerminal.mockClear();
    listLocalSessions.mockReset();
    listLocalSessions.mockResolvedValue([SPAWNED_SESSION, PLAIN_SESSION]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function renderWithSpawnedTab() {
    const leafId = useAppStore.getState().rootPanel.id;
    const tab = spawnedTab("tab-1", "Container: alpine:3 (Spawned)", "sess-spawn", leafId);
    useAppStore.setState({
      rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
      activePanelId: leafId,
    });
    await renderModal();
  }

  it("lists the spawned container in its own section", async () => {
    await renderWithSpawnedTab();
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).toContain("Spawned Containers");
    expect(rowsMatching("Container: alpine:3").length).toBeGreaterThanOrEqual(1);
  });

  it("does not double-list the spawned session under Local Sessions", async () => {
    await renderWithSpawnedTab();
    // Exactly one row mentions the spawned container — it lives in its own
    // section, not also under Local Sessions.
    expect(rowsMatching("Container: alpine:3")).toHaveLength(1);
    // The plain local session is still listed.
    expect(rowsMatching("My Shell")).toHaveLength(1);
  });

  it("kills a spawned container via close_terminal", async () => {
    await renderWithSpawnedTab();
    const row = rowsMatching("Container: alpine:3")[0];
    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    await act(async () => {
      killBtn.click();
      await Promise.resolve();
    });
    // The kill routes the intentional kill-intent flag to the backend (#2439).
    expect(closeTerminal).toHaveBeenCalledWith("sess-spawn", true);
  });

  it("groups a spawned session from the backend marker alone (no spawned tab flag)", async () => {
    // No live tab carries the frontend `spawned` flag — only the backend
    // `LocalSessionInfo.spawned` marker identifies it (#1466).
    await renderModal();
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).toContain("Spawned Containers");
    expect(sectionTitleFor("Container: alpine:3")).toBe("Spawned Containers");
    // Still exactly one row and not under Local Sessions.
    expect(rowsMatching("Container: alpine:3")).toHaveLength(1);
  });

  it("keeps an orphaned spawned session (tab closed) under Spawned Containers and killable", async () => {
    // The spawned container's tab was closed, so the backend session leaked
    // (orphan). It must still surface under Spawned Containers — never fall back
    // into Local Sessions — and stay killable (#1466).
    listLocalSessions.mockResolvedValue([SPAWNED_SESSION]);
    await renderModal(); // no tabs at all

    expect(sectionTitleFor("Container: alpine:3")).toBe("Spawned Containers");

    const localTitles = Array.from(document.querySelectorAll(".oc-section__title"))
      .map((t) => t.textContent)
      .filter((t) => t === "Local Sessions");
    expect(localTitles).toHaveLength(0);

    const row = rowsMatching("Container: alpine:3")[0];
    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    await act(async () => {
      killBtn.click();
      await Promise.resolve();
    });
    // The kill routes the intentional kill-intent flag to the backend (#2439).
    expect(closeTerminal).toHaveBeenCalledWith("sess-spawn", true);
  });
});
