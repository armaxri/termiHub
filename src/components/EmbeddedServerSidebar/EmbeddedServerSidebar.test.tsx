/**
 * Feedback tests for embedded-server save & duplicate (#1342).
 *
 * `saveEmbeddedServer` used to swallow failures to `console.error` while the
 * dialog closed as if the save had worked. These tests pin that:
 *  - a successful save surfaces a success toast and closes the dialog,
 *  - a failing save surfaces an error toast and keeps the dialog open,
 *  - duplicate confirms success / surfaces failure via toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { EmbeddedServerConfig } from "@/types/embeddedServer";
import { TooltipProvider } from "@/components/ui";
import { EmbeddedServerSidebar } from "./EmbeddedServerSidebar";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

// Network-interface enumeration used by the dialog is not available in jsdom.
vi.mock("@/services/embeddedServerApi", () => ({
  listNetworkInterfaces: vi.fn(() => Promise.resolve([{ name: "Loopback", addr: "127.0.0.1" }])),
}));

vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

function makeServer(id: string, name: string): EmbeddedServerConfig {
  return {
    id,
    name,
    serverType: "http",
    rootDirectory: "/tmp",
    bindHost: "127.0.0.1",
    port: 8080,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore(
  saveEmbeddedServer: (config: EmbeddedServerConfig) => Promise<void>,
  servers: EmbeddedServerConfig[] = []
) {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    embeddedServers: servers,
    embeddedServerStates: {},
    saveEmbeddedServer,
    deleteEmbeddedServer: vi.fn(),
    startEmbeddedServer: vi.fn(),
    stopEmbeddedServer: vi.fn(),
  });
}

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <EmbeddedServerSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

async function openNewDialogAndFill() {
  const newBtn = container.querySelector<HTMLButtonElement>('[data-testid="server-new-btn"]');
  await act(async () => {
    newBtn!.click();
  });
  await flush();

  const nameInput = document.querySelector<HTMLInputElement>('[data-testid="server-dialog-name"]');
  const rootInput = document.querySelector<HTMLInputElement>('[data-testid="server-dialog-root"]');
  setInputValue(nameInput!, "New Share");
  setInputValue(rootInput!, "/srv/share");
  await flush();
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickDialogSave() {
  const saveBtn = document.querySelector<HTMLButtonElement>('[data-testid="server-dialog-save"]');
  await act(async () => {
    saveBtn!.click();
  });
  await flush();
}

describe("EmbeddedServerSidebar — save & duplicate feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a success toast and closes the dialog when save succeeds", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(saveEmbeddedServer);
    await renderSidebar();
    await openNewDialogAndFill();
    await clickDialogSave();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    // Dialog closed.
    expect(document.querySelector('[data-testid="server-dialog-save"]')).toBeNull();
  });

  it("shows an error toast and keeps the dialog open when save fails", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.reject(new Error("port in use")));
    seedStore(saveEmbeddedServer);
    await renderSidebar();
    await openNewDialogAndFill();
    await clickDialogSave();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    // Dialog stays open so the user can retry.
    expect(document.querySelector('[data-testid="server-dialog-save"]')).not.toBeNull();
  });

  it("shows a success toast when duplication succeeds", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.resolve());
    seedStore(saveEmbeddedServer, [makeServer("srv-1", "Original")]);
    await renderSidebar();

    const dupBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-duplicate-srv-1"]'
    );
    await act(async () => {
      dupBtn!.click();
    });
    await flush();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when duplication fails", async () => {
    const saveEmbeddedServer = vi.fn(() => Promise.reject(new Error("disk full")));
    seedStore(saveEmbeddedServer, [makeServer("srv-1", "Original")]);
    await renderSidebar();

    const dupBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="server-duplicate-srv-1"]'
    );
    await act(async () => {
      dupBtn!.click();
    });
    await flush();

    expect(saveEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
