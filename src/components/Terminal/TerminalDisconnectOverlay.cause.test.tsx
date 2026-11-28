/**
 * One disconnect / reconnect model that always states the cause (#5831).
 *
 * The usability review saw one SSH tab auto-reconnect with a banner while
 * another showed a manual overlay with no cause (R-061), telnet say "The
 * connection was lost" when the server had closed it (R-062), a dark scrim hide
 * the scrollback (R-028), a strip with no "Retry now" that did not say what
 * happens after the last attempt (R-164) and a ~110-character serial path
 * (R-072). These pin one cause line per cause across the overlay, the strip and
 * the view-mode banner, the auto-reconnect-off note, the clear overlay and the
 * strip's Retry now.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalDisconnectOverlay, disconnectCauseLineForTab } from "./TerminalDisconnectOverlay";
import { TerminalViewModeBanner } from "./TerminalViewModeBanner";
import { disconnectCauseLine, disconnectCauseOf } from "./dropCopy";
import { withTooltip } from "@/test/tooltip";
import {
  disconnected,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  reconnecting,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";
import type { TerminalTab } from "@/types/terminal";
import type { SessionEndCause } from "@/types/generated/SessionEndCause";
import { layoutState, seedLayoutState } from "@/test/layoutState";

const TAB = "tab-cause";

function seedTab(config: TerminalTab["config"]) {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: TAB,
    sessionId: "sess-1",
    title: "dev",
    connectionType: config.type,
    contentType: "terminal",
    config,
    panelId: leafId,
    isActive: true,
  };
  seedLayoutState({
    rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
    activePanelId: leafId,
  });
}

/** A dropped link (no exit code) with the backend's end cause. */
function droppedWith(endCause?: SessionEndCause): ProjectedSessionLifecycle {
  const life = withExit(disconnected("unexpected"), { code: null, reason: "dropped" });
  return endCause ? { ...life, endCause } : life;
}

const SSH = { type: "ssh", config: { host: "web", username: "me" } } as const;
const SSH_NO_AUTO = {
  type: "ssh",
  config: { host: "web", username: "me", autoReconnect: false },
} as const;
const TELNET = { type: "telnet", config: { host: "router", port: 23 } } as const;
const SERIAL = {
  type: "serial",
  config: { port: "/dev/serial/by-id/usb-Prolific_PL2303-if00-port0-ttyPR0" },
} as const;

describe("TerminalDisconnectOverlay — the cause line (#5831)", () => {
  const harness = installSessionLifecycleHarness();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWith(life: ProjectedSessionLifecycle): Promise<HTMLElement> {
    harness.transport.setSession(TAB, life);
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
    });
    await flushSessionRegion();
    const overlay = container.querySelector<HTMLElement>(
      "[data-testid='terminal-disconnect-overlay']"
    );
    expect(overlay).not.toBeNull();
    return overlay!;
  }

  it.each([
    ["remote_closed", "server", "The server closed the connection."],
    ["io_error", "network", "The network connection was lost."],
    ["timeout", "timeout", "The connection timed out."],
  ] as const)("an SSH drop with end cause %s says %s", async (endCause, cause, line) => {
    seedTab(SSH_NO_AUTO);
    const overlay = await renderWith(droppedWith(endCause));
    expect(overlay.dataset.cause).toBe(cause);
    expect(overlay.textContent).toContain(line);
    expect(overlay.textContent).toContain("Session ended");
  });

  it("a telnet server that closed the connection never reads as a lost connection", async () => {
    seedTab(TELNET);
    const overlay = await renderWith(droppedWith("remote_closed"));
    expect(overlay.textContent).toContain("The server closed the connection.");
    expect(overlay.textContent).not.toContain("connection was lost");
    // R-062: telnet is the same model and says why it did not retry.
    expect(
      container.querySelector("[data-testid='terminal-disconnect-auto-reconnect-off']")?.textContent
    ).toBe(
      "Auto-reconnect is off for this connection: telnet connections start with it off. " +
        "Turn it on with “Auto-reconnect” in the connection's settings."
    );
  });

  it("an SSH connection with auto-reconnect off says so and where to turn it on", async () => {
    seedTab(SSH_NO_AUTO);
    await renderWith(droppedWith("io_error"));
    expect(
      container.querySelector("[data-testid='terminal-disconnect-auto-reconnect-off']")?.textContent
    ).toBe(
      "Auto-reconnect is off for this connection. " +
        "Turn it on with “Auto-reconnect” in the connection's settings."
    );
  });

  it("no auto-reconnect note when auto-reconnect is on or the process exited", async () => {
    seedTab(SSH);
    await renderWith(droppedWith("io_error"));
    expect(container.querySelector("[data-testid='terminal-disconnect-auto-reconnect-off']")).toBe(
      null
    );

    seedTab(SSH_NO_AUTO);
    // A deliberate exit (the shell ended with a code) is never retried, so the
    // note would be misleading.
    const overlay = await renderWith(
      withExit(disconnected("unexpected"), { code: 3, reason: "dropped" })
    );
    expect(overlay.dataset.cause).toBe("exited");
    // #5910: the heading says the process exited with its code.
    expect(overlay.textContent).toContain("Process exited (code 3)");
    expect(container.querySelector("[data-testid='terminal-disconnect-auto-reconnect-off']")).toBe(
      null
    );
  });

  it("a clean exit reads as an ended session with its code", async () => {
    seedTab(SSH);
    const overlay = await renderWith(
      withExit(disconnected("normal"), { code: 0, reason: "clean" })
    );
    expect(overlay.dataset.cause).toBe("ended");
    expect(overlay.textContent).toContain("Session ended");
    expect(overlay.textContent).toContain("The session ended normally (exit code 0).");
  });

  it("an unplugged serial device names the device, not its full path", async () => {
    seedTab({ ...SERIAL, config: { ...SERIAL.config, autoReconnect: false } });
    const overlay = await renderWith(droppedWith("device_gone"));
    expect(overlay.dataset.cause).toBe("device");
    expect(overlay.textContent).toContain(
      "The device usb-Prolific_PL2303-if00-port0-ttyPR0 was disconnected."
    );
    expect(overlay.textContent).not.toContain("/dev/serial");
  });

  it("the give-up overlay keeps the cause of the original drop", async () => {
    seedTab(SSH);
    const overlay = await renderWith({ ...failed("host unreachable"), endCause: "remote_closed" });
    expect(overlay.dataset.variant).toBe("failed");
    expect(overlay.textContent).toContain(
      "The server closed the connection. All reconnect attempts were exhausted."
    );
  });

  it("has no scrim: it is a top strip that leaves the scrollback readable (#5908)", async () => {
    seedTab(SSH);
    const overlay = await renderWith(droppedWith("io_error"));
    expect(overlay.classList).toContain("terminal-disconnect-strip");
    expect(overlay.textContent).toContain("Scrollback is kept.");
    expect(overlay.textContent).not.toContain("choose View scrollback");

    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "TerminalDisconnectOverlay.css"), "utf8");
    const rule = css.match(/\n\.terminal-disconnect-strip \{([^}]*)\}/)?.[1] ?? "";
    // Pinned to the top edge across the full width; never stretched over the
    // output and never a backdrop.
    expect(rule).toMatch(/top:\s*0/);
    expect(rule).toMatch(/left:\s*0/);
    expect(rule).toMatch(/right:\s*0/);
    expect(rule).not.toMatch(/(^|\s)(bottom|inset|backdrop-filter):/);
  });
});

describe("TerminalReconnectStrip — one model with the cause (#5831)", () => {
  const harness = installSessionLifecycleHarness();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const waiting = (endCause?: SessionEndCause): ProjectedSessionLifecycle => {
    const life = reconnecting({ phase: "waiting", attempt: 0, delayMs: 5_000 });
    return endCause ? { ...life, endCause } : life;
  };

  async function renderWith(life: ProjectedSessionLifecycle): Promise<HTMLElement> {
    harness.transport.setSession(TAB, life);
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
    });
    await flushSessionRegion();
    const strip = container.querySelector<HTMLElement>("[data-variant='strip']");
    expect(strip).not.toBeNull();
    return strip!;
  }

  it.each([
    ["remote_closed", "Server closed the connection — reconnecting…"],
    ["timeout", "Connection timed out — reconnecting…"],
    ["io_error", "Reconnecting…"],
  ] as const)("an SSH drop with end cause %s reads %s", async (endCause, heading) => {
    seedTab(SSH);
    const strip = await renderWith(waiting(endCause));
    expect(strip.getAttribute("aria-label")).toBe(heading);
  });

  it("offers Retry now beside Cancel and asks the backend to collapse the window", async () => {
    seedTab(SSH);
    await renderWith(waiting("io_error"));
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Stop reconnecting", "Retry now"]);

    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='terminal-auto-reconnect-retry-now-btn']")!
        .click();
    });
    await flushSessionRegion();
    const sent = harness.transport.dispatched.filter((i) => i.kind === "session.reconnectNow");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ sessionId: TAB });
  });

  it("says what happens after the last attempt", async () => {
    seedTab(SSH);
    await renderWith(waiting());
    expect(
      container.querySelector("[data-testid='terminal-reconnect-after-last']")?.textContent
    ).toMatch(/^After attempt \d+, retrying stops and the tab offers Reconnect\.$/);
  });

  it("shows a serial device by name with its full path in a tooltip", async () => {
    seedTab(SERIAL);
    const strip = await renderWith(waiting("device_gone"));
    expect(strip.getAttribute("aria-label")).toBe("Device disconnected — reconnecting…");
    const detail = container.querySelector("[data-testid='terminal-reconnect-detail']");
    expect(detail?.textContent).toBe(
      "Scrollback is kept. Waiting for usb-Prolific_PL2303-if00-port0-ttyPR0 to come back."
    );
    expect(detail?.getAttribute("title")).toBe(SERIAL.config.port);
    expect(
      container.querySelector("[data-testid='terminal-auto-reconnect-retry-now-btn']")
    ).not.toBe(null);
  });

  it("a serial device an agent reopens has no Retry now (the agent times its attempts)", async () => {
    seedTab({
      type: "remote-session",
      config: { agentId: "agent-1", sessionType: "serial", port: "/dev/ttyUSB0" },
    });
    await renderWith(waiting());
    expect(container.querySelector("[data-testid='terminal-auto-reconnect-retry-now-btn']")).toBe(
      null
    );
    expect(container.querySelector("[data-testid='terminal-auto-reconnect-cancel-btn']")).not.toBe(
      null
    );
  });
});

describe("TerminalViewModeBanner — the cause line (#5831)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a deliberate disconnect says the user ended it, under the short heading", () => {
    seedTab(SSH);
    const cause = disconnectCauseLineForTab(TAB, { code: null, reason: "killed" }, undefined);
    expect(cause).toBe("You disconnected this session.");
    act(() => root.render(<TerminalViewModeBanner tabId={TAB} cause={cause} />));
    const label = container.querySelector(".terminal-view-mode-banner__label");
    // The #5823 heading + hint stay short; the cause is its own line.
    expect(label?.textContent).toBe("Session ended. Press Enter to reconnect.");
    expect(container.querySelector("[data-testid='terminal-view-mode-cause']")?.textContent).toBe(
      "You disconnected this session."
    );
  });

  it("a server close carried into view mode keeps its cause", () => {
    seedTab(TELNET);
    expect(disconnectCauseLineForTab(TAB, { code: null, reason: "dropped" }, "remote_closed")).toBe(
      "The server closed the connection."
    );
  });

  it("no cause line when nothing is known", () => {
    seedTab(SSH);
    expect(disconnectCauseLineForTab(TAB, undefined, undefined)).toBeUndefined();
    act(() => root.render(<TerminalViewModeBanner tabId={TAB} />));
    expect(container.querySelector("[data-testid='terminal-view-mode-cause']")).toBeNull();
  });
});

describe("disconnectCauseOf / disconnectCauseLine (#5831)", () => {
  it("a user kill and a process exit win over the link's end cause", () => {
    expect(
      disconnectCauseOf({
        transport: "ssh",
        exit: { code: null, reason: "killed" },
        endCause: "io_error",
      })
    ).toBe("user");
    expect(
      disconnectCauseOf({
        transport: "ssh",
        exit: { code: 2, reason: "dropped" },
        endCause: "remote_closed",
      })
    ).toBe("exited");
  });

  it("a serial drop is the device going away, whatever the backend says", () => {
    expect(
      disconnectCauseOf({ transport: "serial", exit: { code: null, reason: "dropped" } })
    ).toBe("device");
    expect(disconnectCauseOf({ transport: "agent", endCause: "device_gone" })).toBe("device");
  });

  it("knows nothing without an exit or an end cause", () => {
    expect(disconnectCauseOf({ transport: "ssh" })).toBeUndefined();
    expect(disconnectCauseOf({ transport: "ssh", endCause: "timeout" })).toBe("timeout");
  });

  it("every cause has its line", () => {
    expect(disconnectCauseLine("device", { device: "COM3" })).toBe(
      "The device COM3 was disconnected."
    );
    expect(disconnectCauseLine("device")).toBe("The device was disconnected.");
    expect(disconnectCauseLine("ended")).toBe("The session ended normally.");
    expect(disconnectCauseLine("lost")).toBe("The connection was lost.");
  });
});
