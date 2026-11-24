import { describe, it, expect } from "vitest";
import { localShellChip, shellDisplayName } from "./localShellChip";

describe("shellDisplayName (#5839)", () => {
  it("uses the picker's shell names", () => {
    expect(shellDisplayName("zsh")).toBe("Zsh");
    expect(shellDisplayName("pwsh")).toBe("PowerShell 7");
    expect(shellDisplayName("wsl:Ubuntu")).toBe("WSL: Ubuntu");
    expect(shellDisplayName(undefined)).toBe("Local shell");
  });
});

describe("localShellChip (#5839)", () => {
  it("names the shell of a local terminal tab", () => {
    const chip = localShellChip({ type: "local", config: { shell: "zsh" } }, "terminal");
    expect(chip).toEqual({ label: "Zsh", tooltip: "Local shell: Zsh" });
  });

  it("reads the legacy shellType alias and adds the start directory", () => {
    const chip = localShellChip(
      { type: "local", config: { shellType: "bash", startingDirectory: "~/work" } },
      "terminal"
    );
    expect(chip).toEqual({ label: "Bash", tooltip: "Local shell: Bash\nStarts in ~/work" });
  });

  it("names a WSL distribution", () => {
    const chip = localShellChip({ type: "wsl", config: { distribution: "Debian" } }, "terminal");
    expect(chip?.label).toBe("WSL: Debian");
  });

  it("is hidden for non-terminal tabs and remote connections", () => {
    // Settings and editor tabs carry a placeholder local config.
    expect(localShellChip({ type: "local", config: { shell: "zsh" } }, "settings")).toBeNull();
    expect(localShellChip({ type: "ssh", config: { host: "h" } }, "terminal")).toBeNull();
    expect(localShellChip(undefined, "terminal")).toBeNull();
  });
});
