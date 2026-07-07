import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import {
  WAITING_FOR_AGENT_TIMEOUT_MS,
  CONNECTING_TIMEOUT_MS,
  connectTimeoutMessage,
} from "@/utils/connectTimeout";

vi.mock("lucide-react", () => ({
  ServerCrash: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
}));

const TAB_ID = "tab-timeout";
const PANEL_ID = "panel-test";

function resetStore() {
  useAppStore.setState({
    terminalConnecting: {},
    terminalSpawnErrors: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
  });
}

function render(root: ReturnType<typeof createRoot>) {
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

describe("TerminalConnectionOverlay — timeouts", () => {
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

  it("shows a visible timeout countdown while waiting for the agent", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render(root);
    // The overlay must communicate that the wait is bounded.
    expect(container.textContent).toContain("Times out in");
  });

  it("transitions the waiting-for-agent tab to Failed after the timeout elapses", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render(root);

    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalWaitingForAgent[TAB_ID]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBe(
      connectTimeoutMessage("waiting-for-agent")
    );
  });

  it("does not fire the timeout if the agent connects before it elapses", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render(root);

    // Agent came online: clear the wait before the timeout.
    act(() => {
      useAppStore.setState({ terminalWaitingForAgent: {} });
    });
    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
  });

  it("transitions the connecting tab to Failed after the connect timeout elapses", () => {
    useAppStore.setState({ terminalConnecting: { [TAB_ID]: true } });
    render(root);

    act(() => {
      vi.advanceTimersByTime(CONNECTING_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBe(
      connectTimeoutMessage("connecting")
    );
  });
});
