import { PointerSensor, type PointerSensorProps } from "@dnd-kit/core";

/**
 * The parts of dnd-kit's `AbstractPointerSensor` this subclass reaches into.
 * They are TypeScript-`private` but plain instance members at runtime (checked
 * against @dnd-kit/core 6.3.1; the regression test fails if they move, and the
 * sensor falls back to the stock behaviour).
 */
interface PointerSensorInternals {
  detach: () => void;
  documentListeners: { removeAll: () => void };
  document: Document;
}

/**
 * dnd-kit's `PointerSensor`, with the post-drag click blocker scoped to the
 * release that ended the drag (#4978).
 *
 * On drag activation the stock sensor adds a capture-phase `click` listener to
 * the document that stops every click, so the click a release fires is not read
 * as a click on the dragged item. It only removes that listener 50 ms after the
 * release. When the release fires **no** click — WebView2 and WebKitGTK fire
 * none once the drop re-parents the pressed row, e.g. a connection dropped into
 * a folder — the blocker instead eats whatever click starts in those 50 ms.
 *
 * A release's own click always arrives before the next press, so this sensor
 * also drops the blocker on the next `pointerdown`: the click that ends a drag
 * stays suppressed, a new click is never lost.
 */
export class ReleaseScopedPointerSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    super(props);
    const self = this as unknown as Partial<PointerSensorInternals>;
    // Unknown internals (a dnd-kit upgrade): keep the stock behaviour.
    if (typeof self.detach !== "function" || !self.documentListeners || !self.document) return;
    const { documentListeners, document: doc } = self;
    const detach = self.detach.bind(self);
    self.detach = () => {
      detach();
      const unblock = () => {
        doc.removeEventListener("pointerdown", unblock, true);
        documentListeners.removeAll();
      };
      doc.addEventListener("pointerdown", unblock, true);
      // The stock teardown has removed the blocker by then; stop listening too.
      setTimeout(() => doc.removeEventListener("pointerdown", unblock, true), 100);
    };
  }
}
