import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ImportDialog } from "./ImportDialog";

vi.mock("@/services/api", () => ({
  previewImport: vi.fn(),
  importConnectionsWithCredentials: vi.fn(),
}));

import { previewImport, importConnectionsWithCredentials } from "@/services/api";

const mockedPreview = vi.mocked(previewImport);
const mockedImport = vi.mocked(importConnectionsWithCredentials);

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/** Open the dialog with the given file content and let the preview effect settle. */
async function open(content: string) {
  useAppStore.setState({
    importDialogOpen: true,
    importFileContent: content,
    loadFromBackend: vi.fn().mockResolvedValue(undefined),
  });
  await act(async () => {
    root.render(<ImportDialog />);
  });
}

describe("ImportDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not render when closed", () => {
    act(() => root.render(<ImportDialog />));
    expect(document.querySelector(".ui-modal")).toBeNull();
  });

  it("renders through the Modal primitive with a preview", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 2,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: false,
    });

    await open("{}");

    expect(document.querySelector(".ui-modal")).not.toBeNull();
    expect(query("import-submit")).not.toBeNull();
  });

  it("fires the import action on submit", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 1,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: false,
    });
    mockedImport.mockResolvedValueOnce({ connectionsImported: 1, credentialsImported: 0 });

    await open("{}");

    const submit = query("import-submit") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(mockedImport).toHaveBeenCalledWith("{}", null);
    expect(query("import-dialog-success")).not.toBeNull();
  });

  it("shows the wrong-password affordance on a wrongPassword error code", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 1,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: true,
    });
    // The backend rejects with a structured error carrying a stable `kind`,
    // NOT an English message the dialog must parse (I18N-010). The message it
    // does carry is deliberately non-English here to prove the dialog never
    // reads it for classification.
    mockedImport.mockRejectedValueOnce({
      kind: "wrongPassword",
      message: "Entschlüsselung fehlgeschlagen",
    });

    await open("{}");

    const passwordInput = query("import-password") as HTMLInputElement;
    await act(async () => {
      passwordInput.value = "nope";
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = query("import-with-credentials") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(document.body.textContent).toContain("Wrong password. Please try again.");
    expect(document.body.textContent).not.toContain("Entschlüsselung fehlgeschlagen");
  });

  it("shows the backend message on a non-password (other) error code", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 1,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: false,
    });
    mockedImport.mockRejectedValueOnce({
      kind: "other",
      message: "Failed to parse import data",
    });

    await open("{}");

    const submit = query("import-submit") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(document.body.textContent).toContain("Failed to parse import data");
    expect(document.body.textContent).not.toContain("Wrong password. Please try again.");
  });
});
