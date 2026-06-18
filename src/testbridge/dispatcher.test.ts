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

  describe("getComputedStyle", () => {
    it("reads a computed property of an element by testId", async () => {
      const { deps, container } = setup(`<div data-testid="handle"></div>`);
      (container.querySelector("div") as HTMLElement).style.cursor = "col-resize";
      const res = await dispatchCommand(
        { action: "getComputedStyle", testId: "handle", property: "cursor" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "getComputedStyle", value: "col-resize" });
    });

    it("reads a custom property from the document root when testId is omitted", async () => {
      const { deps } = setup(`<div></div>`);
      document.documentElement.style.setProperty("--bg-primary", "#123456");
      try {
        const res = await dispatchCommand(
          { action: "getComputedStyle", property: "--bg-primary" },
          deps
        );
        expect(res).toEqual({ ok: true, action: "getComputedStyle", value: "#123456" });
      } finally {
        document.documentElement.style.removeProperty("--bg-primary");
      }
    });

    it("fails when the element is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand(
        { action: "getComputedStyle", testId: "ghost", property: "cursor" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
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

  describe("drag", () => {
    it("fires mousedown on the handle then mousemove/mouseup with the delta applied", async () => {
      const { deps, container } = setup(`<div data-testid="handle"></div>`);
      const handle = container.querySelector("div") as HTMLElement;
      const events: Array<{ type: string; clientX: number }> = [];
      handle.addEventListener("mousedown", (e) =>
        events.push({ type: "down", clientX: (e as MouseEvent).clientX })
      );
      document.addEventListener("mousemove", (e) =>
        events.push({ type: "move", clientX: (e as MouseEvent).clientX })
      );
      document.addEventListener("mouseup", (e) =>
        events.push({ type: "up", clientX: (e as MouseEvent).clientX })
      );

      const res = await dispatchCommand({ action: "drag", testId: "handle", dx: 100 }, deps);
      expect(res).toEqual({ ok: true, action: "drag" });
      expect(events.map((e) => e.type)).toEqual(["down", "move", "up"]);
      // jsdom rects are zero-sized, so the start is 0 and the move carries dx.
      expect(events[1].clientX - events[0].clientX).toBe(100);
      expect(events[2].clientX - events[0].clientX).toBe(100);
    });

    it("fails when the handle is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "drag", testId: "handle", dx: 10 }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("handle");
    });
  });

  describe("dragTo", () => {
    it("fires pointerdown on the source, moves, and releases at the target", async () => {
      const { deps, container } = setup(`<div data-testid="a"></div><div data-testid="b"></div>`);
      const a = container.querySelectorAll("div")[0];
      const seq: string[] = [];
      a.addEventListener("pointerdown", () => seq.push("down"));
      document.addEventListener("pointermove", () => seq.push("move"));
      document.addEventListener("pointerup", () => seq.push("up"));

      const res = await dispatchCommand({ action: "dragTo", fromTestId: "a", toTestId: "b" }, deps);
      expect(res).toEqual({ ok: true, action: "dragTo" });
      expect(seq[0]).toBe("down");
      expect(seq[seq.length - 1]).toBe("up");
      expect(seq.filter((s) => s === "move").length).toBeGreaterThan(0);
    });

    it("fails when an endpoint is absent", async () => {
      const { deps } = setup(`<div data-testid="a"></div>`);
      const res = await dispatchCommand({ action: "dragTo", fromTestId: "a", toTestId: "z" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("z");
    });
  });

  describe("rightClick", () => {
    it("dispatches a contextmenu event the trigger observes", async () => {
      const { deps, container } = setup(`<div data-testid="tab">Tab</div>`);
      const handler = vi.fn();
      container.querySelector("div")!.addEventListener("contextmenu", handler);
      const res = await dispatchCommand({ action: "rightClick", testId: "tab" }, deps);
      expect(res).toEqual({ ok: true, action: "rightClick" });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("fails when the element is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "rightClick", testId: "ghost" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("key", () => {
    it("dispatches keydown and keyup with modifiers, bubbling to the document", async () => {
      const { deps } = setup(`<div></div>`);
      const events: Array<{ type: string; key: string; ctrl: boolean }> = [];
      const record = (e: Event) =>
        events.push({
          type: e.type,
          key: (e as KeyboardEvent).key,
          ctrl: (e as KeyboardEvent).ctrlKey,
        });
      document.addEventListener("keydown", record);
      document.addEventListener("keyup", record);
      try {
        const res = await dispatchCommand({ action: "key", key: ",", ctrl: true }, deps);
        expect(res).toEqual({ ok: true, action: "key" });
        expect(events).toEqual([
          { type: "keydown", key: ",", ctrl: true },
          { type: "keyup", key: ",", ctrl: true },
        ]);
      } finally {
        document.removeEventListener("keydown", record);
        document.removeEventListener("keyup", record);
      }
    });
  });

  describe("selectOption", () => {
    it("sets the select value and fires a change event", async () => {
      const { deps, container } = setup(
        `<select data-testid="theme"><option value="dark">Dark</option><option value="light">Light</option></select>`
      );
      const select = container.querySelector("select")!;
      const changes: string[] = [];
      select.addEventListener("change", () => changes.push(select.value));

      const res = await dispatchCommand(
        { action: "selectOption", testId: "theme", value: "light" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "selectOption" });
      expect(select.value).toBe("light");
      expect(changes).toEqual(["light"]);
    });

    it("fails on a value the select does not offer", async () => {
      const { deps } = setup(
        `<select data-testid="theme"><option value="dark">Dark</option></select>`
      );
      const res = await dispatchCommand(
        { action: "selectOption", testId: "theme", value: "nope" },
        deps
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("nope");
    });

    it("fails on a non-select element", async () => {
      const { deps } = setup(`<input data-testid="x" />`);
      const res = await dispatchCommand({ action: "selectOption", testId: "x", value: "v" }, deps);
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
