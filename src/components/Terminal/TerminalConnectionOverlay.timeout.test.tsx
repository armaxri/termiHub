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
  Zap: () => null,
  Ban: () => null,
}));

const TAB_ID = "tab-timeout";
const PANEL_ID = "panel-test";

function resetStore() {
  useAppStore.setState({
    terminalConnectDeadline: {},
    terminalSpawnErrors: {},
    terminalSpawnErrorKinds: {},
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
    useAppStore.getState().setTerminalWaitingForAgent(TAB_ID, "agent-1");
    render(root);
    // The overlay must communicate that the wait is bounded.
    expect(container.textContent).toContain("Times out in");
  });

  it("transitions the waiting-for-agent tab to Failed after the timeout elapses", () => {
    useAppStore.getState().setTerminalWaitingForAgent(TAB_ID, "agent-1");
    render(root);

    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalWaitingForAgent[TAB_ID]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBe(
      connectTimeoutMessage("waiting-for-agent")
    );
    // Waiting on the parent agent is not the tab's own backend timing out, so
    // it carries no typed timeout kind (I18N-009).
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBeUndefined();
  });

  it("does not fire the timeout if the agent connects before it elapses", () => {
    useAppStore.getState().setTerminalWaitingForAgent(TAB_ID, "agent-1");
    render(root);

    // Agent came online: clear the wait before the timeout.
    act(() => {
      useAppStore.getState().setTerminalWaitingForAgent(TAB_ID, null);
    });
    act(() => {
      vi.advanceTimersByTime(WAITING_FOR_AGENT_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();
  });

  it("transitions the connecting tab to Failed after the connect timeout elapses", () => {
    useAppStore.getState().setTerminalConnecting(TAB_ID, true);
    render(root);

    act(() => {
      vi.advanceTimersByTime(CONNECTING_TIMEOUT_MS + 100);
    });

    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBe(
      connectTimeoutMessage("connecting")
    );
    // The client-side connect timeout is typed, so the overlay shows the
    // backend-appropriate timeout hint without matching the message (I18N-009).
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBe("timeout");
    expect(container.textContent).toContain("Check that the host is reachable");
  });

  it("keeps the typed kind with its error and clears it with the error", () => {
    const store = useAppStore.getState();
    store.setTerminalSpawnError(TAB_ID, "Serial port 'COM3' is busy", "busy");
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBe("busy");
    // A later unclassified error must not inherit the stale kind.
    store.setTerminalSpawnError(TAB_ID, "something else");
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBeUndefined();
    store.setTerminalSpawnError(TAB_ID, "Permission denied", "permission");
    store.retryTerminalSpawn(TAB_ID);
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBeUndefined();
    store.setTerminalSpawnError(TAB_ID, "Permission denied", "permission");
    store.abortTerminalConnect(TAB_ID);
    expect(useAppStore.getState().terminalSpawnErrorKinds[TAB_ID]).toBeUndefined();
  });

  // Regression for #1263: the timeout is anchored to a store-held wall-clock
  // deadline, so remounting the overlay mid-connect (tab drag to another
  // panel/split, zoom re-key) must NOT restart the countdown — it fires at the
  // original deadline, not a fresh full budget later.
  it("keeps the wall-clock deadline across an overlay remount and fires on time", () => {
    useAppStore.getState().setTerminalConnecting(TAB_ID, true);
    const deadlineBefore = useAppStore.getState().terminalConnectDeadline[TAB_ID]?.at;
    expect(deadlineBefore).toBeGreaterThan(0);

    render(root);

    // Spend all but ~5s of the budget, then unmount/remount the overlay.
    act(() => {
      vi.advanceTimersByTime(CONNECTING_TIMEOUT_MS - 5_000);
    });
    act(() => root.unmount());

    // The stored deadline is untouched by the unmount/remount.
    expect(useAppStore.getState().terminalConnectDeadline[TAB_ID]?.at).toBe(deadlineBefore);
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBeUndefined();

    root = createRoot(container);
    render(root);

    // A timer that restarted from zero would need the full budget again;
    // advancing only the ~5s that actually remained still fires it.
    act(() => {
      vi.advanceTimersByTime(5_000 + 100);
    });

    // The connecting overlay is driven by the wall-clock connect deadline now
    // (#2205 PR-B removed the local `terminalConnecting` field); the timeout
    // clears the deadline as it transitions the tab to Failed.
    expect(useAppStore.getState().terminalConnectDeadline[TAB_ID]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors[TAB_ID]).toBe(
      connectTimeoutMessage("connecting")
    );
  });
});
