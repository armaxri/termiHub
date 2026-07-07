import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  TerminalConnectionOverlay,
  CONNECT_TIMEOUT_SECONDS,
  WAITING_FOR_AGENT_TIMEOUT_SECONDS,
} from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";

vi.mock("lucide-react", () => ({
  ServerCrash: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
}));

const TAB_ID = "tab-test";
const PANEL_ID = "panel-test";

function resetStore() {
  useAppStore.setState({
    terminalConnecting: {},
    terminalSpawnErrors: {},
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

  it("renders spinner and Connecting heading when terminalConnecting is true", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
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
    expect(container.textContent).toContain("Connecting");
    expect(
      container.querySelector("[data-testid='terminal-connection-cancel-btn']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='terminal-connection-retry-btn']")).toBeNull();
  });

  it("is hidden when isVisible is false", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
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
    const el = container.querySelector("[data-testid='terminal-connection-overlay']");
    expect(el?.className).toContain("--hidden");
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

  it("shows SSH agent hint when error contains 'Agent auth failed'", () => {
    useAppStore.setState({ terminalSpawnErrors: { [TAB_ID]: "Agent auth failed" } });
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
    expect(container.textContent).toContain("SSH Agent not running");
  });

  it("shows timeout hint when error contains 'timed out'", () => {
    useAppStore.setState({ terminalSpawnErrors: { [TAB_ID]: "connection timed out" } });
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
    expect(container.textContent).toContain("timed out");
  });

  it("shows serial not-found hint for serial sessionType", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "Serial port '/dev/ttyUSB0' not found — check connected" },
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
    expect(container.textContent).toContain("Serial port not found");
  });

  it("shows serial permission hint for serial sessionType", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "Permission denied on '/dev/ttyUSB0'" },
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
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain("dialout");
  });

  it("shows serial busy hint for serial sessionType", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "Serial port '/dev/ttyUSB0' is already in use" },
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
    expect(container.textContent).toContain("already in use");
  });

  it("does not show serial hint for non-serial sessionType", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "No such file or directory" },
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="ssh"
          isVisible={true}
          sessionType="ssh"
        />
      );
    });
    expect(container.textContent).not.toContain("Serial port not found");
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

  it("Cancel button calls closeTab with tabId and panelId", () => {
    const closeFn = vi.fn();
    useAppStore.setState({
      terminalConnecting: { [TAB_ID]: true },
      closeTab: closeFn,
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

  it("shows an elapsed-time readout while connecting", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
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
    // Starts at 0s.
    expect(container.textContent).toContain("0s");
    // Advances one second at a time.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain("3s");
  });

  it("surfaces a slow-connection hint once the connect drags on", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
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
    // No hint early on.
    expect(container.textContent).not.toContain("Taking longer than usual");
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(container.textContent).toContain("Taking longer than usual");
  });
});

describe("TerminalConnectionOverlay — connect timeouts (#1129)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function render() {
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
  }

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

  it("transitions waiting-for-agent to Failed with a cause hint after the bounded wait", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render();
    expect(container.textContent).toContain("Waiting for agent");

    // Just before the deadline: still parked, no failure recorded yet.
    act(() => {
      vi.advanceTimersByTime((WAITING_FOR_AGENT_TIMEOUT_SECONDS - 1) * 1000);
    });
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
    expect(useAppStore.getState().terminalWaitingForAgent[TAB_ID]).toBe("agent-1");

    // Cross the deadline — the wait must settle as Failed with a hint.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const error = useAppStore.getState().terminalSpawnErrors[TAB_ID];
    expect(error).toBeDefined();
    expect(error).toContain(`${WAITING_FOR_AGENT_TIMEOUT_SECONDS}s`);
    expect(error?.toLowerCase()).toContain("agent");
    // Waiting state is cleared so the overlay renders the Failed view.
    expect(useAppStore.getState().terminalWaitingForAgent[TAB_ID]).toBeUndefined();
    expect(container.textContent).toContain("Connection failed");
  });

  it("does not fire the waiting-for-agent timeout when the connect settles first", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Agent came online / session went live — waiting cleared before the deadline.
    act(() => {
      useAppStore.setState({ terminalWaitingForAgent: {} });
    });

    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_SECONDS * 1000 + 2000);
    });
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
  });

  it("clears the waiting-for-agent timeout on unmount so it never fires against a torn-down attempt", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render();

    act(() => root.unmount());

    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_SECONDS * 1000 + 2000);
    });
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
  });

  it("transitions a plain connecting attempt to Failed after the connect timeout", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
    render();

    act(() => {
      vi.advanceTimersByTime((CONNECT_TIMEOUT_SECONDS - 1) * 1000);
    });
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const error = useAppStore.getState().terminalSpawnErrors[TAB_ID];
    expect(error).toBeDefined();
    expect(error).toContain(`${CONNECT_TIMEOUT_SECONDS}s`);
    expect(useAppStore.getState().terminalConnecting[TAB_ID]).toBeUndefined();
  });

  it("does not apply the connect timeout during bounded auto-retries", () => {
    useAppStore.setState({
      terminalConnecting: { [TAB_ID]: true },
      terminalAutoRetryCount: { [TAB_ID]: 2 },
    });
    render();

    act(() => {
      vi.advanceTimersByTime(CONNECT_TIMEOUT_SECONDS * 1000 + 2000);
    });
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
  });
});
