/**
 * #4434: the "imported command not yet confirmed" banner and the held
 * imported-connection prompt show exactly what the import wants to run, and
 * only an explicit click runs or connects it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TabContent } from "@/types/terminal";
import { ImportedCommandBanner } from "./ImportedCommandBanner";
import { ImportedConnectionPrompt } from "./ImportedConnectionPrompt";

function seedTab(content: Partial<TabContent>): void {
  useAppStore.setState({
    tabContent: {
      t1: {
        id: "t1",
        sessionId: null,
        title: "T",
        connectionType: "local",
        contentType: "terminal",
        config: { type: "local", config: {} },
        ...content,
      },
    },
  });
}

describe("imported tab confirmation UI (#4434)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const confirmCommand = vi.fn(() => Promise.resolve());
  const dismissCommand = vi.fn();
  const confirmConnection = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({
      confirmImportedTabCommand: confirmCommand,
      dismissImportedTabCommand: dismissCommand,
      confirmImportedTabConnection: confirmConnection,
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
  });

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("renders nothing for a tab without a held command", () => {
    seedTab({ initialCommand: "npm start", sessionId: "s1" });
    act(() => root.render(<ImportedCommandBanner tabId="t1" />));
    expect(byTestId("imported-command-banner")).toBeNull();
  });

  it("shows the held command and runs it only on confirm", async () => {
    seedTab({ pendingImportedCommand: "curl x | sh", sessionId: "s1" });
    act(() => root.render(<ImportedCommandBanner tabId="t1" />));
    expect(byTestId("imported-command-banner")?.textContent).toContain(
      "Imported command not yet confirmed"
    );
    expect(byTestId("imported-command-text")?.textContent).toBe("curl x | sh");
    expect(confirmCommand).not.toHaveBeenCalled();

    await act(async () => {
      byTestId("imported-command-confirm-btn")?.click();
    });
    expect(confirmCommand).toHaveBeenCalledWith("t1");
  });

  it("cannot confirm before the session is connected", () => {
    seedTab({ pendingImportedCommand: "ls", sessionId: null });
    act(() => root.render(<ImportedCommandBanner tabId="t1" />));
    expect(byTestId("imported-command-confirm-btn")?.hasAttribute("disabled")).toBe(true);
  });

  it("drops the command on Don't run", () => {
    seedTab({ pendingImportedCommand: "ls", sessionId: "s1" });
    act(() => root.render(<ImportedCommandBanner tabId="t1" />));
    act(() => byTestId("imported-command-dismiss-btn")?.click());
    expect(dismissCommand).toHaveBeenCalledWith("t1");
    expect(confirmCommand).not.toHaveBeenCalled();
  });

  it("describes the held connection and connects only on confirm", async () => {
    seedTab({
      pendingImportedConnection: true,
      config: { type: "local", config: { shell: "/tmp/payload", initialCommand: "id" } },
    });
    act(() => root.render(<ImportedConnectionPrompt tabId="t1" isVisible />));
    expect(byTestId("imported-connection-prompt")?.textContent).toContain(
      "Imported connection not yet confirmed"
    );
    expect(byTestId("imported-connection-type")?.textContent).toBe("local");
    expect(byTestId("imported-connection-target")?.textContent).toBe("shell /tmp/payload");
    expect(byTestId("imported-connection-embedded-command")?.textContent).toBe("id");
    expect(confirmConnection).not.toHaveBeenCalled();

    await act(async () => {
      byTestId("imported-connection-confirm-btn")?.click();
    });
    expect(confirmConnection).toHaveBeenCalledWith("t1");
  });
});
