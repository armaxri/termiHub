/**
 * Tests for the guided Git-for-Windows install gate (#1672). The gate decides
 * when termiHub offers to install Git for Windows: only on Windows, and only
 * when no Unix shell (Git Bash or a WSL distro) was detected. It is a pure
 * function so it is exercised on every CI platform, not just Windows.
 */
import { describe, it, expect } from "vitest";
import type { ShellType } from "@/types/terminal";
import {
  GIT_FOR_WINDOWS_DOWNLOAD_URL,
  GIT_FOR_WINDOWS_WINGET_COMMAND,
  hasUnixShell,
  shouldOfferGitBashSetup,
} from "./gitBashSetup";

describe("gitBashSetup constants", () => {
  it("uses the documented winget id and an -e exact match", () => {
    expect(GIT_FOR_WINDOWS_WINGET_COMMAND).toContain("winget install");
    expect(GIT_FOR_WINDOWS_WINGET_COMMAND).toContain("Git.Git");
    expect(GIT_FOR_WINDOWS_WINGET_COMMAND).toContain("-e");
  });

  it("points the manual fallback at the official git-scm download page", () => {
    expect(GIT_FOR_WINDOWS_DOWNLOAD_URL).toBe("https://git-scm.com/download/win");
  });
});

describe("hasUnixShell", () => {
  it("is true when Git Bash is present", () => {
    expect(hasUnixShell(["powershell", "cmd", "gitbash"] as ShellType[])).toBe(true);
  });

  it("is true for a WSL distro", () => {
    expect(hasUnixShell(["powershell", "cmd", "wsl:Ubuntu"] as ShellType[])).toBe(true);
  });

  it("is true for plain bash / zsh / sh", () => {
    expect(hasUnixShell(["bash"] as ShellType[])).toBe(true);
    expect(hasUnixShell(["zsh"] as ShellType[])).toBe(true);
    expect(hasUnixShell(["sh"] as unknown as ShellType[])).toBe(true);
  });

  it("is false for a Windows box with only native shells", () => {
    expect(hasUnixShell(["powershell", "cmd"] as ShellType[])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(hasUnixShell([])).toBe(false);
  });
});

describe("shouldOfferGitBashSetup", () => {
  it("offers setup on Windows with no Unix shell", () => {
    expect(shouldOfferGitBashSetup(true, ["powershell", "cmd"] as ShellType[])).toBe(true);
  });

  it("does not offer setup on Windows when Git Bash is already detected", () => {
    expect(shouldOfferGitBashSetup(true, ["powershell", "cmd", "gitbash"] as ShellType[])).toBe(
      false
    );
  });

  it("does not offer setup on Windows when a WSL distro is present", () => {
    expect(shouldOfferGitBashSetup(true, ["powershell", "wsl:Debian"] as ShellType[])).toBe(false);
  });

  it("never offers setup off Windows, even with no Unix shell", () => {
    expect(shouldOfferGitBashSetup(false, ["cmd"] as ShellType[])).toBe(false);
    expect(shouldOfferGitBashSetup(false, [] as ShellType[])).toBe(false);
  });
});
