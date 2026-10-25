import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { handleCommand } from "./mockBackend";

mockWindows("main");
mockIPC((cmd, args) => handleCommand(cmd, args as Record<string, unknown> | undefined), {
  shouldMockEvents: true,
});
await import("../../../src/main.tsx");

// Expose the app store to the Playwright spec so it can open surfaces (a sidebar,
// Settings, a dialog) directly instead of replaying fragile click paths. Imported
// after main.tsx so it is the same module instance the app uses.
const { useAppStore } = await import("../../../src/store/appStore");
// `emit` feeds mocked backend events (terminal output) to the app's listeners;
// `applyTheme` switches the theme without a settings round trip (#4949).
const { emit } = await import("@tauri-apps/api/event");
const { applyTheme } = await import("../../../src/themes/engine");
(window as unknown as { __visual: unknown }).__visual = { store: useAppStore, emit, applyTheme };
