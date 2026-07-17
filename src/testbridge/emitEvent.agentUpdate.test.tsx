/**
 * Smoke test for the `emitEvent` bridge verb (#1545).
 *
 * Proves the whole injection chain the verb exists to enable: a bridge
 * `emitEvent` command → the Tauri event bus → the app's `listen` subscription
 * (`useAgentUpdateEvents`) → the `agentUpdates` store slice → the rendered
 * `AgentUpdateBanner`. Before this verb the dispatcher was DOM-only, so a system
 * test had no way to make a backend-originated event fire and the banner was
 * unreachable (#1520).
 *
 * The Tauri event module is replaced with an in-memory bus so the same
 * `emit`/`listen` pair the live app uses is exercised without a backend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentUpdateBanner } from "@/components/AgentUpdateBanner";
import { useAgentUpdateEvents } from "@/hooks/useAgentUpdateEvents";
import { useAppStore } from "@/store/appStore";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";

/** Handlers registered via the mocked `listen`, keyed by event name. */
const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();

// An in-memory stand-in for the Tauri event bus: `emit` synchronously delivers
// to every handler `listen` registered for that name, mirroring the real
// round-trip (webview emit → backend → all webview listeners) closely enough to
// prove the chain end to end.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }),
  emit: vi.fn(async (event: string, payload?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  }),
}));

const AGENT_ID = "agent-1";

/** Mounts the listener hook alongside the banner it feeds. */
function Harness() {
  useAgentUpdateEvents();
  return <AgentUpdateBanner agentId={AGENT_ID} agentName="Build Box" />;
}

let container: HTMLDivElement;
let root: Root;

/** Deps wired to the mocked bus, exactly as {@link TestBridge} wires the real one. */
async function makeDeps(): Promise<BridgeDeps> {
  const { emit } = await import("@tauri-apps/api/event");
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "",
    emitEvent: (event, payload) => emit(event, payload),
  };
}

beforeEach(() => {
  handlers.clear();
  useAppStore.setState({ agentUpdates: {}, agentUpdatesDismissed: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("emitEvent verb → agent-update-available → banner", () => {
  it("surfaces the deferred-update banner from an injected Tauri event", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    // Nothing has fired yet, so the banner must be absent.
    expect(container.querySelector(`[data-testid="agent-update-banner-${AGENT_ID}"]`)).toBeNull();

    const deps = await makeDeps();
    await act(async () => {
      const res = await dispatchCommand(
        {
          action: "emitEvent",
          event: "agent-update-available",
          payload: {
            agent_id: AGENT_ID,
            currentVersion: "0.1.0",
            availableVersion: "0.2.0",
            staged: true,
          },
        },
        deps
      );
      expect(res).toEqual({ ok: true, action: "emitEvent" });
    });

    const banner = container.querySelector(`[data-testid="agent-update-banner-${AGENT_ID}"]`);
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Build Box");
    expect(banner?.textContent).toContain("0.2.0");

    // The event reached the store through the real listener, not a direct write.
    expect(useAppStore.getState().agentUpdates[AGENT_ID]).toEqual({
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      staged: true,
    });
  });

  it("leaves the banner hidden for an unstaged update", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    const deps = await makeDeps();
    await act(async () => {
      await dispatchCommand(
        {
          action: "emitEvent",
          event: "agent-update-available",
          payload: {
            agent_id: AGENT_ID,
            currentVersion: "0.1.0",
            availableVersion: "0.2.0",
            staged: false,
          },
        },
        deps
      );
    });

    expect(container.querySelector(`[data-testid="agent-update-banner-${AGENT_ID}"]`)).toBeNull();
  });
});
