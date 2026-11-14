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

  const tooltip = () => query(`recent-session-${KEY}`)?.getAttribute("aria-description") ?? "";

  it("renders the title only; the type and last use are in the tooltip (#5770)", () => {
    render(entry());
    expect(query(`recent-session-name-${KEY}`)?.textContent).toBe("admin@prod");
    expect(query(`recent-session-type-${KEY}`)).toBeNull();
    expect(query(`recent-session-meta-${KEY}`)).toBeNull();
    expect(tooltip()).toMatch(/^SSH\. Last used /);
  });

  it("puts the use-count in the tooltip only when connected more than once", () => {
    render(entry({ useCount: 4 }));
    expect(tooltip()).toContain("Used 4 times");
    expect(query(`recent-session-${KEY}`)?.textContent).not.toContain("4");
  });

  it("omits the use-count for a single connection", () => {
    render(entry({ useCount: 1 }));
    expect(tooltip()).not.toContain("Used");
  });

  it("marks a pinned entry and puts its saved state in the tooltip", () => {
    render(entry({ pinned: true, promoted: true }));
    expect(query(`recent-session-pin-${KEY}`)?.getAttribute("aria-label")).toBe("Unpin");
    expect(query(`recent-session-meta-${KEY}`)?.textContent).toBe("Pinned");
    expect(query(`recent-session-${KEY}`)?.textContent).not.toContain("Saved");
    expect(tooltip()).toContain("Saved as a connection");
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
