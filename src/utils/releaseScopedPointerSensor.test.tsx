/**
 * Regression test for #4978: after a real-pointer drag whose release produced no
 * `click` (the pressed row was moved into a folder by the drop, so WebView2 and
 * WebKitGTK fire none), the next click — pressed within dnd-kit's 50 ms listener
 * teardown — was swallowed by the stock PointerSensor's capture-phase click
 * blocker. The drag's own click can only arrive before the next press, so
 * {@link ReleaseScopedPointerSensor} drops the blocker on that press.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import { ReleaseScopedPointerSensor } from "./releaseScopedPointerSensor";

type SensorClass = typeof PointerSensor | typeof ReleaseScopedPointerSensor;

function Handle() {
  const { setNodeRef, listeners, attributes } = useDraggable({ id: "row" });
  return (
    <button ref={setNodeRef} data-testid="handle" {...listeners} {...attributes}>
      row
    </button>
  );
}

function Harness({
  sensor,
  onEnd,
  onClick,
}: {
  sensor: SensorClass;
  onEnd: () => void;
  onClick: () => void;
}) {
  const sensors: SensorDescriptor<SensorOptions>[] = useSensors(
    useSensor(sensor, { activationConstraint: { distance: 8 } })
  );
  return (
    <>
      <DndContext sensors={sensors} onDragEnd={onEnd}>
        <Handle />
      </DndContext>
      <button data-testid="other" onClick={onClick}>
        other
      </button>
    </>
  );
}

function pointer(el: Element, type: string, x: number, buttons: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 10,
      button: 0,
      buttons,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    })
  );
}

let root: Root;
let container: HTMLDivElement;
const onEnd = vi.fn();
const onClick = vi.fn();

function mount(sensor: SensorClass): void {
  act(() => {
    root.render(<Harness sensor={sensor} onEnd={onEnd} onClick={onClick} />);
  });
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;

/** Press on the row, move past the activation distance, release with no click. */
function dragWithoutReleaseClick(): void {
  const handle = byTestId("handle");
  act(() => pointer(handle, "pointerdown", 10, 1));
  act(() => pointer(document, "pointermove", 40, 1));
  act(() => pointer(document, "pointermove", 60, 1));
  act(() => pointer(document, "pointerup", 60, 0));
}

/** A full click on the other button, pressed right after the drag (< 50 ms). */
function clickOther(): void {
  const other = byTestId("other");
  pointer(other, "pointerdown", 200, 1);
  pointer(other, "pointerup", 200, 0);
  other.click();
}

beforeEach(() => {
  onEnd.mockReset();
  onClick.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ReleaseScopedPointerSensor (#4978)", () => {
  it("lets the next click through when the drag's release produced none", () => {
    mount(ReleaseScopedPointerSensor);
    dragWithoutReleaseClick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    clickOther();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still swallows the click that ends the drag itself", () => {
    mount(ReleaseScopedPointerSensor);
    dragWithoutReleaseClick();
    byTestId("other").click(); // the release's own click, before any new press
    expect(onClick).not.toHaveBeenCalled();
  });

  it("documents the root cause: the stock PointerSensor eats that next click", () => {
    // If this ever fails, dnd-kit fixed it upstream and the subclass can go.
    mount(PointerSensor);
    dragWithoutReleaseClick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    clickOther();
    expect(onClick).not.toHaveBeenCalled();
  });
});
