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
(window as unknown as { __visual: unknown }).__visual = { store: useAppStore };
