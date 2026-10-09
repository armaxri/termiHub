import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { checkA11y } from "@/test/axe";
import { pressRadioArrow } from "@/test/radioKeyboard";
import { RadioGroup, type RadioGroupOption } from "./RadioGroup";

let container: HTMLDivElement;
let root: Root;

function byTestId(testid: string): HTMLElement {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
}

const OPTIONS: RadioGroupOption[] = [
  { value: "a", label: "Alpha", description: "First choice", "data-testid": "card-a" },
  { value: "b", label: "Beta", description: "Second choice", "data-testid": "card-b" },
  { value: "c", label: "Gamma", "data-testid": "card-c" },
];

/** Uncontrolled harness so arrow-key selection is visible in aria-checked. */
function Harness({
  onChange,
  orientation,
}: {
  onChange?: (v: string) => void;
  orientation?: "horizontal" | "vertical";
}) {
  const [value, setValue] = useState("a");
  return (
    <RadioGroup
      variant="cards"
      orientation={orientation}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      aria-label="Pick a card"
      options={OPTIONS}
      data-testid="cards"
    />
  );
}

describe("RadioGroup cards variant", () => {
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

  it("renders a named radiogroup whose cards are the radios", () => {
    act(() => root.render(<Harness />));
    const group = byTestId("cards");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.classList.contains("ui-radio-group--cards")).toBe(true);
    const card = byTestId("card-a");
    expect(card.getAttribute("role")).toBe("radio");
    expect(card.classList.contains("ui-radio-card")).toBe(true);
    expect(card.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("card-b").getAttribute("aria-checked")).toBe("false");
  });

  it("names each card by its label and describes it by its description", () => {
    act(() => root.render(<Harness />));
    const card = byTestId("card-b");
    const labelId = card.getAttribute("aria-labelledby") as string;
    const descId = card.getAttribute("aria-describedby") as string;
    expect(document.getElementById(labelId)?.textContent).toBe("Beta");
    expect(document.getElementById(descId)?.textContent).toBe("Second choice");
    // No description → no dangling aria-describedby.
    expect(byTestId("card-c").hasAttribute("aria-describedby")).toBe(false);
  });

  it("selects a card on click", () => {
    const onChange = vi.fn();
    act(() => root.render(<Harness onChange={onChange} />));
    act(() => byTestId("card-c").click());
    expect(onChange).toHaveBeenCalledWith("c");
    expect(byTestId("card-c").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("card-c").getAttribute("data-state")).toBe("checked");
  });

  it("moves focus and selection with the arrow keys (vertical)", async () => {
    const onChange = vi.fn();
    act(() => root.render(<Harness onChange={onChange} />));
    const a = byTestId("card-a");
    act(() => a.focus());
    await pressRadioArrow(a, "ArrowDown");
    expect(document.activeElement).toBe(byTestId("card-b"));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(byTestId("card-b").getAttribute("aria-checked")).toBe("true");
  });

  it("moves with Left/Right when horizontal", async () => {
    const onChange = vi.fn();
    act(() => root.render(<Harness onChange={onChange} orientation="horizontal" />));
    const a = byTestId("card-a");
    act(() => a.focus());
    await pressRadioArrow(a, "ArrowRight");
    expect(document.activeElement).toBe(byTestId("card-b"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("forwards a per-option title and disabled state", () => {
    act(() =>
      root.render(
        <RadioGroup
          variant="cards"
          value="a"
          onValueChange={() => {}}
          aria-label="Pick"
          options={[OPTIONS[0], { ...OPTIONS[1], disabled: true, title: "Not available" }]}
        />
      )
    );
    const b = byTestId("card-b");
    expect(b.hasAttribute("disabled")).toBe(true);
    expect(b.getAttribute("title")).toBe("Not available");
  });

  it("has no a11y violations", async () => {
    act(() => root.render(<Harness />));
    expect(await checkA11y()).toHaveNoViolations();
  });
});
