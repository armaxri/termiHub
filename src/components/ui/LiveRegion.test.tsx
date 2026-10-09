import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LiveRegion } from "./LiveRegion";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function region(): HTMLElement {
  return container.querySelector("[data-testid='live']") as HTMLElement;
}

/** Wait one macrotask so a MutationObserver callback (a microtask) has run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("LiveRegion (#4331)", () => {
  it("renders a polite status region by default", () => {
    act(() => root.render(<LiveRegion message="Session ended" data-testid="live" />));
    expect(region().getAttribute("role")).toBe("status");
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(region().getAttribute("aria-atomic")).toBe("true");
    expect(region().textContent).toBe("Session ended");
  });

  it("renders an assertive alert region when asked", () => {
    act(() =>
      root.render(
        <LiveRegion message="Connection failed" politeness="assertive" data-testid="live" />
      )
    );
    expect(region().getAttribute("role")).toBe("alert");
    expect(region().getAttribute("aria-live")).toBe("assertive");
    expect(region().textContent).toBe("Connection failed");
  });

  it("is visually hidden but kept in the accessibility tree", () => {
    act(() => root.render(<LiveRegion message="x" data-testid="live" />));
    expect(region().className).toContain("ui-visually-hidden");
    expect(region().getAttribute("aria-hidden")).toBeNull();
  });

  it("mounts empty and fills afterwards, so the region exists before its text changes", () => {
    const observer = new MutationObserver(() => undefined);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    act(() => root.render(<LiveRegion message="Reconnect failed" data-testid="live" />));
    const records = observer.takeRecords();
    observer.disconnect();
    // Had the region mounted together with its text, React would have built it
    // detached and no mutation would target the region itself. A childList
    // record on the region proves the text arrived after the region was live.
    expect(region().textContent).toBe("Reconnect failed");
    const textAdds = records.filter(
      (r) => r.target === region() && r.type === "childList" && r.addedNodes.length > 0
    );
    expect(textAdds.length).toBeGreaterThan(0);
  });

  it("does not re-announce when re-rendered with the same message", async () => {
    act(() => root.render(<LiveRegion message="Session lost" data-testid="live" />));
    await settle();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => mutations.push(...recs));
    observer.observe(region(), { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 5; i++) {
      act(() => root.render(<LiveRegion message="Session lost" data-testid="live" />));
    }
    await settle();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
    expect(region().textContent).toBe("Session lost");
  });

  it("updates its text when the message changes", () => {
    act(() => root.render(<LiveRegion message="Session ended" data-testid="live" />));
    act(() => root.render(<LiveRegion message="Reconnect failed" data-testid="live" />));
    expect(region().textContent).toBe("Reconnect failed");
  });
});
