/**
 * TabConnectionIcon (#5008): a tab opened from a saved connection shows that
 * connection's emoji / colour, live-updates when the connection is edited,
 * and falls back to the type icon for tabs without a saved connection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabConnectionIcon } from "./TabConnectionIcon";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import type { SavedConnection } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";

setupConnectionsRegion();

const config: ConnectionConfig = { type: "ssh", config: { host: "prod" } };
const prod = (patch: Partial<SavedConnection>): SavedConnection => ({
  id: "prod",
  name: "Prod",
  config,
  folderId: null,
  ...patch,
});

let container: HTMLDivElement;
let root: Root;

const emoji = () => container.querySelector('[data-testid="connection-icon-emoji"]');

describe("TabConnectionIcon", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the saved connection's emoji and follows edits live", () => {
    act(() => seedConnectionsRegion({ connections: [prod({ iconEmoji: "🔥" })] }));
    act(() => root.render(<TabConnectionIcon tab={{ config, connectionId: "prod" }} />));
    expect(emoji()?.textContent).toBe("🔥");

    act(() => seedConnectionsRegion({ connections: [prod({ iconEmoji: "🚀" })] }));
    expect(emoji()?.textContent).toBe("🚀");

    act(() => seedConnectionsRegion({ connections: [prod({ iconColor: "red" })] }));
    expect(emoji()).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("data-icon-color")).toBe("red");
  });

  it("falls back to the type icon without a saved connection", () => {
    act(() => root.render(<TabConnectionIcon tab={{ config }} />));
    expect(emoji()).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
