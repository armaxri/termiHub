/**
 * #5509: an initial command held because the shell never announced its prompt
 * shows a non-modal notice after the backend's wait; Send now types it exactly
 * once, Dismiss hides it without sending, and it clears on its own when the
 * command goes out at the prompt after all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { TabContent } from "@/types/terminal";
import { checkA11y } from "@/test/axe";
import {
  recordInitialCommandHeld,
  useInitialCommandHeldStore,
} from "@/store/initialCommandHeldBridge";
import { InitialCommandHeldNotice } from "./InitialCommandHeldNotice";

const sendHeld = vi.fn((_sessionId: string) => Promise.resolve(true));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  sendHeldInitialCommand: (sessionId: string) => sendHeld(sessionId),
}));

function seedTab(content: Partial<TabContent>): void {
  useAppStore.setState({
    tabContent: {
      t1: {
        id: "t1",
        sessionId: "s1",
        title: "T",
        connectionType: "local",
        contentType: "terminal",
        config: { type: "local", config: {} },
        initialCommand: "npm start",
        ...content,
      },
    },
  });
}

describe("InitialCommandHeldNotice (#5509)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedTab({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    useInitialCommandHeldStore.setState({ bySession: {} });
    vi.clearAllMocks();
  });

  const notice = () =>
    container.querySelector<HTMLElement>('[data-testid="initial-command-held-notice"]');
  const button = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="initial-command-held-${id}-btn"]`);
  const hold = (held: boolean, sessionId = "s1", setup = false, initialCommand = true) =>
    act(() => recordInitialCommandHeld({ sessionId, held, setup, initialCommand }));

  it("renders nothing until the backend reports the command held", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    expect(notice()).toBeNull();
  });

  it("appears once the command is held past the wait", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true);
    expect(notice()?.textContent).toContain(
      "Waiting for the shell prompt — initial command not sent yet"
    );
  });

  it("covers a held setup and the initial command behind it (#5512)", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true, "s1", true, true);
    expect(notice()?.textContent).toContain(
      "Waiting for the shell prompt — command marks and initial command not sent yet"
    );
    expect(notice()?.getAttribute("aria-label")).toBe("Command marks and initial command not sent");
  });

  it("covers a held setup without an initial command (#5512)", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true, "s1", true, false);
    expect(notice()?.textContent).toContain(
      "Waiting for the shell prompt — command marks not set up yet"
    );
  });

  it("Send now for a held setup sends once and clears the notice (#5512)", async () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true, "s1", true, true);
    await act(async () => {
      button("send")!.click();
      button("send")!.click();
    });
    expect(sendHeld).toHaveBeenCalledTimes(1);
    expect(notice()).toBeNull();
  });

  it("ignores another session's held command", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true, "other");
    expect(notice()).toBeNull();
  });

  it("Send now sends the held command exactly once and clears the notice", async () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true);
    await act(async () => {
      button("send")!.click();
      button("send")!.click();
    });
    expect(sendHeld).toHaveBeenCalledTimes(1);
    expect(sendHeld).toHaveBeenCalledWith("s1");
    expect(notice()).toBeNull();
  });

  it("Dismiss hides the notice without sending anything", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true);
    act(() => button("dismiss")!.click());
    expect(notice()).toBeNull();
    expect(sendHeld).not.toHaveBeenCalled();
  });

  it("clears on its own when the prompt comes and the command goes out", () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true);
    expect(notice()).not.toBeNull();
    hold(false);
    expect(notice()).toBeNull();
    expect(sendHeld).not.toHaveBeenCalled();
  });

  it("is a non-modal status with keyboard-reachable actions and passes axe", async () => {
    act(() => root.render(<InitialCommandHeldNotice tabId="t1" />));
    hold(true);
    expect(notice()?.getAttribute("role")).toBe("status");
    for (const id of ["send", "dismiss"]) {
      const b = button(id)!;
      expect(b.tagName).toBe("BUTTON");
      expect(b.tabIndex).toBe(0);
      b.focus();
      expect(document.activeElement).toBe(b);
    }
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
