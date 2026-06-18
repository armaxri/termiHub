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

    it("emulates a pointer sequence so pointer-driven menus (Radix) open", async () => {
      // A bare element.click() fires only a `click` event, which never opens
      // pointerdown-triggered menus. The verb must dispatch pointerdown first.
      const { deps, container } = setup(`<button data-testid="gear">⚙</button>`);
      const seen: string[] = [];
      const button = container.querySelector("button")!;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        button.addEventListener(type, () => seen.push(type));
      }

      const res = await dispatchCommand({ action: "click", testId: "gear" }, deps);
      expect(res).toEqual({ ok: true, action: "click" });
      expect(seen[0]).toBe("pointerdown");
      expect(seen).toContain("click");
      // The click event still fires exactly once (not double-fired).
      expect(seen.filter((t) => t === "click")).toEqual(["click"]);
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

  describe("contextMenu", () => {
    it("dispatches a bubbling contextmenu event the element observes", async () => {
      const { deps, container } = setup(`<button data-testid="conn">A</button>`);
      const handler = vi.fn();
      container.querySelector("button")!.addEventListener("contextmenu", handler);

      const res = await dispatchCommand({ action: "contextMenu", testId: "conn" }, deps);
      expect(res).toEqual({ ok: true, action: "contextMenu" });
      expect(handler).toHaveBeenCalledOnce();
      const event = handler.mock.calls[0][0] as MouseEvent;
      expect(event.bubbles).toBe(true);
      expect(event.button).toBe(2);
    });

    it("fails when the target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "contextMenu", testId: "conn" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("conn");
    });
  });

  describe("selectOption", () => {
    it("selects the option and fires a change event", async () => {
      const { deps, container } = setup(
        `<select data-testid="type"><option value="local">Local</option><option value="ssh">SSH</option></select>`
      );
      const select = container.querySelector("select")!;
      const observed: string[] = [];
      select.addEventListener("change", () => observed.push(select.value));

      const res = await dispatchCommand(
        { action: "selectOption", testId: "type", value: "ssh" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "selectOption" });
      expect(select.value).toBe("ssh");
      expect(observed).toEqual(["ssh"]);
    });

    it("fails when the value is not an available option", async () => {
      const { deps } = setup(
        `<select data-testid="type"><option value="local">Local</option></select>`
      );
      const res = await dispatchCommand(
        { action: "selectOption", testId: "type", value: "ssh" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ssh");
    });

    it("fails on a non-select element", async () => {
      const { deps } = setup(`<input data-testid="type" />`);
      const res = await dispatchCommand(
        { action: "selectOption", testId: "type", value: "ssh" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/select/i);
    });
  });

  describe("pressKey", () => {
    it("dispatches keydown + keyup with the given key on the target element", async () => {
      const { deps, container } = setup(`<input data-testid="field" />`);
      const input = container.querySelector("input")!;
      const keys: string[] = [];
      input.addEventListener("keydown", (e) => keys.push(`down:${(e as KeyboardEvent).key}`));
      input.addEventListener("keyup", (e) => keys.push(`up:${(e as KeyboardEvent).key}`));

      const res = await dispatchCommand(
        { action: "pressKey", key: "Enter", testId: "field" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "pressKey" });
      expect(keys).toEqual(["down:Enter", "up:Enter"]);
    });

    it("dispatches on the focused element when no testId is given", async () => {
      const { deps, container } = setup(`<input data-testid="field" />`);
      const input = container.querySelector("input")!;
      input.focus();
      const keys: string[] = [];
      input.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

      const res = await dispatchCommand({ action: "pressKey", key: "Escape" }, deps);
      expect(res).toEqual({ ok: true, action: "pressKey" });
      expect(keys).toEqual(["Escape"]);
    });

    it("fails when an explicit testId target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand(
        { action: "pressKey", key: "Enter", testId: "ghost" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
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
