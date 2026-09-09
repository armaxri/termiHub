/**
 * Tagging Monaco's hidden input element for the test bridge.
 *
 * Monaco renders to a canvas with no test-addressable text input, so the system
 * -test harness targets Monaco's *hidden input* — tagged {@link EDITOR_INPUT_TESTID}
 * — to focus the editor and drive its cursor / Save keybindings via `pressKey`.
 *
 * Which element powers that input depends on the webview's `EditContext` support:
 *   - a `<textarea class="inputarea">` when `EditContext` is **unavailable**
 *     (WebKitGTK on Linux, WKWebView on macOS), or
 *   - a `<div class="native-edit-context">` when it **is** available (WebView2 on
 *     Windows, and any Chromium-based engine).
 *
 * Selecting only the textarea left `editor-input` unset on WebView2, so the
 * harness could neither focus nor key the editor there at all (`no element with
 * data-testid="editor-input"`) — #2689. Tagging whichever element the engine
 * actually created keeps the keyboard path engine-agnostic.
 */

import type { EditorCursorDirection } from "@/types/terminal";

/** The `data-testid` the harness uses to target Monaco's hidden input. */
export const EDITOR_INPUT_TESTID = "editor-input";

/** CSS selector matching Monaco's hidden input in either edit-context mode. */
const MONACO_INPUT_SELECTOR = "textarea.inputarea, .native-edit-context";

/**
 * Resolve Monaco's hidden input element within an editor DOM node, whichever
 * edit-context mode this webview engine put it in. Returns `null` when the node
 * is absent or the input has not been created yet.
 */
export function findMonacoInput(domNode: Element | null | undefined): Element | null {
  return domNode?.querySelector(MONACO_INPUT_SELECTOR) ?? null;
}

/**
 * Tag Monaco's hidden input with {@link EDITOR_INPUT_TESTID} so the test bridge
 * can target it. A no-op when the input element is not present.
 */
export function tagMonacoInput(domNode: Element | null | undefined): void {
  findMonacoInput(domNode)?.setAttribute("data-testid", EDITOR_INPUT_TESTID);
}

/**
 * Editor-construction option overrides that make Monaco's hidden input reliably
 * addressable by the test bridge, keyed on whether the bridge is active.
 *
 * Under the bridge we force the classic `<textarea class="inputarea">` input by
 * disabling Monaco's `EditContext` path (`editContext: false`). This is the
 * root fix for the cursor-navigation E2E (#2694): Monaco gates arrow keys on the
 * `textInputFocus` context key, which the bridge's `pressKey` flips by
 * dispatching a synthetic `focus` event at the input.
 *
 *  - In **textarea mode** that event is authoritative — `TextAreaInput` sets its
 *    focus flag straight from the DOM `focus` event, so `textInputFocus` flips
 *    true regardless of whether OS-level focus actually landed.
 *  - In **EditContext mode** (Chromium/WebView2, and the WebKit engines that now
 *    ship it — WKWebView, recent WebKitGTK) a `FocusTracker` instead *re-reads*
 *    `document.activeElement` on every `focus` event and ignores the synthetic
 *    one. When the webview is not the OS key window (occluded CI) `element.focus()`
 *    no-ops, so the tracker keeps reporting "not focused", `textInputFocus` never
 *    flips, and arrow keydowns silently no-op — while the Save chord still works
 *    because its custom keybinding has no `textInputFocus` precondition. That
 *    asymmetry is exactly the #2694 failure (save passes, cursor times out).
 *
 * Forcing textarea mode makes the keyboard path engine-agnostic across all three
 * webviews. It is test-only: production launches (bridge off) keep EditContext.
 */
export function testInputEditorOptions(bridgeEnabled: boolean): { editContext?: boolean } {
  return bridgeEnabled ? { editContext: false } : {};
}

/** Source string tagged on the caret-move command so its origin is traceable. */
export const CURSOR_TRIGGER_SOURCE = "test-bridge";

/** The subset of a Monaco editor {@link moveEditorCursor} drives. */
export interface CursorMovableEditor {
  /** Run a registered editor command by id (e.g. Monaco's core `cursorDown`). */
  trigger(source: string | null | undefined, handlerId: string, payload?: unknown): void;
}

/** Monaco core-command id that moves the caret one step in each direction. */
const CURSOR_COMMAND: Record<EditorCursorDirection, string> = {
  up: "cursorUp",
  down: "cursorDown",
  left: "cursorLeft",
  right: "cursorRight",
};

/**
 * Move Monaco's caret `times` steps in `direction` via its **command API** —
 * `editor.trigger("test-bridge", "cursorDown", …)` — rather than a synthetic
 * arrow keydown.
 *
 * This is the root fix for the system-test cursor-navigation check (#2694). A
 * synthetic keydown only moves the caret if Monaco's `textInputFocus` context
 * key is set, which requires the hidden input to be genuinely focused. On an
 * occluded CI webview (headless ubuntu/macOS) `element.focus()` no-ops and no
 * synthetic `focus` reliably flips `textInputFocus` across every engine, so the
 * arrow keydown fires but the caret never moves — the deterministic failure that
 * survived three key/focus/input-mode fixes (#2685, #2692, #2696).
 *
 * `trigger` invokes Monaco's core cursor command directly, with no keybinding
 * resolution and no `textInputFocus` precondition, so it is engine- and
 * focus-independent. It still runs the *real* cursor movement, firing
 * `onDidChangeCursorPosition` exactly as an arrow key would — which is the app
 * wiring the test actually asserts (cursor move → `editorStatus` Ln/Col → status
 * bar). It is reached only through the store's test-bridge `editorCursor` verb.
 */
export function moveEditorCursor(
  editor: CursorMovableEditor,
  direction: EditorCursorDirection,
  times = 1
): void {
  const handlerId = CURSOR_COMMAND[direction];
  for (let i = 0; i < times; i++) {
    editor.trigger(CURSOR_TRIGGER_SOURCE, handlerId, null);
  }
}
