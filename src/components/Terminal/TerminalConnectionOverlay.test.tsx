import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

vi.mock("lucide-react", () => ({
  ServerCrash: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
  Zap: () => null,
  Ban: () => null,
  Copy: () => null,
}));

const TAB_ID = "tab-test";
const PANEL_ID = "panel-test";

// The connect flag is sourced purely from the projected `session-lifecycle`
// region (#2205), so seed a `connecting` session there rather than the removed
// `appStore.terminalConnecting` slice. Installed file-wide (the other lifecycle
// states — spawn error, waiting-for-agent, auto-retry, reattaching — keep their
// own `appStore` slices and simply leave the region empty).
const harness = installSessionLifecycleHarness();

/** Seed a `connecting` projected session for the tab under test (flush after render). */
function seedConnecting(tabId: string = TAB_ID): void {
  harness.transport.setSession(tabId, connecting());
}

function resetStore() {
  useAppStore.setState({
    terminalSpawnErrors: {},
    terminalSpawnErrorKinds: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
  });
}

describe("TerminalConnectionOverlay — connecting state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders spinner and Connecting heading when the region reports connecting", async () => {
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    expect(container.textContent).toContain("Connecting");
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).toBeNull();
  });

  it("is hidden when isVisible is false", async () => {
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={false}
        />
      );
    });
    await flushSessionRegion();
    const el = container.querySelector("[data-testid='terminal-connection-overlay']");
    expect(el?.className).toContain("--hidden");
  });
});

describe("TerminalConnectionOverlay — abort action (keeps the tab)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows an Abort button (distinct from Cancel) while connecting", async () => {
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    expect(container.querySelector("[data-testid='terminal-connection-abort-btn']")).not.toBeNull();
    // Cancel (closes the tab) is still offered alongside Abort.
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
  });

  it("Abort calls abortTerminalConnect (not closeTab) while connecting", async () => {
    const abortFn = vi.fn();
    const closeFn = vi.fn();
    useAppStore.setState({
      abortTerminalConnect: abortFn,
      closeTab: closeFn,
    } as never);
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    act(() => {
      (
        container.querySelector("[data-testid='terminal-connection-abort-btn']") as HTMLElement
      ).click();
    });
    expect(abortFn).toHaveBeenCalledWith(TAB_ID);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("offers Abort in the waiting-for-agent state", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.querySelector("[data-testid='terminal-connection-abort-btn']")).not.toBeNull();
  });

  it("offers Abort in the auto-retrying state", () => {
    useAppStore.setState({ terminalAutoRetryCount: { [TAB_ID]: 2 } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.querySelector("[data-testid='terminal-connection-abort-btn']")).not.toBeNull();
  });
});

describe("TerminalConnectionOverlay — Retry now (skip the wait)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("waiting-for-agent Retry now fires retryTerminalSpawn immediately", () => {
    const retryFn = vi.fn();
    useAppStore.setState({
      terminalWaitingForAgent: { [TAB_ID]: "agent-1" },
      retryTerminalSpawn: retryFn,
    } as never);
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    act(() => {
      (
        container.querySelector("[data-testid='terminal-connection-retry-now-btn']") as HTMLElement
      ).click();
    });
    expect(retryFn).toHaveBeenCalledWith(TAB_ID);
  });

  it("auto-retrying Retry now fires reconnectTerminal immediately", () => {
    const reconnectFn = vi.fn();
    useAppStore.setState({
      terminalAutoRetryCount: { [TAB_ID]: 2 },
      reconnectTerminal: reconnectFn,
    } as never);
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    act(() => {
      (
        container.querySelector("[data-testid='terminal-connection-retry-now-btn']") as HTMLElement
      ).click();
    });
    expect(reconnectFn).toHaveBeenCalledWith(TAB_ID);
  });
});

describe("TerminalConnectionOverlay — auto-retrying state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows attempt number when autoRetryCount > 0", () => {
    useAppStore.setState({ terminalAutoRetryCount: { [TAB_ID]: 3 } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("attempt 4");
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
  });
});

describe("TerminalConnectionOverlay — reattaching state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows Restoring session spinner when terminalReattaching is true", () => {
    useAppStore.setState({ terminalReattaching: { [TAB_ID]: true } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("Restoring session");
    // No cancel button — user cannot interrupt a buffer fetch
    expect(container.querySelector("[data-testid='terminal-connection-cancel-btn']")).toBeNull();
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).toBeNull();
  });

  it("reattaching takes priority over waiting-for-agent", () => {
    useAppStore.setState({
      terminalReattaching: { [TAB_ID]: true },
      terminalWaitingForAgent: { [TAB_ID]: "agent-1" },
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("Restoring session");
    expect(container.textContent).not.toContain("Waiting for agent");
  });
});

describe("TerminalConnectionOverlay — waiting-for-agent state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows waiting message and only Cancel when terminalWaitingForAgent is set", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("Waiting for agent");
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
  });

  it("waiting-for-agent takes priority over auto-retrying", () => {
    useAppStore.setState({
      terminalWaitingForAgent: { [TAB_ID]: "agent-1" },
      terminalAutoRetryCount: { [TAB_ID]: 5 },
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("Waiting for agent");
  });
});

describe("TerminalConnectionOverlay — failed state", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows error box and Retry + Cancel when spawn error is set", () => {
    useAppStore.setState({ terminalSpawnErrors: { [TAB_ID]: "connection refused" } });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    expect(container.textContent).toContain("Connection failed");
    expect(container.textContent).toContain("connection refused");
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
  });

  /** Render a failed tab with the given message, typed kind, and session type. */
  function renderFailure(
    message: string,
    kind: ConnectionErrorKind | undefined,
    sessionType: string
  ): string {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: message },
      terminalSpawnErrorKinds: kind ? { [TAB_ID]: kind } : {},
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
          sessionType={sessionType}
        />
      );
    });
    return container.textContent ?? "";
  }

  it("shows the SSH agent hint for the agent-auth kind", () => {
    expect(renderFailure("Agent auth failed: x", "agent-auth", "ssh")).toContain(
      "SSH Agent not running"
    );
  });

  it("shows the timeout hint for the timeout kind", () => {
    expect(renderFailure("connection timed out", "timeout", "ssh")).toContain("timed out");
  });

  // Regression for #2088: an SSH connect timeout must give SSH-appropriate,
  // reachability-focused guidance — it must NOT tell the user to check "the
  // agent binary" (that hint belongs to agent connections, and a timeout means
  // the transport never connected in the first place).
  it("gives an SSH-appropriate timeout hint, not the agent-binary one", () => {
    const text = renderFailure("Connection timed out after 45s", "timeout", "ssh");
    expect(text).not.toContain("agent binary");
    expect(text).toContain("SSH");
    expect(text).toContain("reachable");
  });

  it("gives a telnet timeout hint free of any agent-binary mention", () => {
    const text = renderFailure("TCP connect failed: connection timed out", "timeout", "telnet");
    expect(text).not.toContain("agent binary");
    expect(text).toContain("reachable");
  });

  // #2088: the SSH ssh-agent hint (remedy: start ssh-agent) is SSH-specific and
  // must not leak onto other backends even with the agent-auth kind.
  it("does not show the SSH-agent hint on a non-SSH backend", () => {
    expect(renderFailure("Agent auth failed", "agent-auth", "telnet")).not.toContain(
      "SSH Agent not running"
    );
  });

  it("shows serial not-found hint for serial sessionType", () => {
    expect(renderFailure("Serial port '/dev/ttyUSB0' not found", "not-found", "serial")).toContain(
      "Serial port not found"
    );
  });

  it("shows serial permission hint for serial sessionType", () => {
    const text = renderFailure("Permission denied on '/dev/ttyUSB0'", "permission", "serial");
    expect(text).toContain("Permission denied");
    expect(text).toContain("dialout");
  });

  // Regression for #1830: the fix command and its guidance appear exactly once,
  // in the hint panel. The backend message states only the fact (I18N-009), so
  // the raw error box is shown verbatim — no em-dash split.
  it("does not duplicate the serial permission remediation command", () => {
    const command = "sudo usermod -aG dialout $USER";
    const text = renderFailure("Permission denied on 'COM7'", "permission", "serial");
    expect(text.split(command).length - 1).toBe(1);
    expect(text).toContain("Permission denied on 'COM7'");
    expect(text.split("dialout group").length - 1).toBe(1);
  });

  it("shows serial busy hint for serial sessionType", () => {
    expect(
      renderFailure("Serial port '/dev/ttyUSB0' is already in use", "busy", "serial")
    ).toContain("already in use by another application");
  });

  it("shows an auth hint for the auth kind on SSH", () => {
    expect(renderFailure("Authentication failed", "auth", "ssh")).toContain(
      "rejected the credentials"
    );
  });

  it("does not show serial hint for non-serial sessionType", () => {
    expect(renderFailure("No such file or directory", "not-found", "ssh")).not.toContain(
      "Serial port not found"
    );
  });

  // I18N-009: hints are selected from the typed kind, never from the message.
  // A German (OS-localized) message still gets the right hint…
  it("selects the hint from the kind for a non-English message", () => {
    const busy = renderFailure(
      "Der serielle Anschluss 'COM3' wird bereits verwendet",
      "busy",
      "serial"
    );
    expect(busy).toContain("The serial port is already in use by another application.");
    const denied = renderFailure("Zugriff verweigert auf '/dev/ttyUSB0'", "permission", "serial");
    expect(denied).toContain("dialout");
    const timeout = renderFailure("Zeitüberschreitung der Verbindung", "timeout", "ssh");
    expect(timeout).toContain("before the SSH session was established");
  });

  // …and English text that used to trigger a hint by substring match shows
  // none without a typed kind. The message is also displayed whole: nothing is
  // split off at an em dash.
  it("shows no hint for hint-like English text without a kind", () => {
    const serial = renderFailure(
      "Permission denied on 'COM7' — something busy not found timed out",
      undefined,
      "serial"
    );
    expect(serial).not.toContain("dialout");
    expect(serial).not.toContain("Serial port not found");
    expect(serial).not.toContain("already in use by another application");
    expect(serial).toContain("Permission denied on 'COM7' — something busy not found timed out");
    const ssh = renderFailure("Agent auth failed: connection timed out", undefined, "ssh");
    expect(ssh).not.toContain("SSH Agent not running");
    expect(ssh).not.toContain("before the SSH session was established");
  });

  it("Retry button calls retryTerminalSpawn", () => {
    const retryFn = vi.fn();
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "error" },
      retryTerminalSpawn: retryFn,
    } as never);
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    act(() => {
      (
        container.querySelector("[data-testid='terminal-connection-retry-btn']") as HTMLElement
      ).click();
    });
    expect(retryFn).toHaveBeenCalledWith(TAB_ID);
  });

  it("Cancel button calls closeTab with tabId and panelId", async () => {
    const closeFn = vi.fn();
    useAppStore.setState({
      closeTab: closeFn,
    } as never);
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    act(() => {
      (
        container.querySelector("[data-testid='terminal-connection-cancel-btn']") as HTMLElement
      ).click();
    });
    expect(closeFn).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
  });
});

describe("TerminalConnectionOverlay — elapsed time", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows an elapsed-time readout while connecting", async () => {
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    // Starts at 0s.
    expect(container.textContent).toContain("0s");
    // Advances one second at a time.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain("3s");
  });

  it("surfaces a slow-connection hint once the connect drags on", async () => {
    seedConnecting();
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="my-server"
          isVisible={true}
        />
      );
    });
    await flushSessionRegion();
    // No hint early on.
    expect(container.textContent).not.toContain("Taking longer than usual");
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(container.textContent).toContain("Taking longer than usual");
  });
});
