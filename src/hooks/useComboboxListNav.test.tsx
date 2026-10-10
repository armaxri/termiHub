import { describe, it, expect, vi, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useComboboxListNav, type UseComboboxListNavOptions } from "./useComboboxListNav";

interface HarnessProps {
  items: string[];
  onSelect?: (item: string) => void;
  homeEnd?: boolean;
  listId?: string;
  getItemKey?: UseComboboxListNavOptions<string>["getItemKey"];
  onUnhandledKeyDown?: UseComboboxListNavOptions<string>["onUnhandledKeyDown"];
  autocomplete?: boolean;
  open?: boolean;
  onClose?: () => void;
}

/** A minimal search picker: filters `items` by the query and wires the hook. */
function Harness({
  items,
  onSelect = () => {},
  homeEnd,
  listId,
  getItemKey,
  onUnhandledKeyDown,
  autocomplete,
  open,
  onClose,
}: HarnessProps) {
  const [query, setQuery] = useState("");
  const results = items.filter((i) => i.includes(query));
  const nav = useComboboxListNav({
    items: results,
    onSelect,
    resetKey: query,
    homeEnd,
    listId,
    getItemKey,
    onUnhandledKeyDown,
    autocomplete,
    open,
    onClose,
  });
  return (
    <div>
      <input
        data-testid="input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        {...nav.inputProps}
      />
      <ul {...nav.listboxProps} data-testid="list">
        {results.map((item, index) => (
          <li key={item} {...nav.getOptionProps(index)} data-testid={`opt-${item}`}>
            {item}
          </li>
        ))}
      </ul>
      <span data-testid="active">{nav.activeIndex}</span>
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(element: React.ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function cleanup(): void {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

const input = () => byTestId("input") as HTMLInputElement;
const active = () => Number(byTestId("active").textContent);

/** Dispatch a keydown on the input the way a real keystroke would. */
function key(k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
    );
  });
}

/** Type into the controlled input, driving the native onChange. */
function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function hover(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}

afterEach(cleanup);

describe("useComboboxListNav", () => {
  it("wires the combobox to the listbox and the active option", () => {
    render(<Harness items={["alpha", "beta"]} />);
    const list = byTestId("list");
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(list.getAttribute("role")).toBe("listbox");
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    const first = byTestId("opt-alpha");
    expect(first.getAttribute("role")).toBe("option");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
  });

  it("wraps ArrowDown / ArrowUp around the list", () => {
    render(<Harness items={["a1", "a2", "a3"]} />);
    key("ArrowDown");
    expect(active()).toBe(1);
    key("ArrowDown");
    key("ArrowDown");
    expect(active()).toBe(0);
    key("ArrowUp");
    expect(active()).toBe(2);
    expect(input().getAttribute("aria-activedescendant")).toBe(byTestId("opt-a3").id);
  });

  it("ignores Home / End unless enabled", () => {
    render(<Harness items={["a1", "a2", "a3"]} />);
    key("End");
    expect(active()).toBe(0);
    cleanup();
    render(<Harness items={["a1", "a2", "a3"]} homeEnd />);
    key("End");
    expect(active()).toBe(2);
    key("Home");
    expect(active()).toBe(0);
  });

  it("picks the active option on Enter and on click", () => {
    const onSelect = vi.fn();
    render(<Harness items={["a1", "a2"]} onSelect={onSelect} />);
    key("ArrowDown");
    key("Enter");
    expect(onSelect).toHaveBeenLastCalledWith("a2");
    click(byTestId("opt-a1"));
    expect(onSelect).toHaveBeenLastCalledWith("a1");
  });

  it("makes a hovered option active", () => {
    render(<Harness items={["a1", "a2"]} />);
    hover(byTestId("opt-a2"));
    expect(active()).toBe(1);
  });

  it("does nothing while an IME composition is in progress", () => {
    const onSelect = vi.fn();
    render(<Harness items={["a1", "a2"]} onSelect={onSelect} />);
    key("ArrowDown", { isComposing: true });
    expect(active()).toBe(0);
    key("Enter", { keyCode: 229 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("re-targets the top option when the query changes", () => {
    render(<Harness items={["a1", "a2", "a3"]} />);
    key("ArrowDown");
    key("ArrowDown");
    expect(active()).toBe(2);
    type("a");
    expect(active()).toBe(0);
  });

  it("clears the active option when nothing matches and Enter is inert", () => {
    const onSelect = vi.fn();
    render(<Harness items={["a1"]} onSelect={onSelect} />);
    type("zzz");
    expect(active()).toBe(-1);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    key("ArrowDown");
    key("Enter");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("derives option ids from the list id and item key", () => {
    render(<Harness items={["a b", "c"]} listId="my-list" getItemKey={(item) => `key:${item}`} />);
    expect(byTestId("list").id).toBe("my-list");
    expect(byTestId("opt-a b").id).toBe("my-list-opt-key_a_b");
    cleanup();
    render(<Harness items={["x", "y"]} listId="idx" />);
    expect(byTestId("opt-y").id).toBe("idx-opt-1");
  });

  it("forwards keys it does not handle", () => {
    const onUnhandled = vi.fn();
    render(<Harness items={["a1"]} onUnhandledKeyDown={onUnhandled} />);
    key("Backspace");
    key("ArrowDown");
    expect(onUnhandled).toHaveBeenCalledTimes(1);
    expect(onUnhandled.mock.calls[0][0].key).toBe("Backspace");
  });

  it("scrolls the active option into view", () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<Harness items={["a1", "a2"]} />);
      scroll.mockClear();
      key("ArrowDown");
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  describe("autocomplete mode", () => {
    it("starts with nothing highlighted", () => {
      render(<Harness items={["a1", "a2"]} autocomplete />);
      expect(active()).toBe(-1);
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(byTestId("opt-a1").getAttribute("aria-selected")).toBe("false");
    });

    it("moves from no highlight to the first / last option and wraps", () => {
      render(<Harness items={["a1", "a2", "a3"]} autocomplete />);
      key("ArrowDown");
      expect(active()).toBe(0);
      expect(input().getAttribute("aria-activedescendant")).toBe(byTestId("opt-a1").id);
      key("ArrowUp");
      expect(active()).toBe(2);
      key("ArrowDown");
      expect(active()).toBe(0);
      cleanup();
      render(<Harness items={["a1", "a2", "a3"]} autocomplete />);
      key("ArrowUp");
      expect(active()).toBe(2);
    });

    it("forwards Enter with nothing highlighted and picks the highlighted option", () => {
      const onSelect = vi.fn();
      const onUnhandled = vi.fn();
      render(
        <Harness
          items={["a1", "a2"]}
          autocomplete
          onSelect={onSelect}
          onUnhandledKeyDown={onUnhandled}
        />
      );
      key("Enter");
      expect(onSelect).not.toHaveBeenCalled();
      expect(onUnhandled).toHaveBeenCalledTimes(1);
      expect(onUnhandled.mock.calls[0][0].key).toBe("Enter");
      expect(onUnhandled.mock.calls[0][0].defaultPrevented).toBe(false);
      key("ArrowDown");
      key("Enter");
      expect(onSelect).toHaveBeenCalledWith("a1");
      expect(onUnhandled).toHaveBeenCalledTimes(1);
    });

    it("clears the highlight when the reset key changes", () => {
      render(<Harness items={["a1", "a2"]} autocomplete />);
      key("ArrowDown");
      key("ArrowDown");
      expect(active()).toBe(1);
      type("a");
      expect(active()).toBe(-1);
    });

    it("closes on Escape when onClose is given, clearing the highlight", () => {
      const onClose = vi.fn();
      const onUnhandled = vi.fn();
      render(
        <Harness
          items={["a1", "a2"]}
          autocomplete
          onClose={onClose}
          onUnhandledKeyDown={onUnhandled}
        />
      );
      key("ArrowDown");
      key("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(active()).toBe(-1);
    });

    it("forwards Escape when no onClose is given", () => {
      const onUnhandled = vi.fn();
      render(<Harness items={["a1"]} autocomplete onUnhandledKeyDown={onUnhandled} />);
      key("Escape");
      expect(onUnhandled).toHaveBeenCalledTimes(1);
      expect(onUnhandled.mock.calls[0][0].key).toBe("Escape");
    });
  });

  describe("open flag", () => {
    it("navigates nothing and forwards every key while closed", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      const onUnhandled = vi.fn();
      render(
        <Harness
          items={["a1", "a2"]}
          open={false}
          onSelect={onSelect}
          onClose={onClose}
          onUnhandledKeyDown={onUnhandled}
        />
      );
      expect(active()).toBe(-1);
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      key("ArrowDown");
      key("Enter");
      key("Escape");
      expect(onSelect).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onUnhandled.mock.calls.map((c) => c[0].key)).toEqual(["ArrowDown", "Enter", "Escape"]);
    });

    it("restores the highlighted position when the list reopens", () => {
      function Toggle() {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button data-testid="toggle" onClick={() => setOpen((o) => !o)} />
            <Harness items={["a1", "a2", "a3"]} autocomplete open={open} />
          </>
        );
      }
      render(<Toggle />);
      key("ArrowDown");
      key("ArrowDown");
      expect(active()).toBe(1);
      click(byTestId("toggle"));
      expect(active()).toBe(-1);
      click(byTestId("toggle"));
      expect(active()).toBe(1);
    });
  });

  it("still handles Enter itself in the default mode when nothing matches", () => {
    const onUnhandled = vi.fn();
    render(<Harness items={[]} onUnhandledKeyDown={onUnhandled} />);
    key("Enter");
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});
