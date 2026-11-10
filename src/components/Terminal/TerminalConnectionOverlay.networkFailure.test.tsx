/**
 * Network connect failures on the terminal connection overlay (#5183).
 *
 * A refused, unreachable or unresolvable host used to show the raw backend
 * string with no hint and only Retry / Close tab. This pins the humanised
 * screen: a named heading, a plain-language hint, the technical error behind a
 * "Details" disclosure with a copy action, and an **Edit connection** action
 * that opens the saved connection's editor focused on the field to fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const toastSuccess = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

const writeText = vi.fn((_text?: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
}));

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import type { ConnectionErrorKind } from "@/utils/connectionErrorHints";

const TAB_ID = "tab-net";
const PANEL_ID = "panel-net";
const REFUSED = "db.internal:2222: Connection refused (os error 61)";

let container: HTMLDivElement;
let root: Root;
const openConnectionEditorTab = vi.fn();

function renderFailure(
  kind: ConnectionErrorKind,
  error: string,
  props: { connectionId?: string; viaAgent?: boolean } = {}
) {
  useAppStore.setState({
    terminalSpawnErrors: { [TAB_ID]: error },
    terminalSpawnErrorKinds: { [TAB_ID]: kind },
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

function query(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function heading(): string {
  return document.querySelector(".ui-content-overlay__heading")?.textContent ?? "";
}

describe("TerminalConnectionOverlay — network failures (#5183)", () => {
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
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names a refused connect and explains it in plain language", () => {
    renderFailure("refused", REFUSED, { connectionId: "conn-1" });
    expect(heading()).toBe("Connection refused");
    expect(container.textContent).toMatch(/nothing is accepting connections on this port/i);
  });

  it("names unreachable and unresolvable hosts", () => {
    renderFailure("unreachable", "db.internal:22: No route to host (os error 65)");
    expect(heading()).toBe("Host unreachable");
    expect(container.textContent).toMatch(/network or VPN/i);

    renderFailure("dns", "Could not resolve host 'db.internal': not known");
    expect(heading()).toBe("Host not found");
    expect(container.textContent).toMatch(/host name could not be resolved/i);
  });

  it("keeps the technical error behind a collapsed Details disclosure", async () => {
    renderFailure("refused", REFUSED);
    const details = query("terminal-connection-error-details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain(REFUSED);
    // Not also shown as the prominent error box.
    expect(document.querySelector(".ui-connect-progress__error")).toBeNull();

    act(() => query("terminal-connection-error-copy-btn")!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(REFUSED);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("opens the connection editor on the port for a refused connect", () => {
    renderFailure("refused", REFUSED, { connectionId: "conn-1" });
    const edit = query("terminal-connection-edit-btn");
    expect(edit?.textContent).toBe("Edit connection");
    act(() => edit!.click());
    expect(openConnectionEditorTab).toHaveBeenCalledWith(
      "conn-1",
      undefined,
      expect.objectContaining({ field: "port" })
    );
  });

  it("opens the connection editor on the host for an unresolvable host", () => {
    renderFailure("dns", "Could not resolve host 'db.internal'", { connectionId: "conn-1" });
    act(() => query("terminal-connection-edit-btn")!.click());
    expect(openConnectionEditorTab).toHaveBeenCalledWith(
      "conn-1",
      undefined,
      expect.objectContaining({ field: "host" })
    );
  });

  it("offers Edit connection only for a saved, direct connection", () => {
    renderFailure("refused", REFUSED);
    expect(query("terminal-connection-edit-btn")).toBeNull();

    renderFailure("refused", REFUSED, { connectionId: "conn-1", viaAgent: true });
    expect(query("terminal-connection-edit-btn")).toBeNull();
  });

  it("leaves other failures on the generic screen with the error in view", () => {
    renderFailure("other", "Failed to spawn terminal: pty closed", { connectionId: "conn-1" });
    expect(heading()).toBe("Connection failed");
    expect(query("terminal-connection-error-details")).toBeNull();
    expect(document.querySelector(".ui-connect-progress__error")?.textContent).toContain(
      "pty closed"
    );
    // A wrong host or port can cause any failure, so Edit is still offered.
    expect(query("terminal-connection-edit-btn")).not.toBeNull();
  });
});
