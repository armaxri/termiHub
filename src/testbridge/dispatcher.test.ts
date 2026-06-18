import { describe, it, expect, beforeEach, vi } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/** Build a DOM fixture and matching deps for the dispatcher under test. */
function setup(
  html: string,
  overrides: Partial<BridgeDeps> = {}
): { deps: BridgeDeps; container: HTMLElement } {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const deps: BridgeDeps = {
    root: container,
    readTerminal: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    ...overrides,
  };
  return { deps, container };
}

describe("dispatchCommand", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  describe("exists", () => {
    it("returns true when the element is present", async () => {
      const { deps } = setup(`<button data-testid="save">Save</button>`);
      const res = await dispatchCommand({ action: "exists", testId: "save" }, deps);
      expect(res).toEqual({ ok: true, action: "exists", value: true });
    });

    it("returns false when the element is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "exists", testId: "missing" }, deps);
      expect(res).toEqual({ ok: true, action: "exists", value: false });
    });
  });

  describe("getText", () => {
    it("returns the element's text content", async () => {
      const { deps } = setup(`<div data-testid="status">Connected</div>`);
      const res = await dispatchCommand({ action: "getText", testId: "status" }, deps);
      expect(res).toEqual({ ok: true, action: "getText", value: "Connected" });
    });

    it("fails when the element is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "getText", testId: "status" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("status");
    });
  });

  describe("getAttribute", () => {
    it("returns the requested attribute", async () => {
      const { deps } = setup(`<input data-testid="host" value="example.com" />`);
      const res = await dispatchCommand(
        { action: "getAttribute", testId: "host", attribute: "value" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "getAttribute", value: "example.com" });
    });

    it("returns null value when the attribute is missing", async () => {
      const { deps } = setup(`<div data-testid="x"></div>`);
      const res = await dispatchCommand(
        { action: "getAttribute", testId: "x", attribute: "title" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "getAttribute", value: null });
    });
  });

  describe("click", () => {
    it("dispatches a bubbling click the element's handler observes", async () => {
      const { deps, container } = setup(`<button data-testid="go">Go</button>`);
      const handler = vi.fn();
      container.querySelector("button")!.addEventListener("click", handler);

      const res = await dispatchCommand({ action: "click", testId: "go" }, deps);
      expect(res).toEqual({ ok: true, action: "click" });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("fails when the target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "click", testId: "go" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("type", () => {
    it("sets the value via the native setter and fires an input event", async () => {
      const { deps, container } = setup(`<input data-testid="name" />`);
      const input = container.querySelector("input")!;
      const observed: string[] = [];
      input.addEventListener("input", () => observed.push(input.value));

      const res = await dispatchCommand({ action: "type", testId: "name", text: "hub" }, deps);
      expect(res).toEqual({ ok: true, action: "type" });
      expect(input.value).toBe("hub");
      expect(observed).toEqual(["hub"]);
    });

    it("fails on a non-input element", async () => {
      const { deps } = setup(`<div data-testid="name"></div>`);
      const res = await dispatchCommand({ action: "type", testId: "name", text: "x" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("select", () => {
    const OPTIONS = `
      <select data-testid="type">
        <option value="local">Local</option>
        <option value="ssh">SSH</option>
      </select>`;

    it("sets the value via the native setter and fires a change event", async () => {
      const { deps, container } = setup(OPTIONS);
      const select = container.querySelector("select")!;
      const observed: string[] = [];
      select.addEventListener("change", () => observed.push(select.value));

      const res = await dispatchCommand({ action: "select", testId: "type", value: "ssh" }, deps);
      expect(res).toEqual({ ok: true, action: "select" });
      expect(select.value).toBe("ssh");
      expect(observed).toEqual(["ssh"]);
    });

    it("fails on a non-select element", async () => {
      const { deps } = setup(`<input data-testid="type" />`);
      const res = await dispatchCommand({ action: "select", testId: "type", value: "ssh" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/select/i);
    });

    it("fails when the value is not one of the options", async () => {
      const { deps } = setup(OPTIONS);
      const res = await dispatchCommand(
        { action: "select", testId: "type", value: "telnet" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("telnet");
    });

    it("fails when the target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "select", testId: "type", value: "ssh" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("terminalInput", () => {
    it("sends text plus a trailing newline to the active terminal session", async () => {
      const send = vi.fn(async () => true);
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        sendTerminalInput: send,
      });
      const res = await dispatchCommand({ action: "terminalInput", text: "ls" }, deps);
      expect(res).toEqual({ ok: true, action: "terminalInput" });
      expect(send).toHaveBeenCalledWith("tab-1", "ls\n");
    });

    it("targets an explicit tabId", async () => {
      const send = vi.fn(async () => true);
      const { deps } = setup(`<div></div>`, { sendTerminalInput: send });
      const res = await dispatchCommand(
        { action: "terminalInput", text: "whoami", tabId: "tab-9" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "terminalInput" });
      expect(send).toHaveBeenCalledWith("tab-9", "whoami\n");
    });

    it("fails when there is no active terminal", async () => {
      const send = vi.fn(async () => true);
      const { deps } = setup(`<div></div>`, { sendTerminalInput: send });
      const res = await dispatchCommand({ action: "terminalInput", text: "ls" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no .*terminal/i);
      expect(send).not.toHaveBeenCalled();
    });

    it("fails when no session is registered for the tab", async () => {
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        sendTerminalInput: async () => false,
      });
      const res = await dispatchCommand({ action: "terminalInput", text: "ls" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("tab-1");
    });
  });

  describe("readTerminal", () => {
    it("reads the active terminal when no tabId is given", async () => {
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        readTerminal: (tabId) => (tabId === "tab-1" ? "user@host:~$ ls\n" : undefined),
      });
      const res = await dispatchCommand({ action: "readTerminal" }, deps);
      expect(res).toEqual({ ok: true, action: "readTerminal", value: "user@host:~$ ls\n" });
    });

    it("reads an explicit tabId", async () => {
      const read = vi.fn((tabId: string, join: boolean) =>
        tabId === "tab-9" && join ? "joined\n" : undefined
      );
      const { deps } = setup(`<div></div>`, { readTerminal: read });
      const res = await dispatchCommand(
        { action: "readTerminal", tabId: "tab-9", joinFullWidthRows: true },
        deps
      );
      expect(res.value).toBe("joined\n");
      expect(read).toHaveBeenCalledWith("tab-9", true);
    });

    it("fails when there is no active terminal", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "readTerminal" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no .*terminal/i);
    });

    it("fails when the requested terminal is not registered", async () => {
      const { deps } = setup(`<div></div>`, { readTerminal: () => undefined });
      const res = await dispatchCommand({ action: "readTerminal", tabId: "ghost" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
    });
  });

  describe("getState", () => {
    it("returns the whole snapshot when no path is given", async () => {
      const { deps } = setup(`<div></div>`, {
        getState: () => ({ activePanelId: "p1", sidebarCollapsed: false }),
      });
      const res = await dispatchCommand({ action: "getState" }, deps);
      expect(res.value).toEqual({ activePanelId: "p1", sidebarCollapsed: false });
    });

    it("treats an explicit null path like an omitted one (JSON clients send null)", async () => {
      const { deps } = setup(`<div></div>`, {
        getState: () => ({ activePanelId: "p1" }),
      });
      // A remote JSON client (e.g. the Python harness) serializes an absent
      // optional as `null`, not `undefined`.
      const res = await dispatchCommand({ action: "getState", path: null } as never, deps);
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ activePanelId: "p1" });
    });

    it("resolves a dot-path into nested state", async () => {
      const { deps } = setup(`<div></div>`, {
        getState: () => ({ rootPanel: { activeTabId: "tab-7" } }),
      });
      const res = await dispatchCommand(
        { action: "getState", path: "rootPanel.activeTabId" },
        deps
      );
      expect(res.value).toBe("tab-7");
    });

    it("fails on an unresolvable path", async () => {
      const { deps } = setup(`<div></div>`, { getState: () => ({ a: {} }) });
      const res = await dispatchCommand({ action: "getState", path: "a.b.c" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("a.b.c");
    });
  });

  describe("unknown command", () => {
    it("fails gracefully", async () => {
      const { deps } = setup(`<div></div>`);
      // deliberately bypass the type system to simulate a malformed command
      const res = await dispatchCommand({ action: "frobnicate" } as never, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("frobnicate");
    });
  });
});
