import { describe, it, expect } from "vitest";
import { getShellLabel, SHELL_LABELS } from "./shellLabels";

describe("shellLabels", () => {
  it("labels PowerShell 7 distinctly from Windows PowerShell (#3728)", () => {
    expect(SHELL_LABELS.pwsh).toBe("PowerShell 7");
    expect(SHELL_LABELS.powershell).toBe("PowerShell");
    expect(getShellLabel("pwsh", "bash")).toBe("PowerShell 7");
  });

  it("keeps the existing powershell label for saved connections", () => {
    expect(getShellLabel("powershell", "bash")).toBe("PowerShell");
  });

  it("marks the platform default", () => {
    expect(getShellLabel("pwsh", "pwsh")).toBe("PowerShell 7 (platform default)");
    expect(getShellLabel("cmd", "pwsh")).toBe("Command Prompt");
  });

  it("labels WSL distros and falls back to the raw name", () => {
    expect(getShellLabel("wsl:Ubuntu", "pwsh")).toBe("WSL: Ubuntu");
    expect(getShellLabel("custom", "bash")).toBe("Custom");
  });
});
