/**
 * The Saved header's one "New ▾" menu (#5848, R-022/R-096): a labelled
 * trigger whose entries name what they create, in place of three bare icons.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { withTooltip } from "@/test/tooltip";
import { openConnectionsNewMenu, pickConnectionsNewMenuItem } from "@/test/connectionsNewMenu";
import { ConnectionsNewMenu } from "./ConnectionsNewMenu";

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

function render() {
  const handlers = { onNewConnection: vi.fn(), onNewFolder: vi.fn(), onImport: vi.fn() };
  act(() => root.render(withTooltip(<ConnectionsNewMenu {...handlers} />)));
  return handlers;
}

describe("ConnectionsNewMenu (#5848)", () => {
  it("shows one labelled 'New' trigger", () => {
    render();
    const trigger = container.querySelector('[data-testid="connection-list-new-menu"]');
    expect(trigger?.textContent).toBe("New");
    expect(trigger?.getAttribute("aria-label")).toBe("New");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("lists text entries for connection, folder and import", async () => {
    render();
    await openConnectionsNewMenu();
    const rows = Array.from(document.querySelectorAll('[role="menuitem"]'), (el) => [
      el.getAttribute("data-testid"),
      el.textContent,
    ]);
    expect(rows).toEqual([
      ["connection-list-new-connection", "New connection"],
      ["connection-list-new-folder", "New folder"],
      ["connection-list-open-import-settings", "Import connections…"],
    ]);
  });

  it("runs each entry's action", async () => {
    const handlers = render();
    await pickConnectionsNewMenuItem("connection-list-new-connection");
    expect(handlers.onNewConnection).toHaveBeenCalledTimes(1);
    await pickConnectionsNewMenuItem("connection-list-open-import-settings");
    expect(handlers.onImport).toHaveBeenCalledTimes(1);
  });

  it("opens the folder input only once the menu has closed", async () => {
    const handlers = render();
    await pickConnectionsNewMenuItem("connection-list-new-folder");
    expect(handlers.onNewFolder).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="connection-list-new-menu-content"]')).toBeNull();
  });
});
