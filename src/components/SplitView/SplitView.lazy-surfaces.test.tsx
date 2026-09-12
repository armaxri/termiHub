import { describe, it, expect } from "vitest";

// PERF-003: the non-terminal tab surfaces are code-split out of the eager entry
// chunk via `React.lazy(() => import(path).then((m) => ({ default: m.Name })))`
// in SplitView. That contract has two silent failure modes tsc alone cannot fully
// guard once a barrel/path is refactored: the dynamic-import path drifting, or the
// named export being renamed so `m.Name` resolves to `undefined` (React.lazy would
// then throw only at render, inside a Suspense boundary, at runtime). These loaders
// mirror SplitView's exactly; each must resolve to a real component so the split
// keeps working and the surface still renders when its boundary mounts.
const lazySurfaceLoaders: Record<string, () => Promise<unknown>> = {
  SettingsPanel: () => import("@/components/Settings/SettingsPanel").then((m) => m.SettingsPanel),
  ConnectionEditor: () =>
    import("@/components/ConnectionEditor/ConnectionEditor").then((m) => m.ConnectionEditor),
  LogViewer: () => import("@/components/LogViewer/LogViewer").then((m) => m.LogViewer),
  TunnelEditor: () => import("@/components/TunnelEditor/TunnelEditor").then((m) => m.TunnelEditor),
  WorkspaceEditor: () =>
    import("@/components/WorkspaceEditor/WorkspaceEditor").then((m) => m.WorkspaceEditor),
  NetworkDiagnosticPanel: () =>
    import("@/components/NetworkTools/NetworkDiagnosticPanel").then(
      (m) => m.NetworkDiagnosticPanel
    ),
  PluginDetailPanel: () =>
    import("@/components/Plugins/PluginDetailPanel").then((m) => m.PluginDetailPanel),
  RemoteDesktopTab: () =>
    import("@/components/RemoteDesktop/RemoteDesktopTab").then((m) => m.RemoteDesktopTab),
  FileBrowserTab: () =>
    import("@/components/Terminal/FileBrowserTab").then((m) => m.FileBrowserTab),
  AgentErrorTab: () => import("@/components/Terminal/AgentErrorTab").then((m) => m.AgentErrorTab),
};

describe("SplitView lazy tab surfaces (PERF-003)", () => {
  it.each(Object.entries(lazySurfaceLoaders))(
    "%s resolves via its dynamic import to a component",
    async (_name, load) => {
      const component = await load();
      // A renderable React component is a function (function/forwardRef/memo would
      // be an object, but all ten surfaces are plain function components). A drifted
      // path rejects the import; a renamed export resolves to `undefined`.
      expect(component).toBeDefined();
      expect(typeof component).toBe("function");
    }
  );
});
