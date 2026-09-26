import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";

vi.mock("@/services/namedCredentials", async () => {
  const actual = await vi.importActual<typeof import("@/services/namedCredentials")>(
    "@/services/namedCredentials"
  );
  return {
    ...actual,
    listNamedCredentials: vi.fn(),
    createNamedCredential: vi.fn(),
    renameNamedCredential: vi.fn(),
    rotateNamedCredential: vi.fn(),
    deleteNamedCredential: vi.fn(),
  };
});

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

import {
  createNamedCredential,
  deleteNamedCredential,
  listNamedCredentials,
  rotateNamedCredential,
} from "@/services/namedCredentials";
import { SharedCredentialsSettings, usageSummary } from "./SharedCredentialsSettings";

const mockedList = vi.mocked(listNamedCredentials);
const mockedCreate = vi.mocked(createNamedCredential);
const mockedRotate = vi.mocked(rotateNamedCredential);
const mockedDelete = vi.mocked(deleteNamedCredential);

const BASTION: NamedCredentialEntry = {
  credential: { id: "nc-1", name: "Bastion", kind: "password", createdAt: "t" },
  usages: [
    { ownerKind: "connection", ownerId: "Work/web", ownerName: "web" },
    { ownerKind: "agent", ownerId: "agent-1", ownerName: "Pi" },
  ],
};

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInputValue(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(testId: string) {
  await act(async () => {
    query(testId)!.click();
  });
}

async function render(mode: "master_password" | "os_keychain" | "none", status = "unlocked") {
  useAppStore.setState({
    credentialStoreStatus: { mode, status: status as "unlocked" | "locked" | "unavailable" },
  });
  await act(async () => root.render(<SharedCredentialsSettings />));
}

describe("SharedCredentialsSettings (#3557)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    vi.clearAllMocks();
    mockedList.mockResolvedValue([BASTION]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("summarizes usage", () => {
    expect(usageSummary([])).toBe("Not used");
    expect(usageSummary(BASTION.usages)).toBe("Used by 2 connections");
    expect(usageSummary(BASTION.usages.slice(0, 1))).toBe("Used by 1 connection");
  });

  it("lists credentials with kind and usage", async () => {
    await render("master_password");
    const row = query("shared-credential-nc-1");
    expect(row?.textContent).toContain("Bastion");
    expect(row?.textContent).toContain("Password · Used by 2 connections");
  });

  it("blocks creating when credential storage is off", async () => {
    await render("none");
    expect(query("shared-credentials-unavailable")).not.toBeNull();
    expect((query("shared-credentials-create") as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates a credential after the secret is confirmed", async () => {
    mockedCreate.mockResolvedValue(BASTION.credential);
    await render("os_keychain");
    await click("shared-credentials-create");
    setInputValue("shared-credential-name", "Bastion 2");
    setInputValue("shared-credential-secret", "s3cret");
    setInputValue("shared-credential-confirm", "different");
    await click("shared-credential-submit");
    expect(query("shared-credential-error")?.textContent).toContain("do not match");
    expect(mockedCreate).not.toHaveBeenCalled();

    setInputValue("shared-credential-confirm", "s3cret");
    await click("shared-credential-submit");
    expect(mockedCreate).toHaveBeenCalledWith("Bastion 2", "password", "s3cret");
  });

  it("asks to unlock a locked store before rotating", async () => {
    const requestUnlock = vi.fn().mockResolvedValue(false);
    useAppStore.setState({ requestUnlock });
    await render("master_password", "locked");
    await click("shared-credential-rotate-nc-1");
    expect(requestUnlock).toHaveBeenCalledTimes(1);
    expect(query("shared-credential-dialog-title")).toBeNull();
  });

  it("rotates the secret", async () => {
    mockedRotate.mockResolvedValue(BASTION.credential);
    await render("master_password");
    await click("shared-credential-rotate-nc-1");
    setInputValue("shared-credential-secret", "new-secret");
    setInputValue("shared-credential-confirm", "new-secret");
    await click("shared-credential-submit");
    expect(mockedRotate).toHaveBeenCalledWith("nc-1", "new-secret");
  });

  it("lists the connections that still use a credential when delete is refused", async () => {
    mockedDelete.mockRejectedValue({
      kind: "inUse",
      message: '"Bastion" is used by 2 connections.',
      usages: BASTION.usages,
    });
    await render("master_password");
    await click("shared-credential-delete-nc-1");
    await click("shared-credential-delete-confirm");
    expect(mockedDelete).toHaveBeenCalledWith("nc-1");
    const refusal = query("shared-credentials-in-use");
    expect(refusal?.textContent).toContain("is used by 2 connections");
    expect(refusal?.textContent).toContain("web");
    expect(refusal?.textContent).toContain("Pi (remote agent)");
  });
});
