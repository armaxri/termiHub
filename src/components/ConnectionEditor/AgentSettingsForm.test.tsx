import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentSettingsForm } from "./AgentSettingsForm";
import { DEFAULT_AGENT_SETTINGS, AgentSettings } from "@/types/connection";

let container: HTMLDivElement;
let root: Root;

function renderWith(settings: AgentSettings, onChange = vi.fn()) {
  act(() => {
    root.render(<AgentSettingsForm settings={settings} onChange={onChange} />);
  });
  return onChange;
}

/** Drive a controlled input the way a real keystroke would. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function scrollbackInput(): HTMLInputElement {
  const el = Array.from(container.querySelectorAll(".settings-form__label")).find(
    (l) => l.textContent === "Persistent Scrollback Buffer"
  );
  return el?.closest(".settings-form__field")?.querySelector("input") as HTMLInputElement;
}

describe("AgentSettingsForm — persistent scrollback buffer", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the buffer size through the shared NumberInput primitive (#1453)", () => {
    renderWith({ ...DEFAULT_AGENT_SETTINGS, persistentScrollbackBufferSizeMb: 8 });
    expect(scrollbackInput().classList.contains("ui-input")).toBe(true);
    expect(scrollbackInput().type).toBe("number");
    expect(scrollbackInput().value).toBe("8");
  });

  it("editing to a valid size emits that number (#1453)", () => {
    const onChange = renderWith({ ...DEFAULT_AGENT_SETTINGS, persistentScrollbackBufferSizeMb: 8 });
    setValue(scrollbackInput(), "32");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ persistentScrollbackBufferSizeMb: 32 })
    );
  });

  it("clearing the field leaves it blank without coercing to a default (#1453)", () => {
    const onChange = renderWith({ ...DEFAULT_AGENT_SETTINGS, persistentScrollbackBufferSizeMb: 8 });
    setValue(scrollbackInput(), "");
    // The cleared field reads blank...
    expect(scrollbackInput().value).toBe("");
    // ...and is never persisted as a silently-coerced default (previously `1`).
    for (const call of onChange.mock.calls) {
      expect(call[0].persistentScrollbackBufferSizeMb).not.toBe(1);
    }
  });
});
