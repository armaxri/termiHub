import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import { recordConnectProgress, useConnectProgressStore } from "@/store/connectProgressBridge";
import { ABORTED_CONNECT_MESSAGE } from "@/store/reconnectHelpers";
import { connectTimeoutMessage } from "@/utils/connectTimeout";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

const TAB_ID = "tab-stages";
const PANEL_ID = "panel-stages";

const harness = installSessionLifecycleHarness();

/** #5068: the backend's connect-stage reports drive the overlay's stepper. */
describe("TerminalConnectionOverlay — connect stages", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useConnectProgressStore.setState({ byTab: {} });
    useAppStore.setState({
      terminalSpawnErrors: {},
      terminalSpawnErrorKinds: {},
      terminalAutoRetryCount: {},
      terminalWaitingForAgent: {},
      terminalReattaching: {},
      terminalConnectDeadline: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<Parameters<typeof TerminalConnectionOverlay>[0]> = {}) {
    act(() => {
      root.render(
        <TerminalConnectionOverlay
          tabId={TAB_ID}
          panelId={PANEL_ID}
          tabTitle="prod-db"
          isVisible={true}
          sessionType="ssh"
          target="db.internal"
          details={["port 22"]}
          {...props}
        />
      );
    });
  }

  const states = () =>
    Array.from(container.querySelectorAll<HTMLElement>(".ui-connect-progress__step")).map(
      (s) => `${s.textContent}:${s.dataset.state}`
    );

  it("advances the SSH stepper and shows the status line as stages arrive", async () => {
    harness.transport.setSession(TAB_ID, connecting());
    render();
    await flushSessionRegion();
    expect(states()).toEqual([
      "Resolve:active",
      "Connect:pending",
      "Host key:pending",
      "Authenticate:pending",
      "Shell:pending",
    ]);

    act(() =>
      recordConnectProgress({
        connectId: `${TAB_ID}:0`,
        stage: "authenticate",
        status: "Trying public key ~/.ssh/id_ed25519 for admin@db.internal",
      })
    );
    expect(states()).toEqual([
      "Resolve:done",
      "Connect:done",
      "Host key:done",
      "Authenticate:active",
      "Shell:pending",
    ]);
    expect(container.querySelector(".ui-connect-progress__status")?.textContent).toBe(
      "Trying public key ~/.ssh/id_ed25519 for admin@db.internal"
    );
    expect(container.textContent).toContain("db.internal");
    expect(container.textContent).toContain("port 22");
  });

  it("marks the reported stage failed when the connect fails", () => {
    recordConnectProgress({ connectId: `${TAB_ID}:0`, stage: "hostKey", status: null });
    useAppStore.setState({ terminalSpawnErrors: { [TAB_ID]: "SSH handshake failed" } });
    render();
    expect(container.querySelector(".ui-content-overlay__heading")?.textContent).toBe(
      "Connection failed"
    );
    expect(states()[2]).toBe("Host key:failed");
    expect(container.querySelector("[data-testid=terminal-connection-retry-btn]")).not.toBeNull();
    expect(
      container.querySelector("[data-testid=terminal-connection-cancel-btn]")?.textContent
    ).toBe("Close tab");
  });

  it("omits the stepper on failure when no stage was reported", () => {
    useAppStore.setState({ terminalSpawnErrors: { [TAB_ID]: "boom" } });
    render();
    expect(container.querySelector(".ui-connect-progress__steps")).toBeNull();
  });

  it("shows the timed-out and aborted resting phases", () => {
    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: connectTimeoutMessage("connecting") },
      terminalSpawnErrorKinds: { [TAB_ID]: "timeout" },
    });
    render({ sessionType: "telnet" });
    expect(container.querySelector(".ui-connect-progress")?.getAttribute("data-phase")).toBe(
      "timeout"
    );
    expect(container.textContent).toContain("Gave up after 1m 30s");

    useAppStore.setState({
      terminalSpawnErrors: { [TAB_ID]: ABORTED_CONNECT_MESSAGE },
      terminalSpawnErrorKinds: {},
    });
    render({ sessionType: "telnet" });
    expect(container.querySelector(".ui-connect-progress")?.getAttribute("data-phase")).toBe(
      "aborted"
    );
    expect(container.querySelector(".ui-content-overlay__heading")?.textContent).toBe(
      "Connection aborted"
    );
  });

  it("shows Agent → Start session for an agent-hosted session", () => {
    useAppStore.setState({ terminalWaitingForAgent: { [TAB_ID]: "agent-1" } });
    render({ viaAgent: true });
    expect(states()).toEqual(["Agent:active", "Start session:pending"]);
    expect(container.textContent).toContain("via agent");
  });

  it("gives a local shell a single short stage", async () => {
    harness.transport.setSession(TAB_ID, connecting());
    render({ sessionType: "local", target: undefined, details: [] });
    await flushSessionRegion();
    expect(states()).toEqual(["Start session:active"]);
    expect(container.textContent).toContain("Local shell");
  });
});
