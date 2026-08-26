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
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
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

  describe("getValue", () => {
    it("returns the live value of a controlled input, not the attribute", async () => {
      const { deps, container } = setup(`<input data-testid="port" value="22" />`);
      // Simulate a React-controlled input: the DOM *property* diverges from the
      // markup attribute, which is exactly what `getAttribute` cannot observe.
      (container.querySelector("input") as HTMLInputElement).value = "2222";
      const res = await dispatchCommand({ action: "getValue", testId: "port" }, deps);
      expect(res).toEqual({ ok: true, action: "getValue", value: "2222" });
    });

    it("returns a select's current value", async () => {
      const { deps } = setup(`<select data-testid="lock">
        <option value="never">Never</option>
        <option value="5m" selected>5 minutes</option>
      </select>`);
      const res = await dispatchCommand({ action: "getValue", testId: "lock" }, deps);
      expect(res).toEqual({ ok: true, action: "getValue", value: "5m" });
    });

    it("returns a textarea's value", async () => {
      const { deps } = setup(`<textarea data-testid="notes">hello</textarea>`);
      const res = await dispatchCommand({ action: "getValue", testId: "notes" }, deps);
      expect(res).toEqual({ ok: true, action: "getValue", value: "hello" });
    });

    it("fails on a non-value element", async () => {
      const { deps } = setup(`<div data-testid="status">x</div>`);
      const res = await dispatchCommand({ action: "getValue", testId: "status" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/value/i);
    });

    it("fails when the element is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "getValue", testId: "ghost" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
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

    it("fires pointerdown before the click (for Radix-style menu triggers)", async () => {
      const { deps, container } = setup(`<button data-testid="go">Go</button>`);
      const seen: string[] = [];
      const btn = container.querySelector("button")!;
      btn.addEventListener("pointerdown", () => seen.push("pointerdown"));
      btn.addEventListener("mousedown", () => seen.push("mousedown"));
      btn.addEventListener("click", () => seen.push("click"));

      await dispatchCommand({ action: "click", testId: "go" }, deps);
      // A real click opens libraries that open on pointerdown, then fires click.
      expect(seen[0]).toBe("pointerdown");
      expect(seen).toContain("click");
    });

    it("fails when the target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "click", testId: "go" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("doubleClick", () => {
    it("dispatches a dblclick the element's handler observes", async () => {
      const { deps, container } = setup(`<button data-testid="conn">Conn</button>`);
      const handler = vi.fn();
      container.querySelector("button")!.addEventListener("dblclick", handler);

      const res = await dispatchCommand({ action: "doubleClick", testId: "conn" }, deps);
      expect(res).toEqual({ ok: true, action: "doubleClick" });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("fires two click rounds before the dblclick (a real double-click)", async () => {
      const { deps, container } = setup(`<button data-testid="conn">Conn</button>`);
      const seen: string[] = [];
      const btn = container.querySelector("button")!;
      btn.addEventListener("click", () => seen.push("click"));
      btn.addEventListener("dblclick", () => seen.push("dblclick"));

      await dispatchCommand({ action: "doubleClick", testId: "conn" }, deps);
      // Two clicks precede the dblclick, exactly like a real pointer double-click.
      expect(seen).toEqual(["click", "click", "dblclick"]);
    });

    it("fails when the target is absent", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "doubleClick", testId: "conn" }, deps);
      expect(res.ok).toBe(false);
    });
  });

  describe("resizeWindow", () => {
    it("calls the injected resizeWindow dep with the requested size", async () => {
      const resizeWindow = vi.fn(async () => {});
      const { deps } = setup(`<div></div>`, { resizeWindow });

      const res = await dispatchCommand({ action: "resizeWindow", width: 800, height: 600 }, deps);
      expect(res).toEqual({ ok: true, action: "resizeWindow" });
      expect(resizeWindow).toHaveBeenCalledWith(800, 600);
    });

    it("fails with the dep's error when the resize throws", async () => {
      const resizeWindow = vi.fn(async () => {
        throw new Error("window unavailable");
      });
      const { deps } = setup(`<div></div>`, { resizeWindow });

      const res = await dispatchCommand({ action: "resizeWindow", width: 800, height: 600 }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("window unavailable");
    });
  });

  describe("screenshot", () => {
    it("returns the data URL from the injected screenshot dep", async () => {
      const screenshot = vi.fn(async () => "data:image/png;base64,SGVsbG8=");
      const { deps } = setup(`<div></div>`, { screenshot });

      const res = await dispatchCommand({ action: "screenshot" }, deps);
      expect(res).toEqual({
        ok: true,
        action: "screenshot",
        value: "data:image/png;base64,SGVsbG8=",
      });
      expect(screenshot).toHaveBeenCalledOnce();
    });

    it("fails with the dep's error when capture throws", async () => {
      const screenshot = vi.fn(async () => {
        throw new Error("capture unavailable");
      });
      const { deps } = setup(`<div></div>`, { screenshot });

      const res = await dispatchCommand({ action: "screenshot" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("capture unavailable");
    });
  });

  describe("emitEvent", () => {
    it("forwards the event name and payload to the injected emitEvent dep", async () => {
      const emitEvent = vi.fn(async () => {});
      const { deps } = setup(`<div></div>`, { emitEvent });

      const payload = {
        agent_id: "agent-1",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        staged: true,
      };
      const res = await dispatchCommand(
        { action: "emitEvent", event: "agent-update-available", payload },
        deps
      );

      expect(res).toEqual({ ok: true, action: "emitEvent" });
      expect(emitEvent).toHaveBeenCalledWith("agent-update-available", payload);
    });

    it("emits with an undefined payload when none is given", async () => {
      const emitEvent = vi.fn(async () => {});
      const { deps } = setup(`<div></div>`, { emitEvent });

      const res = await dispatchCommand({ action: "emitEvent", event: "some-event" }, deps);

      expect(res.ok).toBe(true);
      expect(emitEvent).toHaveBeenCalledWith("some-event", undefined);
    });

    it("fails when the event name is empty", async () => {
      const emitEvent = vi.fn(async () => {});
      const { deps } = setup(`<div></div>`, { emitEvent });

      const res = await dispatchCommand({ action: "emitEvent", event: "" }, deps);

      expect(res.ok).toBe(false);
      expect(res.error).toContain("event name");
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("fails with the dep's error when emitting throws", async () => {
      const emitEvent = vi.fn(async () => {
        throw new Error("event bus unavailable");
      });
      const { deps } = setup(`<div></div>`, { emitEvent });

      const res = await dispatchCommand({ action: "emitEvent", event: "boom" }, deps);

      expect(res.ok).toBe(false);
      expect(res.error).toContain("event bus unavailable");
    });
  });

  describe("severAgentTransport", () => {
    it("forwards the agent id to the injected dep and returns its result", async () => {
      const severAgentTransport = vi.fn(async () => true);
      const { deps } = setup(`<div></div>`, { severAgentTransport });

      const res = await dispatchCommand(
        { action: "severAgentTransport", agentId: "agent-7" },
        deps
      );

      expect(res).toEqual({ ok: true, action: "severAgentTransport", value: true });
      expect(severAgentTransport).toHaveBeenCalledWith("agent-7");
    });

    it("passes through a false result for an unknown/dead agent", async () => {
      const severAgentTransport = vi.fn(async () => false);
      const { deps } = setup(`<div></div>`, { severAgentTransport });

      const res = await dispatchCommand({ action: "severAgentTransport", agentId: "gone" }, deps);

      expect(res).toEqual({ ok: true, action: "severAgentTransport", value: false });
    });

    it("fails when the agent id is empty", async () => {
      const severAgentTransport = vi.fn(async () => true);
      const { deps } = setup(`<div></div>`, { severAgentTransport });

      const res = await dispatchCommand({ action: "severAgentTransport", agentId: "" }, deps);

      expect(res.ok).toBe(false);
      expect(res.error).toContain("agentId");
      expect(severAgentTransport).not.toHaveBeenCalled();
    });

    it("fails cleanly when the dep is not wired (outside the harness)", async () => {
      const { deps } = setup(`<div></div>`);
      // The base deps in setup() do not include severAgentTransport.

      const res = await dispatchCommand(
        { action: "severAgentTransport", agentId: "agent-7" },
        deps
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("not available");
    });

    it("fails with the dep's error when the sever throws", async () => {
      const severAgentTransport = vi.fn(async () => {
        throw new Error("test bridge is not enabled");
      });
      const { deps } = setup(`<div></div>`, { severAgentTransport });

      const res = await dispatchCommand(
        { action: "severAgentTransport", agentId: "agent-7" },
        deps
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("test bridge is not enabled");
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

    it("yields to the event loop between press and release so @dnd-kit can measure", async () => {
      // Regression for #832: @dnd-kit measures droppable rects in a render/effect
      // cycle after activation, so the drag must yield a task between pointerdown
      // and pointerup. A timer scheduled on pointerdown must therefore fire
      // *before* pointerup — proving the gesture is not one synchronous burst.
      const { deps, container } = setup(`<div data-testid="a"></div><div data-testid="b"></div>`);
      const a = container.querySelectorAll("div")[0];
      const seq: string[] = [];
      a.addEventListener("pointerdown", () => {
        seq.push("down");
        setTimeout(() => seq.push("tick"), 0);
      });
      document.addEventListener("pointerup", () => seq.push("up"));

      await dispatchCommand({ action: "dragTo", fromTestId: "a", toTestId: "b" }, deps);
      expect(seq.indexOf("tick")).toBeGreaterThan(-1);
      expect(seq.indexOf("tick")).toBeLessThan(seq.indexOf("up"));
    });

    it("fails when an endpoint is absent", async () => {
      const { deps } = setup(`<div data-testid="a"></div>`);
      const res = await dispatchCommand({ action: "dragTo", fromTestId: "a", toTestId: "z" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("z");
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

    it("carries modifier flags on the dispatched event (e.g. Ctrl+S)", async () => {
      const { deps, container } = setup(`<input data-testid="field" />`);
      const input = container.querySelector("input")!;
      let seen: KeyboardEvent | undefined;
      input.addEventListener("keydown", (e) => (seen = e as KeyboardEvent));

      const res = await dispatchCommand(
        { action: "pressKey", key: "s", testId: "field", ctrl: true, shift: true },
        deps
      );
      expect(res).toEqual({ ok: true, action: "pressKey" });
      expect(seen?.ctrlKey).toBe(true);
      expect(seen?.shiftKey).toBe(true);
      expect(seen?.metaKey).toBe(false);
      expect(seen?.altKey).toBe(false);
    });

    it("gives the event a real legacy keyCode + code so Monaco can resolve it", async () => {
      const { deps, container } = setup(`<input data-testid="field" />`);
      const input = container.querySelector("input")!;
      let seen: KeyboardEvent | undefined;
      input.addEventListener("keydown", (e) => (seen = e as KeyboardEvent));

      await dispatchCommand({ action: "pressKey", key: "End", testId: "field", ctrl: true }, deps);
      // A synthetic event leaves keyCode 0; the dispatcher restores the legacy
      // numeric (End = 35) that Monaco's StandardKeyboardEvent reads.
      expect(seen?.keyCode).toBe(35);
      expect(seen?.code).toBe("End");
    });

    it("derives keyCode + code for a letter key", async () => {
      const { deps, container } = setup(`<input data-testid="field" />`);
      const input = container.querySelector("input")!;
      let seen: KeyboardEvent | undefined;
      input.addEventListener("keydown", (e) => (seen = e as KeyboardEvent));

      await dispatchCommand({ action: "pressKey", key: "s", testId: "field" }, deps);
      expect(seen?.keyCode).toBe(83);
      expect(seen?.code).toBe("KeyS");
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

  describe("scrollTerminal", () => {
    it("scrolls the active terminal by a signed line delta", async () => {
      const scroll = vi.fn(() => true);
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        scrollTerminal: scroll,
      });
      const res = await dispatchCommand({ action: "scrollTerminal", lines: -2000 }, deps);
      expect(res).toEqual({ ok: true, action: "scrollTerminal" });
      expect(scroll).toHaveBeenCalledWith("tab-1", -2000, false);
    });

    it("jumps to the bottom and defaults a missing line delta to 0", async () => {
      const scroll = vi.fn(() => true);
      const { deps } = setup(`<div></div>`, { scrollTerminal: scroll });
      const res = await dispatchCommand(
        { action: "scrollTerminal", toBottom: true, tabId: "tab-9" },
        deps
      );
      expect(res).toEqual({ ok: true, action: "scrollTerminal" });
      expect(scroll).toHaveBeenCalledWith("tab-9", 0, true);
    });

    it("fails when there is no active terminal", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "scrollTerminal", lines: 1 }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no .*terminal/i);
    });

    it("fails when the requested terminal is not registered", async () => {
      const { deps } = setup(`<div></div>`, { scrollTerminal: () => false });
      const res = await dispatchCommand({ action: "scrollTerminal", tabId: "ghost" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("ghost");
    });
  });

  describe("getTerminalViewport", () => {
    it("reads the active terminal's viewport position", async () => {
      const { deps } = setup(`<div></div>`, {
        getActiveTabId: () => "tab-1",
        getTerminalViewport: (tabId) =>
          tabId === "tab-1" ? { viewportY: 5, baseY: 42 } : undefined,
      });
      const res = await dispatchCommand({ action: "getTerminalViewport" }, deps);
      expect(res).toEqual({
        ok: true,
        action: "getTerminalViewport",
        value: { viewportY: 5, baseY: 42 },
      });
    });

    it("reads an explicit tabId", async () => {
      const { deps } = setup(`<div></div>`, {
        getTerminalViewport: (tabId) =>
          tabId === "tab-9" ? { viewportY: 0, baseY: 0 } : undefined,
      });
      const res = await dispatchCommand({ action: "getTerminalViewport", tabId: "tab-9" }, deps);
      expect(res.value).toEqual({ viewportY: 0, baseY: 0 });
    });

    it("fails when there is no active terminal", async () => {
      const { deps } = setup(`<div></div>`);
      const res = await dispatchCommand({ action: "getTerminalViewport" }, deps);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no .*terminal/i);
    });

    it("fails when the requested terminal is not registered", async () => {
      const { deps } = setup(`<div></div>`, { getTerminalViewport: () => undefined });
      const res = await dispatchCommand({ action: "getTerminalViewport", tabId: "ghost" }, deps);
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
