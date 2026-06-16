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
    ...overrides,
  };
  return { deps, container };
}

describe("dispatchCommand", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  describe("exists", () => {
    it("returns true when the element is present", () => {
      const { deps } = setup(`<button data-testid="save">Save</button>`);
      const res = dispatchCommand({ action: "exists", testId: "save" }, deps);
      expect(res).toEqual({ ok: true, action: "exists", value: true });
    });

    it("returns false when the element is absent", () => {
      const { deps } = setup(`<div></div>`);
      const res = dispatchCommand({ action: "exists", testId: "missing" }, deps);
      expect(res).toEqual({ ok: true, action: "exists", value: false });
    });
  });

  describe("getText", () => {
    it("returns the element's text content", () => {
      const { deps } = setup(`<div data-testid="status">Connected</div>`);
      const res = dispatchCommand({ action: "getText", testId: "status" }, deps);
      expect(res).toEqual({ ok: true, action: "getText", value: "Connected" });
    });

    it("fails when the element is absent", () => {
      const { deps } = setup(`<div></div>`);
      const res = dispatchCommand({ action: "getText", testId: "status" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("status");
    });
  });

  describe("getAttribute", () => {
    it("returns the requested attribute", () => {
      const { deps } = setup(`<input data-testid="host" value="example.com" />`);
      const res = dispatchCommand(
        { action: "getAttribute", testId: "host", attribute: "value" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "getAttribute", value: "example.com" });
    });

    it("returns null value when the attribute is missing", () => {
      const { deps } = setup(`<div data-testid="x"></div>`);
      const res = dispatchCommand(
        { action: "getAttribute", testId: "x", attribute: "title" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "getAttribute", value: null });
    });
  });

  describe("click", () => {
    it("dispatches a bubbling click the element's handler observes", () => {
      const { deps, container } = setup(`<button data-testid="go">Go</button>`);
      const handler = vi.fn();
      container.querySelector("button")!.addEventListener("click", handler);

      const res = dispatchCommand({ action: "click", testId: "go" }, deps);
      expect(res).toEqual({ ok: true, action: "click" });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("fails when the target is absent", () => {
      const { deps } = setup(`<div></div>`);
      const res = dispatchCommand({ action: "click", testId: "go" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("type", () => {
    it("sets the value via the native setter and fires an input event", () => {
      const { deps, container } = setup(`<input data-testid="name" />`);
      const input = container.querySelector("input")!;
      const observed: string[] = [];
      input.addEventListener("input", () => observed.push(input.value));

      const res = dispatchCommand({ action: "type", testId: "name", text: "hub" }, deps);
      expect(res).toEqual({ ok: true, action: "type" });
      expect(input.value).toBe("hub");
      expect(observed).toEqual(["hub"]);
    });

    it("fails on a non-input element", () => {
      const { deps } = setup(`<div data-testid="name"></div>`);
      const res = dispatchCommand({ action: "type", testId: "name", text: "x" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("readTerminal", () => {
    it("reads the active terminal when no tabId is given", () => {
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        readTerminal: (tabId) => (tabId === "tab-1" ? "user@host:~$ ls\n" : undefined),
      });
      const res = dispatchCommand({ action: "readTerminal" }, deps);
      expect(res).toEqual({ ok: true, action: "readTerminal", value: "user@host:~$ ls\n" });
    });

    it("reads an explicit tabId", () => {
      const read = vi.fn((tabId: string, join: boolean) =>
        tabId === "tab-9" && join ? "joined\n" : undefined
      );
      const { deps } = setup(`<div></div>`, { readTerminal: read });
      const res = dispatchCommand(
        { action: "readTerminal", tabId: "tab-9", joinFullWidthRows: true },
        deps
      );
      expect(res.value).toBe("joined\n");
      expect(read).toHaveBeenCalledWith("tab-9", true);
    });

    it("fails when there is no active terminal", () => {
      const { deps } = setup(`<div></div>`);
      const res = dispatchCommand({ action: "readTerminal" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no .*terminal/i);
    });

    it("fails when the requested terminal is not registered", () => {
      const { deps } = setup(`<div></div>`, { readTerminal: () => undefined });
      const res = dispatchCommand({ action: "readTerminal", tabId: "ghost" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
    });
  });

  describe("getState", () => {
    it("returns the whole snapshot when no path is given", () => {
      const { deps } = setup(`<div></div>`, {
        getState: () => ({ activePanelId: "p1", sidebarCollapsed: false }),
      });
      const res = dispatchCommand({ action: "getState" }, deps);
      expect(res.value).toEqual({ activePanelId: "p1", sidebarCollapsed: false });
    });

    it("resolves a dot-path into nested state", () => {
      const { deps } = setup(`<div></div>`, {
        getState: () => ({ rootPanel: { activeTabId: "tab-7" } }),
      });
      const res = dispatchCommand({ action: "getState", path: "rootPanel.activeTabId" }, deps);
      expect(res.value).toBe("tab-7");
    });

    it("fails on an unresolvable path", () => {
      const { deps } = setup(`<div></div>`, { getState: () => ({ a: {} }) });
      const res = dispatchCommand({ action: "getState", path: "a.b.c" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("a.b.c");
    });
  });

  describe("unknown command", () => {
    it("fails gracefully", () => {
      const { deps } = setup(`<div></div>`);
      // deliberately bypass the type system to simulate a malformed command
      const res = dispatchCommand({ action: "frobnicate" } as never, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("frobnicate");
    });
  });
});
