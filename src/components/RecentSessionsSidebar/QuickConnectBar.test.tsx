import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { QuickConnectBar } from "./QuickConnectBar";
import { toast } from "@/components/ui";
import { withTooltip } from "@/test/tooltip";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import type { ConnectionConfig } from "@/types/terminal";

function sshEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    dedupKey: "ssh:admin@prod:22",
    title: "admin@prod",
    connectionType: "ssh",
    config: { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
    firstUsed: 0,
    lastUsed: Date.now(),
    useCount: 3,
    pinned: false,
    promoted: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function input(): HTMLInputElement {
  return query("quick-connect-input") as HTMLInputElement;
}

function typeInto(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function focusInput() {
  act(() => {
    input().focus();
    input().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
}

function render(history: SessionHistoryEntry[], onConnect = vi.fn()) {
  act(() => {
    root.render(withTooltip(<QuickConnectBar history={history} onConnect={onConnect} />));
  });
  return onConnect;
}

describe("QuickConnectBar", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("parses user@host and connects with an SSH config + derived title on submit", () => {
    const onConnect = render([]);
    typeInto("root@example.com");
    act(() => query("quick-connect-submit")?.click());
    expect(onConnect).toHaveBeenCalledTimes(1);
    const [config, title] = onConnect.mock.calls[0] as [ConnectionConfig, string];
    expect(config.type).toBe("ssh");
    expect(config.config).toMatchObject({ host: "example.com", port: 22, username: "root" });
    expect(title).toBe("root@example.com");
  });

  it("parses an explicit port from host:port", () => {
    const onConnect = render([]);
    typeInto("gw:2222");
    act(() => query("quick-connect-submit")?.click());
    const [config] = onConnect.mock.calls[0] as [ConnectionConfig];
    expect(config.config).toMatchObject({ host: "gw", port: 2222 });
  });

  it("submits on Enter and clears the input afterward", () => {
    const onConnect = render([]);
    typeInto("host1");
    act(() => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
  });

  it("shows a toast and does not connect when the input has no host", () => {
    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "id");
    const onConnect = render([]);
    typeInto("   ");
    act(() => query("quick-connect-submit")?.click());
    expect(onConnect).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not render suggestions until the input is focused with a query", () => {
    render([sshEntry()]);
    expect(query("quick-connect-suggestions")).toBeNull();
    typeInto("prod");
    // Not focused yet → still no dropdown.
    expect(query("quick-connect-suggestions")).toBeNull();
  });

  it("shows matching SSH history suggestions when focused, filtering non-matches", () => {
    render([
      sshEntry(),
      sshEntry({ dedupKey: "ssh:me@stage:22", title: "me@stage" }),
      // A non-SSH entry must never appear in the SSH quick-connect suggestions.
      sshEntry({ dedupKey: "telnet:box:23", title: "box", connectionType: "telnet" }),
    ]);
    focusInput();
    typeInto("prod");
    const list = query("quick-connect-suggestions");
    expect(list).not.toBeNull();
    expect(query("quick-connect-suggestion-ssh:admin@prod:22")).not.toBeNull();
    expect(query("quick-connect-suggestion-ssh:me@stage:22")).toBeNull();
    expect(query("quick-connect-suggestion-telnet:box:23")).toBeNull();
  });

  it("connects to the exact history entry when a suggestion is chosen", () => {
    const onConnect = render([sshEntry()]);
    focusInput();
    typeInto("prod");
    act(() => {
      query("quick-connect-suggestion-ssh:admin@prod:22")?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
    expect(onConnect).toHaveBeenCalledWith(
      { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
      "admin@prod"
    );
  });
});
