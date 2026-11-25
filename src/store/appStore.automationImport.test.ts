/** Importing automations through the store (#1677, #5818 slice 11). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  // Only an import marks it as one (#6019).
  saveAutomation: vi.fn(() => Promise.reject(new Error("not for a file"))),
  importAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
}));

import { listAutomations, importAutomation } from "@/services/automationApi";
import type { Automation } from "@/types/generated/Automation";
import { useAppStore } from "./appStore";
import { automationLibraryState } from "./slices/automationStoreState";

const macroFile = (...names: string[]) =>
  JSON.stringify({
    version: 1,
    macros: names.map((name) => ({ name, steps: [{ data: "ls\r", delayMs: 0 }] })),
  });
const stored: Automation = {
  id: "s",
  name: "Deploy",
  tags: [],
  steps: [],
  triggers: [],
  createdAt: "",
  updatedAt: "",
};

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  vi.mocked(listAutomations).mockResolvedValue([]);
  vi.mocked(importAutomation).mockImplementation((a) => Promise.resolve(a));
});

describe("importAutomations", () => {
  it("saves every entry under a fresh id and a free name, then reloads once", async () => {
    useAppStore.setState(automationLibraryState([stored]));
    const result = await useAppStore.getState().importAutomations(macroFile("Deploy", "Login"));
    const saved = vi.mocked(importAutomation).mock.calls.map(([a]) => a);
    expect(saved.map((a) => a.name)).toEqual(["Deploy (imported)", "Login"]);
    expect(saved.every((a) => a.id.startsWith("automation-"))).toBe(true);
    expect(result.automations).toEqual(saved);
    expect(listAutomations).toHaveBeenCalledTimes(1);
  });

  it("touches nothing for a malformed file", async () => {
    await expect(useAppStore.getState().importAutomations("{}")).rejects.toThrow(
      "holds no automations"
    );
    expect(importAutomation).not.toHaveBeenCalled();
    expect(listAutomations).not.toHaveBeenCalled();
  });

  it("says how far it came when saving fails, and shows what was saved", async () => {
    vi.mocked(importAutomation)
      .mockImplementationOnce((a) => Promise.resolve(a))
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      useAppStore.getState().importAutomations(macroFile("A", "B", "C"))
    ).rejects.toThrow('"B" could not be saved (disk full). Imported 1 of 3.');
    expect(listAutomations).toHaveBeenCalledTimes(1);
  });
});
