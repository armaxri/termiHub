/**
 * Local shell tabs are named after their shell and numbered (#5829). The
 * product-run UI review saw several tabs (and their "Closed …" reopen toasts)
 * all reading "Terminal". `addLocalShellTab` names a new tab after the default
 * shell and numbers it when the name is taken; open tabs, renamed ones
 * included, are never renamed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { TerminalTab } from "@/types/terminal";
import { collectLiveTabs } from "./layoutHelpers";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

import { useAppStore } from "./appStore";

const titles = () => collectLiveTabs(useAppStore.getState()).map((t: TerminalTab) => t.title);
const titleOf = (id: string) =>
  collectLiveTabs(useAppStore.getState()).find((t) => t.id === id)?.title;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ defaultShell: "zsh" });
});

describe("addLocalShellTab (#5829)", () => {
  it("names the first tab after the default shell, not 'Terminal'", () => {
    const id = useAppStore.getState().addLocalShellTab();
    expect(titleOf(id)).toBe("zsh");
  });

  it("numbers further tabs of the same shell", () => {
    const { addLocalShellTab } = useAppStore.getState();
    addLocalShellTab();
    addLocalShellTab();
    addLocalShellTab();
    expect(titles()).toEqual(["zsh", "zsh 2", "zsh 3"]);
  });

  it("opens a local shell of the default shell", () => {
    const id = useAppStore.getState().addLocalShellTab();
    const tab = collectLiveTabs(useAppStore.getState()).find((t) => t.id === id);
    expect(tab?.connectionType).toBe("local");
    expect(tab?.config).toEqual({ type: "local", config: { shell: "zsh" } });
  });

  it("follows the current default shell", () => {
    useAppStore.getState().addLocalShellTab();
    useAppStore.setState({ defaultShell: "bash" });
    const id = useAppStore.getState().addLocalShellTab();
    expect(titleOf(id)).toBe("bash");
  });

  it("never renames an open tab, and a renamed tab frees its default name", () => {
    const { addLocalShellTab, renameTab } = useAppStore.getState();
    const first = addLocalShellTab();
    const second = addLocalShellTab();
    renameTab(first, "build");
    expect(titleOf(first)).toBe("build");
    expect(titleOf(second)).toBe("zsh 2");
    const third = addLocalShellTab();
    expect(titleOf(third)).toBe("zsh");
    expect(titles()).toEqual(["build", "zsh 2", "zsh"]);
  });

  it("leaves a title alone without numberTitle (saved connections, reopen)", () => {
    const { addTab } = useAppStore.getState();
    addTab("web", "local");
    addTab("web", "local");
    expect(titles()).toEqual(["web", "web"]);
  });

  it("numbers an addTab title only with numberTitle", () => {
    const { addTab } = useAppStore.getState();
    addTab("pi · bash", "remote-session", undefined, { numberTitle: true });
    addTab("pi · bash", "remote-session", undefined, { numberTitle: true });
    expect(titles()).toEqual(["pi · bash", "pi · bash 2"]);
  });
});
