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
    ["tunnel", tunnelIn("connected"), "Running · Reach db through the SSH server"],
    ["server", serverIn("running"), "Running · Open a folder in a browser"],
    [
      "server",
      serverIn("stopped", { host: { kind: "agent", agentId: "edge" } }),
      "Stopped · Open a folder in a browser",
    ],
  ])("what it is, after the state in words (%s)", (kind, model, line) => {
    render(model);
    expect(q(`${kind}-kind-${model.id}`)?.textContent).toBe(line);
  });

  it("the technical name, running or not", () => {
    render(serverIn("stopped"));
    expect(q("server-technical-s")?.textContent).toBe("HTTP");
    render(tunnelIn("connected"));
    expect(q("tunnel-technical-t")?.textContent).toBe("Local");
  });

  it("the machine in one place, and only when it is another one", () => {
    const edge = { kind: "agent", agentId: "edge" } as const;
    for (const status of ["stopped", "running", "notReachable"] as const) {
      render(serverIn(status, { host: edge }));
      expect(q("server-machine-s")?.textContent).toBe("Edge box");
      expect(rowOf(serverIn(status)).textContent!.split("Edge box")).toHaveLength(2);
    }
    render(serverIn("running"));
    expect(q("server-machine-s")).toBeNull();
  });

  it("keeps the end of a long machine's name, and all of it for a screen reader", () => {
    const tailOf = (machine: string) => {
      render({ ...serverIn("stopped"), machine });
      const chip = q("server-machine-s")!;
      expect(chip.textContent).toBe(machine);
      return chip.querySelector(".middle-ellipsis__tail")?.textContent;
    };
    // Not cut inside a word (#6076), when there are words.
    expect(tailOf("Edge gateway in the Frankfurt rack")).toBe(" Frankfurt rack");
    expect(tailOf("Edge gateway, Frankfurt datacenter rack")).toBe(" datacenter rack");
    expect(tailOf("edge-gateway-frankfurt-rack")).toBe("urt-rack");
    expect(tailOf("edge gateway-frankfurt-rack")).toBe("urt-rack");
    // A last word too short to tell two machines apart.
    expect(tailOf("edge-gateway-frankfurt rack")).toBe("urt rack");
    expect(tailOf("Edge box")).toBeUndefined();
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
    expect(q("tunnel-address-t")?.textContent).toBe("localhost:5432only this computer");
    expect(q("tunnel-copy-address-t")?.getAttribute("aria-label")).toBe("Copy address");
    expect(q("tunnel-reason-t")).toBeNull();
    for (const status of ["waiting", "error", "notReachable", "stopping"] as const) {
      render(tunnelIn(status));
      expect(q("tunnel-address-t")).toBeNull();
      expect(q("tunnel-copy-address-t")).toBeNull();
      expect(q("tunnel-reason-t")?.textContent).toBe("why");
    }
  });

  it("who reaches it, and says so when a copied address works only there", async () => {
    render(serverIn("running", { host: { kind: "agent", agentId: "edge" } }));
    expect(q("server-address-s")?.textContent).toBe("http://localhost:8080only on that machine");
    await act(async () => q("server-copy-address-s")!.click());
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    const warned = ["Copied. Works only on Edge box"];
    expect(toastSuccess.mock.calls).toEqual([warned]);
    // From the menu, too, and nothing more.
    await openMenu(serverIn("running"));
    await act(async () => q("ctx-copy-url-s")!.click());
    await flush();
    expect(toastSuccess.mock.calls).toEqual([warned, warned]);
  });

  it("no address, and nothing to copy, while nobody knows it", async () => {
    const model = serverIn("running", { bindHost: "0.0.0.0" });
    render(model);
    expect(q("server-address-s")?.textContent).toContain(
      "This computer has no network address now; it appears here once you are connected. Port 8080."
    );
    expect(q("server-copy-address-s")).toBeNull();
    expect(await openMenu(model)).not.toContain(" Copy address");
  });

  it("that anyone may upload", () => {
    render({ ...serverIn("running"), risk: "Anyone on your network can upload" });
    expect(q("server-risk-s")?.textContent).toBe("Anyone on your network can upload");
    // It says who reaches it, so nothing else does.
    expect(q("server-address-s")?.textContent).toBe("http://localhost:8080");
    // Without an address, why there is none is said, too.
    const open = serverIn("running", { bindHost: "0.0.0.0" });
    render({ ...open, risk: "Anyone on your network can upload" });
    expect(q("server-address-s")?.textContent).toContain("no network address now");
    expect(q("server-risk-s")).not.toBeNull();
    render(serverIn("running"));
    expect(q("server-risk-s")).toBeNull();
  });

  it("the remedies beside the reason, each a button", () => {
    const onNextStep = vi.fn();
    const model = serverIn("error");
    const nextSteps = [
      { id: "usePort" as const, label: "Use 8081", port: 8081 },
      { id: "edit" as const, label: "Edit" },
    ];
    render({ ...model, nextSteps }, { onNextStep });
    expect(q("server-reason-s")?.textContent).toBe("why Use 8081 · Edit");
    act(() => q("server-use-port-s")!.click());
    act(() => q("server-edit-port-s")!.click());
    expect(onNextStep.mock.calls.map(([step]) => step)).toEqual(nextSteps);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("a remedy that fails is not an unhandled rejection, and does not select the row", async () => {
    const onClick = vi.fn();
    render(tunnelIn("missingConnection"), {
      onNextStep: () => Promise.reject(new Error("no")),
      rowProps: { onClick },
    });
    expect(q("tunnel-reason-t")?.textContent).toContain("Its SSH connection was deleted.");
    act(() => q("tunnel-choose-connection-t")!.click());
    await flush();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("the icons: a filled square stops; giving up what has not started is a word", () => {
    const button = (model: ServiceModel) => {
      render(model);
      return q("server-primary-s")!.querySelector("button")!;
    };
    const icon = (model: ServiceModel) => {
      const svg = button(model).querySelector("svg")!;
      return `${svg.getAttribute("class")?.match(/lucide-(square|play|rotate-cw)/)?.[1]} ${svg.getAttribute("fill")}`;
    };
    expect(icon(serverIn("running"))).toBe("square currentColor");
    expect(icon(serverIn("notReachable"))).toBe("square currentColor");
    expect(icon(serverIn("stopped"))).toBe("play currentColor");
    expect(icon(serverIn("error"))).toBe("rotate-cw none");
    for (const [status, label] of [
      ["starting", "Cancel start"],
      ["waiting", "Cancel waiting"],
    ] as const) {
      const cancel = button(serverIn(status));
      expect(cancel.textContent).toBe("Cancel");
      expect(cancel.querySelector("svg")).toBeNull();
      expect(cancel.getAttribute("aria-label")).toBe(label);
    }
  });

  it("only Copy flashes: a Stop may only have asked", async () => {
    render(serverIn("running"));
    await act(async () => q("server-stop-s")!.click());
    expect(q("server-stop-s")!.className).not.toContain("success");
    await act(async () => q("server-copy-address-s")!.click());
    expect(q("server-copy-address-s")!.className).toContain("success");
  });

  it("the user's description and the extras", () => {
    render(tunnelModel({ ...TUNNEL, description: "Reaches the DB" }, undefined, CONTEXT), {
      extras: <i data-testid="extra" />,
    });
    expect(q("tunnel-description-t")?.textContent).toBe("Reaches the DB");
    // In the place of what its type is for, after the state.
    expect(q("tunnel-kind-t")?.textContent).toBe("Stopped · Reaches the DB");
    expect(q("extra")).not.toBeNull();
    expect(rowOf(tunnelIn("connected")).getAttribute("aria-description")).toContain("a");
  });
});

describe("what the row offers", () => {
  it("the run control at rest, the rest on hover, all in the model's order", () => {
    render(tunnelIn("connected"));
    expect(q("tunnel-primary-t")?.querySelector("button")?.getAttribute("aria-label")).toBe("Stop");
    expect(onRow()).toEqual(["Activity", "Edit", "More"]);
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
    // Nor does the menu say that it was copied.
    writeText.mockRejectedValueOnce(new Error("no clipboard"));
    await openMenu(serverIn("running"));
    await act(async () => q("ctx-copy-url-s")!.click());
    await flush();
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastSuccess).not.toHaveBeenCalled();
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
