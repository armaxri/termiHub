/**
 * Regression tests for #4577: the listener sites moved off the raw
 * `listen(...).then((fn) => fn())` cleanup onto `subscribeGuarded` /
 * `useTauriSubscription` must
 *
 * - unlisten a listener whose registration resolves only after unmount, and
 * - log a rejected registration instead of leaving an unhandled rejection.
 *
 * Every mocked registration is controlled by the test: it either stays pending
 * until resolved, or rejects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Pending = { resolve: () => void; unlisten: ReturnType<typeof vi.fn> };
const pending: Pending[] = [];
let rejectRegistrations = false;

/** A registration that resolves only when the test says so, or rejects in reject mode. */
function registration(): Promise<() => void> {
  if (rejectRegistrations) return Promise.reject(new Error("event bridge unavailable"));
  const unlisten = vi.fn();
  return new Promise((resolve) => {
    pending.push({ resolve: () => resolve(unlisten), unlisten });
  });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => registration()),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onFocusChanged: vi.fn(() => registration()),
  }),
}));

vi.mock("@/services/events", () => ({
  onPluginsChanged: vi.fn(() => registration()),
  onTransferProgress: vi.fn(() => registration()),
  onSessionOwnershipChanged: vi.fn(() => registration()),
  onLogEntry: vi.fn(() => registration()),
}));

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWindows: vi.fn(() => Promise.resolve([])),
  getLogs: vi.fn(() => Promise.resolve([])),
  clearLogs: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  frontendLog: vi.fn(),
}));

import { frontendLog } from "@/utils/frontendLog";
import { useAppStore } from "@/store/appStore";
import { useWindowInfo } from "./useWindowInfo";
import { useMonitorLayoutRefresh } from "./useMonitorLayoutRefresh";
import { usePluginEvents } from "./usePluginEvents";
import { useTransferEvents } from "./useTransferEvents";
import { LogViewer } from "@/components/LogViewer/LogViewer";

function hookHost(useHook: () => void): React.FC {
  return function Host() {
    useHook();
    return null;
  };
}

const cases: Array<[string, React.FC]> = [
  ["useWindowInfo", hookHost(useWindowInfo)],
  ["useMonitorLayoutRefresh", hookHost(() => void useMonitorLayoutRefresh("s1", true, null))],
  ["usePluginEvents", hookHost(usePluginEvents)],
  ["useTransferEvents", hookHost(useTransferEvents)],
  ["LogViewer", LogViewer],
];

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("migrated Tauri listener sites (#4577)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pending.length = 0;
    rejectRegistrations = false;
    useAppStore.setState({
      loadPlugins: vi.fn(() => Promise.resolve()),
      refreshConnectionTypes: vi.fn(() => Promise.resolve()),
      refreshSessionOwners: vi.fn(() => Promise.resolve()),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it.each(cases)(
    "%s unregisters every listener whose registration resolves after unmount",
    async (_name, Component) => {
      act(() => root.render(<Component />));
      act(() => root.unmount());
      expect(pending.length).toBeGreaterThan(0);
      for (const p of pending) expect(p.unlisten).not.toHaveBeenCalled();
      pending.forEach((p) => p.resolve());
      await flush();
      for (const p of pending) expect(p.unlisten).toHaveBeenCalledTimes(1);
    }
  );

  it.each(cases)("%s unregisters on unmount after registration resolved", async (_n, Component) => {
    act(() => root.render(<Component />));
    pending.forEach((p) => p.resolve());
    await flush();
    act(() => root.unmount());
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) expect(p.unlisten).toHaveBeenCalledTimes(1);
  });

  it.each(cases)("%s logs a rejected registration", async (_name, Component) => {
    rejectRegistrations = true;
    act(() => root.render(<Component />));
    await flush();
    const failures = vi
      .mocked(frontendLog)
      .mock.calls.filter(([, message]) => String(message).startsWith("Failed to subscribe"));
    expect(failures.length).toBeGreaterThan(0);
    for (const [, message] of failures) expect(message).toContain("event bridge unavailable");
    act(() => root.unmount());
  });
});
