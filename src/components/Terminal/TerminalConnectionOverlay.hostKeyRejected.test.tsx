/**
 * A rejected host key on the terminal connection overlay (#5185).
 *
 * Rejecting a server's host key in the trust prompt used to land on
 * "Connection failed / SSH handshake failed: Unknown server key" with a Retry
 * that simply re-showed the prompt. This pins the honest screen: "You rejected
 * the host key", a **Review key** action (reconnecting re-opens the prompt),
 * **Edit connection**, and no Retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import { connectionErrorKindFromCode } from "@/utils/connectionErrorHints";

const TAB_ID = "tab-hk";
const PANEL_ID = "panel-hk";
const REJECTED = "You rejected the host key of db.internal:22, so the connection was not made";

let container: HTMLDivElement;
let root: Root;
const openConnectionEditorTab = vi.fn();
const retryTerminalSpawn = vi.fn();

function renderRejected(props: { connectionId?: string } = { connectionId: "conn-1" }) {
  useAppStore.setState({
    terminalSpawnErrors: { [TAB_ID]: REJECTED },
    // The kind the tab derives from the backend's `host_key_untrusted` code.
    terminalSpawnErrorKinds: { [TAB_ID]: connectionErrorKindFromCode("host_key_untrusted") },
  });
  act(() => {
    root.render(
      <TerminalConnectionOverlay
        tabId={TAB_ID}
        panelId={PANEL_ID}
        tabTitle="prod-db"
        isVisible={true}
        sessionType="ssh"
        target="db.internal"
        {...props}
      />
    );
  });
}

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const heading = () => document.querySelector(".ui-content-overlay__heading")?.textContent ?? "";

describe("TerminalConnectionOverlay — rejected host key (#5185)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState({
      terminalSpawnErrors: {},
      terminalSpawnErrorKinds: {},
      terminalAutoRetryCount: {},
      terminalWaitingForAgent: {},
      terminalRetryCounters: {},
      terminalReattaching: {},
      openConnectionEditorTab,
      retryTerminalSpawn,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says the user rejected the key instead of 'Connection failed'", () => {
    renderRejected();
    expect(heading()).toBe("You rejected the host key");
    expect(container.textContent).toMatch(/did not connect because you rejected/i);
  });

  it("offers Review key and Edit connection, and no Retry", () => {
    renderRejected();
    expect(query("terminal-connection-retry-btn")).toBeNull();
    expect(query("terminal-connection-review-key-btn")?.textContent).toBe("Review key");
    expect(query("terminal-connection-edit-btn")?.textContent).toBe("Edit connection");
    expect(query("terminal-connection-cancel-btn")).not.toBeNull();
  });

  it("Review key reconnects, which re-opens the trust prompt", () => {
    renderRejected();
    act(() => query("terminal-connection-review-key-btn")!.click());
    expect(retryTerminalSpawn).toHaveBeenCalledWith(TAB_ID);
  });

  it("Edit connection opens the saved connection's editor on the host", () => {
    renderRejected();
    act(() => query("terminal-connection-edit-btn")!.click());
    expect(openConnectionEditorTab).toHaveBeenCalledWith(
      "conn-1",
      undefined,
      expect.objectContaining({ field: "host" })
    );
  });

  it("keeps Retry for every other failure", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: "SSH handshake failed: Unknown server key" },
      terminalSpawnErrorKinds: { [TAB_ID]: "other" },
    });
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="prod-db"
          isVisible={true}
          sessionType="ssh"
        />
      );
    });
    expect(query("terminal-connection-retry-btn")).not.toBeNull();
    expect(query("terminal-connection-review-key-btn")).toBeNull();
  });
});
