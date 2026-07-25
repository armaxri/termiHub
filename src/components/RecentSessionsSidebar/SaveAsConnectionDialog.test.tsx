import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SaveAsConnectionDialog } from "./SaveAsConnectionDialog";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { CredentialStoreStatusInfo } from "@/types/credential";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

const { storeCredentialMock } = vi.hoisted(() => ({ storeCredentialMock: vi.fn() }));
vi.mock("@/services/api", () => ({ storeCredential: storeCredentialMock }));

const { credStatus } = vi.hoisted(() => ({
  credStatus: { value: null as CredentialStoreStatusInfo | null },
}));
vi.mock("@/store/appStore", () => ({
  useAppStore: (
    selector: (s: { credentialStoreStatus: CredentialStoreStatusInfo | null }) => unknown
  ) => selector({ credentialStoreStatus: credStatus.value }),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Set a controlled input's value the way the DOM would on user typing. */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const entry: SessionHistoryEntry = {
  dedupKey: "ssh:admin@prod:22",
  title: "admin@prod",
  connectionType: "ssh",
  config: { type: "ssh", config: { host: "prod", username: "admin", port: 22 } },
  firstUsed: 1,
  lastUsed: 2,
  useCount: 1,
  pinned: false,
  promoted: false,
};

const folders: ConnectionFolder[] = [{ id: "f1", name: "Work", parentId: null, isExpanded: true }];

function render(props: Partial<React.ComponentProps<typeof SaveAsConnectionDialog>> = {}): {
  onSave: Mock;
  onOpenChange: Mock;
} {
  const onSave = (props.onSave ?? vi.fn().mockResolvedValue(undefined)) as Mock;
  const onOpenChange = (props.onOpenChange ?? vi.fn()) as Mock;
  act(() =>
    root.render(
      <SaveAsConnectionDialog
        entry={props.entry ?? entry}
        folders={props.folders ?? folders}
        onOpenChange={onOpenChange}
        onSave={onSave}
      />
    )
  );
  return { onSave, onOpenChange };
}

async function clickSave() {
  await act(async () => {
    (query("save-as-connection-submit") as HTMLButtonElement).click();
    await Promise.resolve();
  });
}

describe("SaveAsConnectionDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    credStatus.value = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("pre-fills name and connection fields from the entry", () => {
    render();
    expect((query("save-as-connection-name") as HTMLInputElement).value).toBe("admin@prod");
    expect((query("save-as-connection-host") as HTMLInputElement).value).toBe("prod");
    expect((query("save-as-connection-port") as HTMLInputElement).value).toBe("22");
    expect((query("save-as-connection-username") as HTMLInputElement).value).toBe("admin");
  });

  it("creates a connection carrying the (unedited) fields on save", async () => {
    const { onSave, onOpenChange } = render();
    await clickSave();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [connection, dedupKey] = onSave.mock.calls[0] as [SavedConnection, string];
    expect(connection.name).toBe("admin@prod");
    expect(connection.config.config).toMatchObject({
      host: "prod",
      username: "admin",
      port: 22,
      authMethod: "password",
    });
    expect(dedupKey).toBe("ssh:admin@prod:22");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("writes edited host and username into the saved connection", async () => {
    const { onSave } = render();
    typeInto(query("save-as-connection-host") as HTMLInputElement, "prod-db.example.com");
    typeInto(query("save-as-connection-username") as HTMLInputElement, "root");
    await clickSave();

    const [connection] = onSave.mock.calls[0] as [SavedConnection];
    expect(connection.config.config).toMatchObject({
      host: "prod-db.example.com",
      username: "root",
    });
  });

  it("rejects an empty name", async () => {
    const { onSave } = render();
    typeInto(query("save-as-connection-name") as HTMLInputElement, "   ");
    await clickSave();

    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("disables the save-password checkbox when no credential store is active", () => {
    credStatus.value = { mode: "none", status: "unlocked" };
    render();
    const box = query("save-as-connection-save-password") as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(query("save-as-connection-password")).toBeNull();
  });

  it("stores the password before writing the connection when save-password is used", async () => {
    credStatus.value = { mode: "master_password", status: "unlocked" };
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    await act(async () => {
      (query("save-as-connection-save-password") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    typeInto(query("save-as-connection-password") as HTMLInputElement, "s3cret");
    await clickSave();

    expect(storeCredentialMock).toHaveBeenCalledTimes(1);
    const [connId, credType, value] = storeCredentialMock.mock.calls[0] as [string, string, string];
    expect(credType).toBe("password");
    expect(value).toBe("s3cret");
    expect(onSave).toHaveBeenCalledTimes(1);
    const [connection] = onSave.mock.calls[0] as [SavedConnection];
    expect(connection.id).toBe(connId);
    expect(connection.config.config).toMatchObject({ savePassword: true });
    // Credential must be stored before the connection is written.
    expect(storeCredentialMock.mock.invocationCallOrder[0]).toBeLessThan(
      onSave.mock.invocationCallOrder[0]
    );
  });

  it("aborts the save when storing the password fails", async () => {
    credStatus.value = { mode: "master_password", status: "unlocked" };
    storeCredentialMock.mockRejectedValueOnce(new Error("locked"));
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    await act(async () => {
      (query("save-as-connection-save-password") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    typeInto(query("save-as-connection-password") as HTMLInputElement, "s3cret");
    await clickSave();

    expect(storeCredentialMock).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });
});
