import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectAvailableShells,
  getDefaultShell,
  isWslShell,
  getWslDistroName,
  wslToWindowsPath,
  windowsToWslPath,
} from "./shell-detection";
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

  describe("detectAvailableShells with WSL", () => {
    it("returns WSL distros from the backend", async () => {
      mockedListAvailableShells.mockResolvedValue([
        "powershell",
        "cmd",
        "gitbash",
        "wsl:Ubuntu",
        "wsl:Debian",
      ]);

      const result = await detectAvailableShells();
      expect(result).toContain("wsl:Ubuntu");
      expect(result).toContain("wsl:Debian");
      expect(result).toHaveLength(5);
    });
  });

  describe("isWslShell", () => {
    it("returns true for WSL shell types", () => {
      expect(isWslShell("wsl:Ubuntu")).toBe(true);
      expect(isWslShell("wsl:Debian")).toBe(true);
      expect(isWslShell("wsl:Ubuntu-22.04")).toBe(true);
    });

    it("returns false for non-WSL shell types", () => {
      expect(isWslShell("bash")).toBe(false);
      expect(isWslShell("zsh")).toBe(false);
      expect(isWslShell("powershell")).toBe(false);
      expect(isWslShell("cmd")).toBe(false);
      expect(isWslShell("gitbash")).toBe(false);
    });
  });

  describe("getWslDistroName", () => {
    it("extracts distro name from WSL shell types", () => {
      expect(getWslDistroName("wsl:Ubuntu")).toBe("Ubuntu");
      expect(getWslDistroName("wsl:Debian")).toBe("Debian");
      expect(getWslDistroName("wsl:Ubuntu-22.04")).toBe("Ubuntu-22.04");
    });

    it("returns null for non-WSL shell types", () => {
      expect(getWslDistroName("bash")).toBeNull();
      expect(getWslDistroName("zsh")).toBeNull();
      expect(getWslDistroName("powershell")).toBeNull();
    });
  });

  describe("wslToWindowsPath", () => {
    it("converts a home directory path via UNC", () => {
      expect(wslToWindowsPath("/home/user", "Ubuntu")).toBe("//wsl$/Ubuntu/home/user");
    });

    it("converts the root path via UNC", () => {
      expect(wslToWindowsPath("/", "Debian")).toBe("//wsl$/Debian/");
    });

    it("handles distro names with version numbers", () => {
      expect(wslToWindowsPath("/home/user/docs", "Ubuntu-22.04")).toBe(
        "//wsl$/Ubuntu-22.04/home/user/docs"
      );
    });

    it("converts /mnt/c/ paths to native Windows drive paths", () => {
      expect(wslToWindowsPath("/mnt/c/Users/richtera", "Ubuntu")).toBe("C:/Users/richtera");
    });

    it("converts /mnt/d/ paths to D: drive", () => {
      expect(wslToWindowsPath("/mnt/d/projects/app", "Ubuntu")).toBe("D:/projects/app");
    });

    it("converts bare /mnt/c to C:/", () => {
      expect(wslToWindowsPath("/mnt/c", "Ubuntu")).toBe("C:/");
    });

    it("does not convert /mnt/wsl or other non-drive /mnt paths", () => {
      expect(wslToWindowsPath("/mnt/wsl/docker", "Ubuntu")).toBe("//wsl$/Ubuntu/mnt/wsl/docker");
    });
  });

  describe("windowsToWslPath", () => {
    it("converts a UNC WSL path (forward slashes) back to a Linux path", () => {
      expect(windowsToWslPath("//wsl$/Ubuntu/home/user")).toBe("/home/user");
    });

    it("converts a UNC WSL root path back to /", () => {
      expect(windowsToWslPath("//wsl$/Debian/")).toBe("/");
    });

    it("converts a UNC WSL path with a named distro", () => {
      expect(windowsToWslPath("//wsl$/Ubuntu-22.04/home/user/docs")).toBe("/home/user/docs");
    });

    it("converts a Windows drive path to /mnt/<drive>", () => {
      expect(windowsToWslPath("C:/Users/richtera")).toBe("/mnt/c/Users/richtera");
    });

    it("converts a Windows drive root to /mnt/<drive>", () => {
      expect(windowsToWslPath("C:/")).toBe("/mnt/c");
    });

    it("converts a Windows drive path with backslashes", () => {
      expect(windowsToWslPath("D:\\projects\\app")).toBe("/mnt/d/projects/app");
    });

    it("returns an already-Unix path unchanged", () => {
      expect(windowsToWslPath("/home/user/docs")).toBe("/home/user/docs");
    });

    it("is the inverse of wslToWindowsPath for WSL filesystem paths", () => {
      const linux = "/home/user/project";
      expect(windowsToWslPath(wslToWindowsPath(linux, "Ubuntu"))).toBe(linux);
    });

    it("is the inverse of wslToWindowsPath for Windows drive paths", () => {
      const linux = "/mnt/c/Users/arne";
      expect(windowsToWslPath(wslToWindowsPath(linux, "Ubuntu"))).toBe(linux);
    });
  });
});
