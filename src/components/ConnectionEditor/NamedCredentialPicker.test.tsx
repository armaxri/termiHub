import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { NamedCredentialEntry } from "@/types/generated/NamedCredentialEntry";

vi.mock("@/services/namedCredentials", () => ({
  listNamedCredentials: vi.fn(),
  NAMED_CREDENTIALS_CHANGED_EVENT: "termihub:named-credentials-changed",
}));

import { listNamedCredentials } from "@/services/namedCredentials";
import { NamedCredentialPicker } from "./NamedCredentialPicker";

const mockedList = vi.mocked(listNamedCredentials);

function entry(
  id: string,
  name: string,
  kind: "password" | "key_passphrase"
): NamedCredentialEntry {
  return { credential: { id, name, kind, createdAt: "t" }, usages: [] };
}

const ENTRIES = [
  entry("nc-pw", "Bastion", "password"),
  entry("nc-key", "Deploy key", "key_passphrase"),
];

let container: HTMLDivElement;
let root: Root;

async function render(authMethod: string, value: string | undefined, onChange = vi.fn()) {
  await act(async () => {
    root.render(
      <NamedCredentialPicker authMethod={authMethod} value={value} onChange={onChange} />
    );
  });
  return onChange;
}

function picker(): HTMLElement | null {
  return container.querySelector('[data-testid="named-credential-picker"]');
}

function openSelect(): HTMLElement[] {
  const trigger = container.querySelector(
    '[data-testid="named-credential-select"]'
  ) as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

describe("NamedCredentialPicker (#3557)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue(ENTRIES);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers only credentials of the kind the auth method needs", async () => {
    await render("password", undefined);
    const labels = openSelect().map((o) => o.textContent);
    expect(labels).toEqual(["This connection's password", "Bastion"]);
  });

  it("offers key passphrase credentials for key auth", async () => {
    await render("key", undefined);
    const labels = openSelect().map((o) => o.textContent);
    expect(labels).toEqual(["This connection's passphrase", "Deploy key"]);
  });

  it("renders nothing for an auth method that uses no secret", async () => {
    await render("agent", undefined);
    expect(picker()).toBeNull();
  });

  it("renders nothing when no matching shared credential exists", async () => {
    mockedList.mockResolvedValue([entry("nc-key", "Deploy key", "key_passphrase")]);
    await render("password", undefined);
    expect(picker()).toBeNull();
  });

  it("maps choosing the connection's own secret back to undefined", async () => {
    const onChange = await render("password", "nc-pw");
    const own = openSelect().find((o) => o.textContent === "This connection's password");
    act(() => {
      own?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      own?.click();
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("warns when the referenced credential no longer exists", async () => {
    await render("password", "nc-gone");
    expect(picker()?.textContent).toContain("no longer exists");
    expect(picker()?.textContent).toContain("Missing shared credential");
  });
});
