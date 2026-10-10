import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ImportDialog, importSummary } from "./ImportDialog";

vi.mock("@/services/api", async (importOriginal) => {
  // Keep the real `isImportError` guard so the dialog classifies rejections the
  // same way it does in production; only the IPC calls are stubbed.
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    previewImport: vi.fn(),
    importConnectionsWithCredentials: vi.fn(),
    isImportError: actual.isImportError,
  };
});

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
    mockedImport.mockResolvedValueOnce({
      connectionsImported: 1,
      connectionsSkipped: 0,
      agentsImported: 0,
      agentsSkipped: 0,
      credentialsImported: 0,
      sharedCredentialsImported: 0,
      warnings: [],
    });

    await open("{}");

    const submit = query("import-submit") as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });

    expect(mockedImport).toHaveBeenCalledWith("{}", null);
    expect(query("import-dialog-success")).not.toBeNull();
  });

  it("reports imported shared credentials and the import's warnings", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 2,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: false,
    });
    mockedImport.mockResolvedValueOnce({
      connectionsImported: 2,
      connectionsSkipped: 0,
      agentsImported: 0,
      agentsSkipped: 0,
      credentialsImported: 0,
      sharedCredentialsImported: 1,
      warnings: ['Shared credential "Bastion" was imported as "Bastion (imported)".'],
    });

    await open("{}");
    await act(async () => {
      (query("import-submit") as HTMLButtonElement).click();
    });

    expect(query("import-dialog-success")?.textContent).toContain("1 shared credential");
    const warnings = query("import-dialog-warnings");
    expect(warnings?.textContent).toContain("Bastion (imported)");
  });

  it("renders no warning list when the import has none", async () => {
    mockedPreview.mockResolvedValueOnce({
      connectionCount: 1,
      folderCount: 0,
      agentCount: 0,
      hasEncryptedCredentials: false,
    });
    mockedImport.mockResolvedValueOnce({
      connectionsImported: 1,
      connectionsSkipped: 0,
      agentsImported: 0,
      agentsSkipped: 0,
      credentialsImported: 0,
      sharedCredentialsImported: 0,
      warnings: [],
    });

    await open("{}");
    await act(async () => {
      (query("import-submit") as HTMLButtonElement).click();
    });

    expect(query("import-dialog-success")?.textContent).not.toContain("shared credential");
    expect(query("import-dialog-warnings")).toBeNull();
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
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(passwordInput, "nope");
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = query("import-with-credentials") as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("Failed to parse import data");
    expect(document.body.textContent).not.toContain("Wrong password. Please try again.");
  });
});

describe("importSummary", () => {
  const base = {
    connectionsImported: 0,
    connectionsSkipped: 0,
    agentsImported: 0,
    agentsSkipped: 0,
    credentialsImported: 0,
    sharedCredentialsImported: 0,
    warnings: [],
  };

  it("reports added connections and credentials", () => {
    expect(importSummary({ ...base, connectionsImported: 1, credentialsImported: 1 })).toBe(
      "Imported 1 connection and 1 credential"
    );
  });

  it("reports skipped connections separately from added ones (#4210)", () => {
    expect(importSummary({ ...base, connectionsImported: 2, connectionsSkipped: 4 })).toBe(
      "Imported 2 connections, skipped 4 that already exist"
    );
    expect(importSummary({ ...base, connectionsImported: 3, connectionsSkipped: 1 })).toBe(
      "Imported 3 connections, skipped 1 that already exists"
    );
  });

  it("says nothing was imported when every connection already exists (#4210)", () => {
    expect(importSummary({ ...base, connectionsSkipped: 6 })).toBe(
      "Nothing imported — all 6 connections already exist"
    );
    expect(importSummary({ ...base, connectionsSkipped: 1 })).toBe(
      "Nothing imported — the connection already exists"
    );
  });

  it("still reports shared credentials when every connection was skipped", () => {
    expect(importSummary({ ...base, connectionsSkipped: 2, sharedCredentialsImported: 1 })).toBe(
      "Imported 1 shared credential, skipped 2 connections that already exist"
    );
  });

  it("reports an empty file", () => {
    expect(importSummary(base)).toBe(
      "Nothing imported — the file contains no connections or agents"
    );
  });

  it("lists shared credentials alongside added connections", () => {
    expect(
      importSummary({
        ...base,
        connectionsImported: 2,
        connectionsSkipped: 1,
        credentialsImported: 2,
        sharedCredentialsImported: 1,
      })
    ).toBe(
      "Imported 2 connections and 2 credentials, 1 shared credential, skipped 1 that already exists"
    );
  });

  it("reports a file with only agents instead of 'Nothing imported' (#4380)", () => {
    expect(importSummary({ ...base, agentsImported: 3 })).toBe("Imported 3 agents");
    expect(importSummary({ ...base, agentsImported: 1, credentialsImported: 1 })).toBe(
      "Imported 1 agent and 1 credential"
    );
  });

  it("reports added agents alongside skipped connections (#4380)", () => {
    expect(importSummary({ ...base, connectionsSkipped: 2, agentsImported: 1 })).toBe(
      "Imported 1 agent, skipped 2 connections that already exist"
    );
  });

  it("names every skipped kind once agents are involved (#4380)", () => {
    expect(
      importSummary({ ...base, connectionsImported: 2, connectionsSkipped: 1, agentsSkipped: 1 })
    ).toBe("Imported 2 connections, skipped 1 connection and 1 agent that already exist");
    expect(importSummary({ ...base, connectionsImported: 1, agentsImported: 2 })).toBe(
      "Imported 1 connection, 2 agents"
    );
  });

  it("says nothing was imported when every agent already exists (#4380)", () => {
    expect(importSummary({ ...base, agentsSkipped: 1 })).toBe(
      "Nothing imported — the agent already exists"
    );
    expect(importSummary({ ...base, agentsSkipped: 3 })).toBe(
      "Nothing imported — all 3 agents already exist"
    );
    expect(importSummary({ ...base, connectionsSkipped: 2, agentsSkipped: 1 })).toBe(
      "Nothing imported — 2 connections and 1 agent already exist"
    );
  });
});
