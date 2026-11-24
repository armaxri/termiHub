/**
 * The session-end strip (#5908) and the process-exit model (#5910).
 *
 * The UI review of run 20261124T080801Z saw the session-ended card float over
 * the terminal and cut the first or last output lines (R-003, R-005, R-009),
 * and a local shell that exited with code 3 titled "Session disconnected" with
 * a no-wifi icon and "Reconnect" (R-004, R-021). These pin the strip at the top
 * of the slot that publishes its height so the terminal is pushed below it, and
 * one wording per kind of end: a process exit is not a lost connection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalDisconnectOverlay, sessionEndNoticeForTab } from "./TerminalDisconnectOverlay";
import { TerminalViewModeBanner } from "./TerminalViewModeBanner";
import { sessionEndNoticeFor } from "./dropCopy";
import { TOP_NOTICE_INSET_VAR } from "./topNoticeInset";
import { withTooltip } from "@/test/tooltip";
import {
  disconnected,
  failed,
  flushSessionRegion,
  installSessionLifecycleHarness,
  withExit,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";
import type { TerminalTab } from "@/types/terminal";
import { layoutState, seedLayoutState } from "@/test/layoutState";

const TAB = "tab-end";

function seedTab(config: TerminalTab["config"]) {
  const leafId = layoutState().rootPanel.id;
  const tab: TerminalTab = {
    id: TAB,
    sessionId: "sess-1",
    title: "zsh",
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

const LOCAL = { type: "local", config: { shell: "zsh" } } as const;
const SSH = { type: "ssh", config: { host: "web", username: "me" } } as const;

const exitedWith = (code: number): ProjectedSessionLifecycle =>
  withExit(disconnected("unexpected"), { code, reason: "dropped" });
const cleanExit = (): ProjectedSessionLifecycle =>
  withExit(disconnected("normal"), { code: 0, reason: "clean" });
const dropped = (): ProjectedSessionLifecycle => ({
  ...withExit(disconnected("unexpected"), { code: null, reason: "dropped" }),
  endCause: "io_error",
});

describe("session-end strip (#5908, #5910)", () => {
  const harness = installSessionLifecycleHarness();
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    // The slot's wrapper owns the top-notice inset, as in SplitView.
    host = document.createElement("div");
    host.className = "terminal-context-trigger";
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function renderWith(life: ProjectedSessionLifecycle): Promise<HTMLElement> {
    harness.transport.setSession(TAB, life);
    act(() => {
      root.render(withTooltip(<TerminalDisconnectOverlay tabId={TAB} isActive />));
    });
    await flushSessionRegion();
    const strip = host.querySelector<HTMLElement>("[data-testid='terminal-disconnect-overlay']");
    expect(strip).not.toBeNull();
    return strip!;
  }

  const primary = () =>
    host.querySelector<HTMLButtonElement>("[data-testid='terminal-disconnect-reconnect-btn']");
  const heading = () => host.querySelector(".ui-content-overlay__heading")?.textContent;

  it("a local process that exits with a code says so and offers Restart", async () => {
    seedTab(LOCAL);
    const strip = await renderWith(exitedWith(3));
    expect(strip.dataset.cause).toBe("exited");
    expect(heading()).toBe("Process exited (code 3)");
    expect(strip.textContent).not.toContain("Session disconnected");
    expect(strip.textContent).not.toContain("connection");
    expect(host.querySelector("[data-testid='terminal-disconnect-icon-exited']")).not.toBeNull();
    expect(host.querySelector("[data-testid='terminal-disconnect-icon-link']")).toBeNull();
    expect(primary()?.textContent).toBe("Restart");
    expect(primary()?.dataset.action).toBe("restart");
    expect(strip.classList).toContain("terminal-disconnect-strip--neutral");
  });

  it("a local shell that ended normally reads 'Process exited (code 0)' with Restart", async () => {
    // #5955: one pattern for every local exit, with the process icon.
    seedTab(LOCAL);
    const strip = await renderWith(cleanExit());
    expect(strip.dataset.cause).toBe("ended");
    expect(heading()).toBe("Process exited (code 0)");
    expect(strip.textContent).not.toContain("Session ended");
    expect(host.querySelector("[data-testid='terminal-disconnect-icon-exited']")).not.toBeNull();
    expect(strip.textContent).toContain("Press Enter to restart.");
    expect(primary()?.textContent).toBe("Restart");
  });

  it("every strip has one dismiss control and no 'View scrollback' (#5955)", async () => {
    seedTab(SSH);
    const strip = await renderWith(dropped());
    expect(strip.textContent).not.toContain("View scrollback");
    expect(host.querySelector("[data-testid='terminal-disconnect-view-btn']")).toBeNull();
    expect(host.querySelectorAll("[data-testid='terminal-disconnect-dismiss-btn']")).toHaveLength(
      1
    );
    expect(strip.textContent).toContain("Press Enter to reconnect.");
  });

  it("an SSH session that ended keeps Reconnect: starting it again reconnects", async () => {
    seedTab(SSH);
    await renderWith(cleanExit());
    expect(heading()).toBe("Session ended");
    expect(primary()?.textContent).toBe("Reconnect");
  });

  it("only a dropped link says 'Session disconnected' with the no-wifi icon", async () => {
    seedTab(SSH);
    const strip = await renderWith(dropped());
    expect(strip.dataset.cause).toBe("network");
    expect(heading()).toBe("Session disconnected");
    expect(strip.textContent).toContain("The network connection was lost.");
    expect(host.querySelector("[data-testid='terminal-disconnect-icon-link']")).not.toBeNull();
    expect(primary()?.textContent).toBe("Reconnect");
    expect(strip.classList).toContain("terminal-disconnect-strip--warning");
  });

  it("publishes its height as the slot's top-notice inset while it shows", async () => {
    seedTab(LOCAL);
    await renderWith(exitedWith(3));
    // jsdom has no layout, so the height is 0px; what matters is that the slot
    // carries the inset the terminal element and the search bar read.
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toMatch(/^\d+px$/);
    act(() => root.render(<></>));
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toBe("");
  });

  it("the failed and session-lost variants are strips too", async () => {
    seedTab(SSH);
    const strip = await renderWith(failed("host unreachable"));
    expect(strip.dataset.variant).toBe("failed");
    expect(strip.classList).toContain("terminal-disconnect-strip");
    expect(strip.classList).toContain("terminal-disconnect-strip--error");
    expect(host.style.getPropertyValue(TOP_NOTICE_INSET_VAR)).toMatch(/^\d+px$/);
  });
});

describe("the terminal starts below the top notice (#5908)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("the terminal element's top is the slot's top-notice inset", () => {
    const src = readFileSync(join(here, "Terminal.tsx"), "utf8");
    expect(src).toMatch(/el\.style\.top = `var\(\$\{TOP_NOTICE_INSET_VAR\}\)`/);
  });

  it("the inset defaults to 0px wherever the terminal renders", () => {
    const css = readFileSync(join(here, "Terminal.css"), "utf8");
    expect(css).toMatch(/:root \{\s*--terminal-top-notice-inset: 0px;/);
  });
});

describe("TerminalViewModeBanner — process exits restart (#5910)", () => {
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

  const label = () => container.querySelector(".terminal-view-mode-banner__label")?.textContent;
  const button = () =>
    container.querySelector("[data-testid='terminal-view-mode-reconnect-btn']")?.textContent;

  it("a local exit with a code reads 'Process exited (code 3).' with Restart", () => {
    seedTab(LOCAL);
    const notice = sessionEndNoticeForTab(TAB, { code: 3, reason: "dropped" }, undefined);
    act(() => root.render(<TerminalViewModeBanner tabId={TAB} notice={notice} />));
    expect(label()).toBe("Process exited (code 3). Press Enter to restart.");
    expect(button()).toBe("Restart");
    // The heading already says it; no repeated cause line.
    expect(container.querySelector("[data-testid='terminal-view-mode-cause']")).toBeNull();
  });

  it("a dropped SSH link says 'Session disconnected.' like its strip (#5955)", () => {
    seedTab(SSH);
    const notice = sessionEndNoticeForTab(TAB, { code: null, reason: "dropped" }, "io_error");
    act(() => root.render(<TerminalViewModeBanner tabId={TAB} notice={notice} />));
    expect(label()).toBe("Session disconnected. Press Enter to reconnect.");
    expect(button()).toBe("Reconnect");
    expect(container.querySelector("[data-testid='terminal-view-mode-cause']")?.textContent).toBe(
      "The network connection was lost."
    );
  });
});

describe("sessionEndNoticeFor (#5910)", () => {
  it("names each kind of end and picks Restart only for a local process", () => {
    expect(sessionEndNoticeFor("exited", { transport: "other", code: 2 })).toEqual({
      kind: "exited",
      heading: "Process exited (code 2)",
      causeLine: undefined,
      action: "restart",
    });
    expect(sessionEndNoticeFor("exited", { transport: "ssh", code: 2 }).action).toBe("reconnect");
    // #5955: a local process that ended normally reads like any other exit.
    expect(sessionEndNoticeFor("ended", { transport: "other", code: 0 })).toEqual({
      kind: "exited",
      heading: "Process exited (code 0)",
      causeLine: undefined,
      action: "restart",
    });
    expect(sessionEndNoticeFor("ended", { transport: "other" }).heading).toBe("Process exited");
    expect(sessionEndNoticeFor("ended", { transport: "ssh", code: 0 }).heading).toBe(
      "Session ended"
    );
    expect(sessionEndNoticeFor("user", { transport: "other" }).heading).toBe("Session ended");
    expect(sessionEndNoticeFor("device", { transport: "serial" }).heading).toBe(
      "Device disconnected"
    );
    for (const cause of ["server", "timeout", "network", "lost", undefined] as const) {
      const notice = sessionEndNoticeFor(cause, { transport: "other" });
      expect(notice.kind).toBe("link");
      expect(notice.heading).toBe("Session disconnected");
      expect(notice.action).toBe("reconnect");
    }
  });
});
