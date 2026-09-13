import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { JumpHostEntry } from "./JumpHostEntry";
import type { JumpHostConfig } from "@/types/connection";
import type { SavedConnectionOption } from "@/utils/jumpHost";

function hop(overrides: Partial<JumpHostConfig> = {}): JumpHostConfig {
  return {
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    ...overrides,
  };
}

const SAVED: SavedConnectionOption[] = [
  { id: "conn-a", label: "Prod / bastion" },
  { id: "conn-b", label: "Staging / jump" },
];

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

interface RenderOpts {
  hop: JumpHostConfig;
  saved?: SavedConnectionOption[];
}

function render({ hop: h, saved = SAVED }: RenderOpts, onChange = vi.fn()) {
  act(() => {
    root.render(
      // fields=[] keeps the inline branch free of the shared schema-driven
      // DynamicField, isolating this test to JumpHostEntry's own source/mode logic.
      <JumpHostEntry hop={h} index={0} fields={[]} onChange={onChange} savedConnections={saved} />
    );
  });
  return onChange;
}

describe("JumpHostEntry", () => {
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

  it("starts in inline mode when the hop has no connectionId", () => {
    render({ hop: hop() });
    expect(query("jump-host-source-inline-0")?.getAttribute("aria-checked")).toBe("true");
    expect(query("jump-host-source-saved-0")?.getAttribute("aria-checked")).toBe("false");
    // No saved-connection dropdown while inline.
    expect(query("jump-host-connection-0")).toBeNull();
  });

  it("renders the saved-connection dropdown in saved mode", () => {
    render({ hop: hop({ connectionId: "conn-a" }) });
    expect(query("jump-host-source-saved-0")?.getAttribute("aria-checked")).toBe("true");
    expect(query("jump-host-source-inline-0")?.getAttribute("aria-checked")).toBe("false");
    expect(query("jump-host-connection-0")).not.toBeNull();
  });

  it("disables the Saved-connection option when no SSH connections exist", () => {
    render({ hop: hop(), saved: [] });
    expect((query("jump-host-source-saved-0") as HTMLButtonElement).disabled).toBe(true);
    // The inline option is always selectable.
    expect((query("jump-host-source-inline-0") as HTMLButtonElement).disabled).toBe(false);
  });

  it("switching to saved defaults to the first connection and clears inline fields", () => {
    const onChange = render({ hop: hop({ host: "old", username: "u" }) });
    act(() => query("jump-host-source-saved-0")?.click());
    expect(onChange).toHaveBeenCalledWith({ connectionId: "conn-a", host: "", username: "" });
  });

  it("switching to inline clears the connectionId reference", () => {
    const onChange = render({ hop: hop({ connectionId: "conn-a" }) });
    act(() => query("jump-host-source-inline-0")?.click());
    expect(onChange).toHaveBeenCalledWith({ connectionId: undefined });
  });

  it("clicking the already-active source is a no-op", () => {
    const onChange = render({ hop: hop({ connectionId: "conn-a" }) });
    act(() => query("jump-host-source-saved-0")?.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
