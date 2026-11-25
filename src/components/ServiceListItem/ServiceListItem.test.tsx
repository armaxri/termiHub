/**
 * The one row of a service (#6028): the same layout, words, order, keys and
 * accessible names for a tunnel and a file server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const { writeText, openUrl, toastError, toastSuccess } = vi.hoisted(() => ({
  writeText: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { ...actual.toast, error: toastError, success: toastSuccess } };
});

import { withTooltip } from "@/test/tooltip";
import type { EmbeddedServerConfig, ServerStatus } from "@/types/embeddedServer";
import type { TunnelConfig, TunnelStatus } from "@/types/tunnel";
import { fileServerModel, tunnelModel, type ServiceModel } from "@/utils/serviceModel";
import { ServiceListItem, type ServiceListItemProps } from "./ServiceListItem";

const CONTEXT = {
  agents: [{ id: "edge", name: "Edge box", config: {} as never }],
  connections: [],
};
const STATS = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };
const TUNNEL: TunnelConfig = {
  id: "t",
  name: "Shop database",
  sshConnectionId: "shop",
  autoStart: false,
  reconnectOnDisconnect: false,
  tunnelType: {
    type: "local",
    config: { localHost: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432 },
  },
};
const SERVER: EmbeddedServerConfig = {
  id: "s",
  name: "Docs",
  serverType: "http",
  rootDirectory: "/srv",
  bindHost: "127.0.0.1",
  port: 8080,
  autoStart: false,
  readOnly: true,
};

const tunnelIn = (status: TunnelStatus, over: Partial<TunnelConfig> = {}) =>
  tunnelModel(
    { ...TUNNEL, ...over },
    { tunnelId: "t", status, error: "why", stats: STATS },
    CONTEXT
  );
const serverIn = (status: ServerStatus, over: Partial<EmbeddedServerConfig> = {}) =>
  fileServerModel(
    { ...SERVER, ...over },
    { serverId: "s", status, error: "why", stats: STATS },
    CONTEXT
  );

let container: HTMLDivElement;
let root: Root;
const onAction = vi.fn<ServiceListItemProps["onAction"]>();

function render(model: ServiceModel, props: Partial<ServiceListItemProps> = {}) {
  act(() => {
    root.render(
      withTooltip(
        <ServiceListItem model={model} tooltip={["a", "b"]} onAction={onAction} {...props} />
      )
    );
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const rowOf = (model: ServiceModel) =>
  q(model.kind === "tunnel" ? "tunnel-item-t" : "server-item-s")!;
const flush = () => act(async () => void (await Promise.resolve()));

/** Every action the row shows, in the order it shows them. */
const onRow = () =>
  Array.from(container.querySelectorAll(".sidebar-list-item__more button")).map((b) =>
    b.getAttribute("aria-label")
  );

async function openMenu(model: ServiceModel): Promise<string[]> {
  act(() => {
    rowOf(model).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await flush();
  return Array.from(document.querySelectorAll("[role=menuitem]")).map((i) => i.textContent ?? "");
}

async function openMore(model: ServiceModel): Promise<string[]> {
  const more = q(`${model.kind === "tunnel" ? "tunnel" : "server"}-more-${model.id}`)!;
  act(() => {
    more.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })
    );
  });
  await flush();
  return Array.from(document.querySelectorAll("[role=menuitem]")).map((i) =>
    (i.textContent ?? "").trim()
  );
}

function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => void el.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  onAction.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("what the row says", () => {
  it.each([
    ["tunnel", tunnelIn("connected"), "Running · Reach something on the SSH server's side"],
    ["server", serverIn("running"), "Running · Open a folder in a browser"],
    [
      "server",
      serverIn("stopped", { host: { kind: "agent", agentId: "edge" } }),
      "Stopped · Open a folder in a browser · agent Edge box",
    ],
  ])("what and where, after the state in words (%s)", (kind, model, line) => {
    render(model);
    expect(q(`${kind}-kind-${model.id}`)?.textContent).toBe(line);
  });

  it("says the state once to a screen reader: the dot's name", () => {
    const model = serverIn("running");
    render(model);
    expect(q("server-status-s")?.getAttribute("aria-label")).toBe("Running");
    expect(container.querySelector(".service-row__state")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  it("never tells a state by colour alone", () => {
    for (const status of ["stopped", "waiting", "running", "error", "notReachable"] as const) {
      render(serverIn(status));
      const word = container.querySelector(".service-row__state")?.textContent;
      expect(word).toBeTruthy();
      expect(q("server-status-s")?.getAttribute("title")).toBe(word);
    }
  });

  it("the address with Copy only while it runs, else why not", () => {
    render(tunnelIn("connected"));
    expect(q("tunnel-address-t")?.textContent).toBe("localhost:5432");
    expect(q("tunnel-copy-address-t")?.getAttribute("aria-label")).toBe("Copy address");
    expect(q("tunnel-reason-t")).toBeNull();
    for (const status of ["waiting", "error", "notReachable", "stopping"] as const) {
      render(tunnelIn(status));
      expect(q("tunnel-address-t")).toBeNull();
      expect(q("tunnel-copy-address-t")).toBeNull();
      expect(q("tunnel-reason-t")?.textContent).toBe("why");
    }
  });

  it("the machine beside an address that opens elsewhere, which is not copied", async () => {
    render(serverIn("running", { host: { kind: "agent", agentId: "edge" } }));
    expect(q("server-address-s")?.textContent).toBe("http://localhost:8080 on Edge box");
    await act(async () => q("server-copy-address-s")!.click());
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("the next step of a deleted connection", () => {
    const onNextStep = vi.fn();
    render(tunnelIn("missingConnection"), { onNextStep });
    expect(q("tunnel-reason-t")?.textContent).toContain("Its SSH connection was deleted.");
    act(() => q("tunnel-choose-connection-t")!.click());
    expect(onNextStep).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("the user's description, the extras and the open activity", () => {
    render(tunnelModel({ ...TUNNEL, description: "Reaches the DB" }, undefined, CONTEXT), {
      extras: <i data-testid="extra" />,
      activity: <i data-testid="activity" />,
    });
    expect(q("tunnel-description-t")?.textContent).toBe("Reaches the DB");
    expect(q("extra")).not.toBeNull();
    expect(q("activity")).not.toBeNull();
    expect(rowOf(tunnelIn("connected")).getAttribute("aria-description")).toContain("a");
  });
});

describe("what the row offers", () => {
  it("the run control at rest, the rest on hover, all in the model's order", () => {
    render(tunnelIn("connected"));
    expect(q("tunnel-primary-t")?.querySelector("button")?.getAttribute("aria-label")).toBe("Stop");
    expect(onRow()).toEqual(["Edit", "More"]);
    render(serverIn("running"));
    expect(onRow()).toEqual(["Activity", "Edit", "More"]);
  });

  it.each([tunnelIn("connected"), serverIn("running"), serverIn("error"), tunnelIn("waiting")])(
    "both menus offer everything, in the same order and words (%#)",
    async (model) => {
      render(model);
      const words = model.actions.map((a) => a.label);
      expect((await openMenu(model)).map((text) => text.trim())).toEqual(words);
      press(document.querySelector<HTMLElement>("[role=menu]")!, "Escape");
      await flush();
      expect(await openMore(model)).toEqual(words);
    }
  );

  it("no run control where there is nothing to run", () => {
    render(tunnelIn("missingConnection"));
    expect(q("tunnel-primary-t")).toBeNull();
  });

  it("a button runs its action once, and does not select the row", async () => {
    const onClick = vi.fn();
    render(serverIn("running"), { rowProps: { onClick } });
    await act(async () => q("server-stop-s")!.click());
    expect(onAction.mock.calls).toEqual([["stop"]]);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens the address in a browser", async () => {
    render(serverIn("running"));
    await openMore(serverIn("running"));
    await act(async () => q("server-more-open-browser-s")!.click());
    await flush();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:8080");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("says that a copy failed", async () => {
    writeText.mockRejectedValueOnce(new Error("no clipboard"));
    render(serverIn("running"));
    await act(async () => q("server-copy-address-s")!.click());
    await flush();
    expect(toastError).toHaveBeenCalledWith("Failed to copy the address", {
      description: "no clipboard",
    });
  });

  it("says it was copied only from the menu, where nothing on screen changes", async () => {
    const model = serverIn("running");
    render(model);
    await openMenu(model);
    await act(async () => q("ctx-copy-url-s")!.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    expect(toastSuccess).toHaveBeenCalledOnce();
  });

  it("a rejected action from a key or the menu is not an unhandled rejection", async () => {
    onAction.mockRejectedValue(new Error("no"));
    const model = serverIn("stopped");
    render(model);
    press(rowOf(model), " ");
    await flush();
    expect(onAction).toHaveBeenCalledWith("start");
  });
});

describe("keys on the focused row", () => {
  it.each([
    [tunnelIn("disconnected"), " ", "start"],
    [tunnelIn("connected"), " ", "stop"],
    [serverIn("waiting"), " ", "stopWaiting"],
    [serverIn("error"), " ", "retry"],
    [tunnelIn("connected"), "Delete", "delete"],
    [serverIn("stopped"), "Delete", "delete"],
  ])("%#: %s does %s", (model, key, action) => {
    const list = vi.fn();
    render(model, { rowProps: { onKeyDown: list } });
    const event = press(rowOf(model), key as string);
    expect(onAction.mock.calls).toEqual([[action]]);
    expect(event.defaultPrevented).toBe(true);
    // The list's type-ahead does not get it too.
    expect(list).not.toHaveBeenCalled();
  });

  it("leaves Enter and the arrows to the list, and modified keys alone", () => {
    const list = vi.fn();
    const model = tunnelIn("connected");
    render(model, { rowProps: { onKeyDown: list } });
    press(rowOf(model), "Enter");
    press(rowOf(model), "ArrowDown");
    press(rowOf(model), " ", { ctrlKey: true });
    press(rowOf(model), "Delete", { metaKey: true });
    expect(list).toHaveBeenCalledTimes(4);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("holding Space does not start and stop in turns", () => {
    const model = tunnelIn("disconnected");
    render(model);
    press(rowOf(model), " ");
    press(rowOf(model), " ", { repeat: true });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it.each([" ", "Enter", "Delete", "x"])("%j on a button inside is the button's", (key) => {
    const list = vi.fn();
    const model = tunnelIn("connected");
    act(() => {
      root.render(
        withTooltip(
          <div onKeyDown={list}>
            <ServiceListItem model={model} tooltip={[]} onAction={onAction} />
          </div>
        )
      );
    });
    const event = press(q("tunnel-edit-t")!, key);
    expect(onAction).not.toHaveBeenCalled();
    // The list would take Enter, edit, and keep the button from being pressed.
    expect(list).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("the arrows on a button inside move in the list", () => {
    const list = vi.fn();
    const model = tunnelIn("connected");
    act(() => {
      root.render(
        withTooltip(
          <div onKeyDown={list}>
            <ServiceListItem model={model} tooltip={[]} onAction={onAction} />
          </div>
        )
      );
    });
    press(q("tunnel-edit-t")!, "ArrowDown");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("the keys of an open menu stay in it", async () => {
    const list = vi.fn();
    const model = tunnelIn("connected");
    act(() => {
      root.render(
        withTooltip(
          <div onKeyDown={list}>
            <ServiceListItem model={model} tooltip={[]} onAction={onAction} />
          </div>
        )
      );
    });
    await openMore(model);
    press(document.querySelector<HTMLElement>("[role=menu]")!, "ArrowDown");
    await openMenu(model);
    for (const menu of Array.from(document.querySelectorAll<HTMLElement>("[role=menu]")))
      press(menu, "ArrowDown");
    expect(list).not.toHaveBeenCalled();
  });

  it("announces them, and only those that act", () => {
    render(tunnelIn("connected"));
    expect(rowOf(tunnelIn("connected")).getAttribute("aria-keyshortcuts")).toBe(
      "Space Enter Delete"
    );
    render(tunnelIn("missingConnection"));
    expect(rowOf(tunnelIn("connected")).getAttribute("aria-keyshortcuts")).toBe("Enter Delete");
  });

  it("a double click edits", () => {
    const model = serverIn("stopped");
    render(model);
    act(() => {
      rowOf(model).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onAction).toHaveBeenCalledWith("edit");
  });
});
