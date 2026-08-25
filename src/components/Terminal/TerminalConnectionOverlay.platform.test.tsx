/**
 * Platform-awareness test for the "Connection failed" dialog's serial permission
 * hint (#1831).
 *
 * A serial permission error used to show the Linux `dialout`-group instruction on
 * every OS — including Windows, where the port is a `COM` port and there is no
 * such group. These tests pin that the remediation now follows the host OS:
 * Linux shows the `usermod` fix command, while Windows and macOS show generic
 * guidance and never the dialout advice. The OS is injected by mocking
 * `getPlatform`, so the branching is exercised deterministically on any CI host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const platformMock = vi.hoisted(() => ({ value: "linux" as "windows" | "macos" | "linux" }));

vi.mock("@/utils/platform", () => ({
  getPlatform: () => platformMock.value,
  isWindows: () => platformMock.value === "windows",
  isMac: () => platformMock.value === "macos",
}));

vi.mock("lucide-react", () => ({
  ServerCrash: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
  Zap: () => null,
  Ban: () => null,
  Copy: () => null,
}));

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";

const TAB_ID = "tab-platform";
const PANEL_ID = "panel-platform";
const DIALOUT_COMMAND = "sudo usermod -aG dialout $USER";

let container: HTMLDivElement;
let root: Root;

function renderSerialPermissionFailure(port: string) {
  useAppStore.setState({
    terminalSpawnErrors: { [TAB_ID]: `Permission denied on '${port}'` },
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
  });
  act(() => {
    root.render(
      <TerminalConnectionOverlay
        tabId={TAB_ID}
        panelId={PANEL_ID}
        tabTitle="serial"
        isVisible={true}
        sessionType="serial"
      />
    );
  });
}

describe("TerminalConnectionOverlay — platform-aware serial permission hint (#1831)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    platformMock.value = "linux";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the dialout fix command on Linux", () => {
    platformMock.value = "linux";
    renderSerialPermissionFailure("/dev/ttyUSB0");
    const text = container.textContent ?? "";
    expect(text).toContain("Permission denied");
    expect(text).toContain("dialout");
    expect(text).toContain(DIALOUT_COMMAND);
  });

  it("does not show the Linux dialout advice on Windows", () => {
    platformMock.value = "windows";
    renderSerialPermissionFailure("COM7");
    const text = container.textContent ?? "";
    // Still surfaces the permission failure, just not the Linux remedy.
    expect(text).toContain("Permission denied");
    expect(text).not.toContain("dialout");
    expect(text).not.toContain(DIALOUT_COMMAND);
    // No copyable command block on Windows — there is no valid one to run.
    expect(
      container.querySelector("[data-testid='terminal-connection-serial-copy-btn']")
    ).toBeNull();
    // Windows-appropriate guidance instead.
    expect(text).toContain("Another application may be using the port");
  });

  it("does not show the Linux dialout advice on macOS", () => {
    platformMock.value = "macos";
    renderSerialPermissionFailure("/dev/tty.usbserial");
    const text = container.textContent ?? "";
    expect(text).toContain("Permission denied");
    expect(text).not.toContain("dialout");
    expect(text).not.toContain(DIALOUT_COMMAND);
    expect(
      container.querySelector("[data-testid='terminal-connection-serial-copy-btn']")
    ).toBeNull();
  });
});

/**
 * #2088: the SSH-agent-not-running hint used to show a Windows-only PowerShell
 * `Set-Service ssh-agent` command on every OS, which is non-actionable on
 * macOS/Linux (no such service exists there). The remedy must follow the host
 * OS, mirroring ConnectionEditor's "Setup SSH Agent" button.
 */
describe("TerminalConnectionOverlay — platform-aware SSH-agent hint (#2088)", () => {
  const WIN_COMMAND = "Set-Service ssh-agent";
  const UNIX_COMMAND = 'eval "$(ssh-agent -s)" && ssh-add';

  function renderAgentAuthFailure() {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "Agent auth failed" },
      terminalAutoRetryCount: {},
      terminalWaitingForAgent: {},
      terminalRetryCounters: {},
      terminalReattaching: {},
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
          sessionType="ssh"
        />
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    platformMock.value = "linux";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the PowerShell service command on Windows", () => {
    platformMock.value = "windows";
    renderAgentAuthFailure();
    const text = container.textContent ?? "";
    expect(text).toContain("SSH Agent not running");
    expect(text).toContain(WIN_COMMAND);
    expect(text).not.toContain(UNIX_COMMAND);
  });

  it("shows the ssh-agent/ssh-add command on macOS, not the Windows one", () => {
    platformMock.value = "macos";
    renderAgentAuthFailure();
    const text = container.textContent ?? "";
    expect(text).toContain("SSH Agent not running");
    expect(text).toContain(UNIX_COMMAND);
    expect(text).not.toContain(WIN_COMMAND);
  });

  it("shows the ssh-agent/ssh-add command on Linux, not the Windows one", () => {
    platformMock.value = "linux";
    renderAgentAuthFailure();
    const text = container.textContent ?? "";
    expect(text).toContain(UNIX_COMMAND);
    expect(text).not.toContain(WIN_COMMAND);
  });
});
