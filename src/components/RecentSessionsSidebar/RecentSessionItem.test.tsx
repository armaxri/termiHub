import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { RecentSessionItem } from "./RecentSessionItem";
import { withTooltip } from "@/test/tooltip";
import type { SessionHistoryEntry } from "@/types/sessionHistory";

const KEY = "ssh:admin@prod:22";

function entry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    dedupKey: KEY,
    title: "admin@prod",
    connectionType: "ssh",
    config: { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
    firstUsed: 0,
    lastUsed: Date.now(),
    useCount: 1,
    pinned: false,
    promoted: false,
    ...overrides,
  };
}

function handlers() {
  return {
    onConnect: vi.fn(),
    onConnectInNewPanel: vi.fn(),
    onTogglePin: vi.fn(),
    onSaveAsConnection: vi.fn(),
    onCopyString: vi.fn(),
    onRemove: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(e: SessionHistoryEntry, h = handlers()) {
  act(() => {
    root.render(withTooltip(<RecentSessionItem entry={e} {...h} />));
  });
  return h;
}

describe("RecentSessionItem", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the title and an uppercased type badge", () => {
    render(entry());
    expect(query(`recent-session-name-${KEY}`)?.textContent).toBe("admin@prod");
    expect(query(`recent-session-type-${KEY}`)?.textContent).toBe("SSH");
  });

  it("shows the use-count only when connected more than once", () => {
    render(entry({ useCount: 4 }));
    expect(query(`recent-session-meta-${KEY}`)?.textContent).toContain("4×");
  });

  it("omits the use-count for a single connection", () => {
    render(entry({ useCount: 1 }));
    expect(query(`recent-session-meta-${KEY}`)?.textContent).not.toContain("×");
  });

  it("labels the pin action Unpin and shows a saved marker for a promoted, pinned entry", () => {
    render(entry({ pinned: true, promoted: true }));
    expect(query(`recent-session-pin-${KEY}`)?.getAttribute("aria-label")).toBe("Unpin");
    expect(query(`recent-session-meta-${KEY}`)?.textContent).toContain("Saved");
  });

  it("labels the pin action Pin to top for an unpinned entry", () => {
    render(entry({ pinned: false }));
    expect(query(`recent-session-pin-${KEY}`)?.getAttribute("aria-label")).toBe("Pin to top");
  });

  it("connects (with the entry) via the inline action and on row double-click", () => {
    const h = render(entry());
    act(() => query(`recent-session-connect-${KEY}`)?.click());
    expect(h.onConnect).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: KEY }));

    h.onConnect.mockClear();
    act(() => {
      query(`recent-session-${KEY}`)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(h.onConnect).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: KEY }));
  });

  it("wires the pin and remove inline actions to their handlers", () => {
    const h = render(entry());
    act(() => query(`recent-session-pin-${KEY}`)?.click());
    expect(h.onTogglePin).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: KEY }));
    act(() => query(`recent-session-remove-${KEY}`)?.click());
    expect(h.onRemove).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: KEY }));
  });
});
