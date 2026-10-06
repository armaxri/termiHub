/**
 * The app's native open/save file dialogs, with a test-bridge stub seam (#4122).
 *
 * Every native file dialog in the app goes through `open` / `save` here, never
 * straight through `@tauri-apps/plugin-dialog` (an ESLint rule enforces it). In
 * normal use they are thin pass-throughs to the plugin.
 *
 * The Python system-test harness cannot drive an OS dialog, so in test-bridge
 * mode it pre-programs the next dialog's result through the `stubNativeDialog`
 * bridge verb, which calls {@link setNativeDialogStub}. The next `open` / `save`
 * then returns that path (or `null`, a cancel) without showing a dialog. The
 * verb also asks the test-bridge-only backend command `test_allow_dialog_path`
 * for the fs-scope grant a real pick makes, so a following `writeTextFile` /
 * `readTextFile` works.
 *
 * A stub is honoured only while the test bridge is enabled
 * ({@link isTestBridgeEnabled}), which a production build without
 * `VITE_TEST_BRIDGE=1` can never be (SEC-005). There is one pending stub per
 * dialog kind: setting a new one replaces the old, so a stub left over by a
 * failed test cannot leak further than the next stub.
 */
import {
  open as pluginOpen,
  save as pluginSave,
  type OpenDialogOptions,
  type OpenDialogReturn,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

import { isTestBridgeEnabled } from "@/testbridge/testMode";

/** Which native dialog a stub answers. */
export type NativeDialogKind = "open" | "save";

/** A pending stubbed result: the chosen path, or `null` for a cancel. */
interface PendingStub {
  path: string | null;
}

const pending: Record<NativeDialogKind, PendingStub | undefined> = {
  open: undefined,
  save: undefined,
};

/**
 * Pre-program the next `kind` dialog's result (test bridge only).
 *
 * @param kind - The dialog the stub answers.
 * @param path - The path the dialog "returns", or `null` to simulate a cancel.
 * @throws When the test bridge is not enabled.
 */
export function setNativeDialogStub(kind: NativeDialogKind, path: string | null): void {
  if (!isTestBridgeEnabled()) throw new Error("test bridge is not enabled");
  pending[kind] = { path };
}

/** Drop every pending stub. For unit tests. */
export function clearNativeDialogStubs(): void {
  pending.open = undefined;
  pending.save = undefined;
}

/** Take the pending `kind` stub, honoured only while the bridge is enabled. */
function takeStub(kind: NativeDialogKind): PendingStub | undefined {
  const stub = pending[kind];
  pending[kind] = undefined;
  return stub && isTestBridgeEnabled() ? stub : undefined;
}

/**
 * Show the native save dialog (or answer it from a test-bridge stub).
 *
 * @param options - The plugin's save-dialog options.
 * @returns The chosen path, or `null` when the dialog was cancelled.
 */
export async function save(options?: SaveDialogOptions): Promise<string | null> {
  const stub = takeStub("save");
  if (stub) return stub.path;
  return pluginSave(options);
}

/**
 * Show the native open dialog (or answer it from a test-bridge stub).
 *
 * @param options - The plugin's open-dialog options.
 * @returns The chosen path (an array when `multiple`), or `null` when cancelled.
 */
export async function open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>> {
  const stub = takeStub("open");
  if (!stub) return pluginOpen(options);
  if (stub.path === null) return null as OpenDialogReturn<T>;
  return (options?.multiple ? [stub.path] : stub.path) as OpenDialogReturn<T>;
}
