import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectAvailableShells, getDefaultShell } from "./shell-detection";
import { listAvailableShells } from "@/services/api";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(),
}));

const mockedListAvailableShells = vi.mocked(listAvailableShells);

describe("shell-detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectAvailableShells", () => {
    it("returns shells from the backend", async () => {
      mockedListAvailableShells.mockResolvedValue(["zsh", "bash"]);

      const result = await detectAvailableShells();
      expect(result).toEqual(["zsh", "bash"]);
      expect(mockedListAvailableShells).toHaveBeenCalledOnce();
    });

    it("returns single shell when only one is available", async () => {
      mockedListAvailableShells.mockResolvedValue(["cmd"]);

      const result = await detectAvailableShells();
      expect(result).toEqual(["cmd"]);
    });

    it("returns all shell types when backend reports them", async () => {
      mockedListAvailableShells.mockResolvedValue(["zsh", "bash", "cmd", "powershell", "gitbash"]);

      const result = await detectAvailableShells();
      expect(result).toHaveLength(5);
    });

    it("falls back to bash and zsh when backend fails", async () => {
      mockedListAvailableShells.mockRejectedValue(new Error("Backend unavailable"));

      const result = await detectAvailableShells();
      expect(result).toEqual(["bash", "zsh"]);
    });
  });

  describe("getDefaultShell", () => {
    it("returns the first available shell", async () => {
      mockedListAvailableShells.mockResolvedValue(["zsh", "bash"]);

      const result = await getDefaultShell();
      expect(result).toBe("zsh");
    });

    it("returns bash when backend returns bash first", async () => {
      mockedListAvailableShells.mockResolvedValue(["bash", "zsh"]);

      const result = await getDefaultShell();
      expect(result).toBe("bash");
    });

    it("falls back to bash when backend fails", async () => {
      mockedListAvailableShells.mockRejectedValue(new Error("Backend unavailable"));

      const result = await getDefaultShell();
      expect(result).toBe("bash");
    });
  });
});
