/** Paths dropped on a terminal pane are typed into it, and recorded (#5818). */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { LeafPanel } from "@/types/terminal";

const drop = vi.hoisted(() => ({ paths: null as ((paths: string[]) => Promise<void>) | null }));
vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));
vi.mock("@/hooks/useOsFileDrop", () => ({
  useOsFileDrop: (_ref: unknown, onDrop: (paths: string[]) => Promise<void>) => {
    drop.paths = onDrop;
    return { isDragOver: false };
  },
}));
vi.mock("@/services/detachedSessionInput", () => ({
  sendInputDetached: vi.fn(() => Promise.resolve()),
}));

import { sendInputDetached } from "@/services/detachedSessionInput";
import { useAppStore } from "@/store/appStore";
import { usePaneFileDrop } from "./usePaneFileDrop";

const panel: LeafPanel = {
  type: "leaf",
  id: "p",
  activeTabId: "t1",
  tabs: [
    {
      id: "t1",
      sessionId: "s1",
      title: "bash",
      connectionType: "local",
      contentType: "terminal",
      config: { type: "local", config: {} },
      panelId: "p",
      isActive: true,
    },
  ],
};

afterEach(() => useAppStore.setState(useAppStore.getInitialState()));

it("records the dropped paths as they are typed", async () => {
  const recordInput = vi.fn();
  useAppStore.setState({ recordInput });
  function Probe() {
    usePaneFileDrop(panel);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  await drop.paths!(["/tmp/a b", "/tmp/c"]);
  const text = vi.mocked(sendInputDetached).mock.calls[0][1];
  expect(text).toContain("/tmp/a b");
  expect(recordInput).toHaveBeenCalledWith("t1", text);
  await drop.paths!([]);
  expect(recordInput).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
