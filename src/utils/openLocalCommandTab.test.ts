/**
 * Tests for the shared "open a local terminal tab pre-loaded with a command"
 * helper, used by the connection-list ping action and the guided Homebrew
 * install (#1117). Asserts it opens a local tab with the command as its initial
 * command, and reports back when no local shell is available to host it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openLocalCommandTab } from "./openLocalCommandTab";
import { useAppStore } from "@/store/appStore";
import { listAvailableShells } from "@/services/api";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  listAvailableShells: vi.fn(),
}));

const mockedListShells = vi.mocked(listAvailableShells);

describe("openLocalCommandTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a local tab with the command as its initial command", async () => {
    mockedListShells.mockResolvedValue(["bash", "zsh"]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab").mockReturnValue("tab-1");

    const opened = await openLocalCommandTab("Ping host", "ping host");

    expect(opened).toBe(true);
    expect(addTab).toHaveBeenCalledTimes(1);
    const [title, connectionType, config] = addTab.mock.calls[0];
    expect(title).toBe("Ping host");
    expect(connectionType).toBe("local");
    expect(config).toMatchObject({
      type: "local",
      config: { shell: "bash", initialCommand: "ping host" },
    });
    addTab.mockRestore();
  });

  it("returns false without opening a tab when no local shell is available", async () => {
    mockedListShells.mockResolvedValue([]);
    const addTab = vi.spyOn(useAppStore.getState(), "addTab");

    const opened = await openLocalCommandTab("Ping host", "ping host");

    expect(opened).toBe(false);
    expect(addTab).not.toHaveBeenCalled();
    addTab.mockRestore();
  });
});
