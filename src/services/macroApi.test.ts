import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listMacros, getMacro, saveMacro, deleteMacro } from "./macroApi";
import type { Macro } from "@/types/macro";

const mockedInvoke = vi.mocked(invoke);

function sampleMacro(): Macro {
  return {
    id: "macro-1",
    name: "Deploy",
    description: "Deploy sequence",
    tags: ["ops"],
    steps: [{ data: "ls\r", delayMs: 250 }],
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  };
}

describe("macroApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listMacros invokes correct command", async () => {
    mockedInvoke.mockResolvedValue([]);
    const result = await listMacros();
    expect(mockedInvoke).toHaveBeenCalledWith("list_macros");
    expect(result).toEqual([]);
  });

  it("getMacro invokes correct command with id", async () => {
    const macro = sampleMacro();
    mockedInvoke.mockResolvedValue(macro);
    const result = await getMacro("macro-1");
    expect(mockedInvoke).toHaveBeenCalledWith("get_macro", { macroId: "macro-1" });
    expect(result).toEqual(macro);
  });

  it("saveMacro invokes correct command with macroDef arg", async () => {
    const macro = sampleMacro();
    mockedInvoke.mockResolvedValue(macro);
    const result = await saveMacro(macro);
    expect(mockedInvoke).toHaveBeenCalledWith("save_macro", { macroDef: macro });
    expect(result).toEqual(macro);
  });

  it("deleteMacro invokes correct command with id", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await deleteMacro("macro-1");
    expect(mockedInvoke).toHaveBeenCalledWith("delete_macro", { macroId: "macro-1" });
  });
});
