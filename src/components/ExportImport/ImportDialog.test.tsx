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
});
