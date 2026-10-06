import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileSideChannel } from "@/types/generated/FileSideChannel";
import type { RemoteDesktopUploadStarted } from "@/types/generated/RemoteDesktopUploadStarted";
import type { TransferProgress } from "@/services/api";
import { flushMacrotask } from "@/test/flushAsync";

const hoisted = vi.hoisted(() => ({
  upload: vi.fn(),
  progress: null as ((p: TransferProgress) => void) | null,
  unlisten: vi.fn(),
  seed: vi.fn(),
  toast: {
    loading: vi.fn(() => "t1"),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/services/api", () => ({ remoteDesktopUpload: hoisted.upload }));
vi.mock("@/services/events", () => ({
  onTransferProgress: vi.fn((cb: (p: TransferProgress) => void) => {
    hoisted.progress = cb;
    return Promise.resolve(hoisted.unlisten);
  }),
}));
vi.mock("@/hooks/transferFeedback", () => ({ seedTransferQueueRow: hoisted.seed }));
vi.mock("@/components/ui", () => ({ toast: hoisted.toast }));

import {
  countLabel,
  dropSubject,
  routeCarrier,
  routeVia,
  unavailableCopy,
  uploadToRemoteDesktop,
} from "./fileTransfer";

const SSH: FileSideChannel = { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true };
const AGENT: FileSideChannel = { kind: "agent", host: "lab-pi", user: "pi", sameHost: true };

function started(ids: string[], extra: Partial<RemoteDesktopUploadStarted> = {}) {
  return {
    destDir: "/home/arne/Desktop",
    host: "tiger-box",
    transfers: ids.map((id) => ({
      transferId: id,
      localPath: `/local/${id}`,
      remotePath: `/home/arne/Desktop/${id}`,
    })),
    folders: 0,
    skipped: [],
    ...extra,
  } satisfies RemoteDesktopUploadStarted;
}

function settle(transferId: string, phase: "done" | "error" | "cancelled") {
  hoisted.progress?.({ transferId, phase } as TransferProgress);
}

describe("file transfer copy", () => {
  it("names the carrier and the account", () => {
    expect(routeVia(SSH)).toBe("via SFTP over the SSH tunnel (arne@tiger-box)");
    expect(routeVia(AGENT)).toBe("via the termiHub agent on lab-pi");
    expect(routeVia({ ...SSH, user: "" })).toBe("via SFTP over the SSH tunnel (tiger-box)");
    expect(routeCarrier(SSH)).toContain("host key verified");
    expect(routeCarrier(AGENT)).toBe("termiHub agent (pi@lab-pi)");
  });

  it("says why there is no transfer and how to enable it", () => {
    expect(unavailableCopy("noRoute").hint).toContain("Enable the SSH Tunnel");
    expect(unavailableCopy("disabled").hint).toContain("Turn on File Transfer");
    expect(unavailableCopy("viewOnly").hint).toContain("View-only");
  });

  it("describes a drop by its one name or a count", () => {
    expect(dropSubject(["/a/report.pdf"])).toBe("report.pdf");
    expect(dropSubject(["C:\\x\\notes.md"])).toBe("notes.md");
    expect(dropSubject(["/a", "/b"])).toBe("2 files");
    expect(countLabel(1)).toBe("1 file");
    expect(countLabel(3, "folder")).toBe("3 folders");
  });
});

describe("uploadToRemoteDesktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.progress = null;
  });

  it("queues, seeds rows and toasts one summary when every file is done", async () => {
    hoisted.upload.mockResolvedValue(started(["a", "b"]));
    const result = await uploadToRemoteDesktop("rd-1", ["/l/a", "/l/b"]);

    expect(hoisted.upload).toHaveBeenCalledWith("rd-1", ["/l/a", "/l/b"], undefined);
    expect(result?.transfers).toHaveLength(2);
    expect(hoisted.seed).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: "a", sessionId: "rd-1", direction: "upload" })
    );
    expect(hoisted.toast.loading).toHaveBeenLastCalledWith(
      "Uploading 2 files to /home/arne/Desktop on tiger-box…",
      expect.objectContaining({ id: "t1" })
    );
    settle("a", "done");
    expect(hoisted.toast.success).not.toHaveBeenCalled();
    settle("b", "done");
    await flushMacrotask();
    expect(hoisted.toast.success).toHaveBeenCalledWith(
      "Uploaded 2 files to /home/arne/Desktop on tiger-box",
      expect.objectContaining({ id: "t1" })
    );
    expect(hoisted.unlisten).toHaveBeenCalled();
  });

  it("listens before queueing so a transfer that settles at once is counted", async () => {
    hoisted.upload.mockImplementation(async () => {
      settle("fast", "done");
      return started(["fast"]);
    });
    await uploadToRemoteDesktop("rd-1", ["/l/fast"]);
    await flushMacrotask();
    expect(hoisted.toast.success).toHaveBeenCalledWith(
      "Uploaded 1 file to /home/arne/Desktop on tiger-box",
      expect.anything()
    );
  });

  it("reports failed files and the skipped ones", async () => {
    hoisted.upload.mockResolvedValue(
      started(["a", "b"], {
        skipped: [{ localPath: "/l/link", reason: "symbolic links are not followed" }],
      })
    );
    await uploadToRemoteDesktop("rd-1", ["/l/a", "/l/b", "/l/link"]);
    settle("a", "done");
    settle("b", "error");
    await flushMacrotask();
    expect(hoisted.toast.error).toHaveBeenCalledWith(
      "Uploaded 1 of 2 files to /home/arne/Desktop on tiger-box",
      expect.objectContaining({
        description: expect.stringContaining("1 skipped (symbolic links are not followed)"),
      })
    );
  });

  it("toasts the backend's refusal and queues nothing", async () => {
    hoisted.upload.mockRejectedValue("File transfer is not available in a view-only session");
    expect(await uploadToRemoteDesktop("rd-1", ["/l/a"])).toBeNull();
    expect(hoisted.toast.error).toHaveBeenCalledWith(
      "Upload failed: File transfer is not available in a view-only session",
      expect.objectContaining({ id: "t1" })
    );
    expect(hoisted.seed).not.toHaveBeenCalled();
    expect(hoisted.unlisten).toHaveBeenCalled();
  });

  it("says so when nothing could be uploaded", async () => {
    hoisted.upload.mockResolvedValue(
      started([], {
        skipped: [{ localPath: "/l/link", reason: "symbolic links are not followed" }],
      })
    );
    await uploadToRemoteDesktop("rd-1", ["/l/link"], "~/in");
    expect(hoisted.upload).toHaveBeenCalledWith("rd-1", ["/l/link"], "~/in");
    expect(hoisted.toast.error).toHaveBeenCalledWith(
      "Nothing was uploaded to /home/arne/Desktop on tiger-box",
      expect.anything()
    );
  });

  it("stays quiet when the user cancelled every upload", async () => {
    hoisted.upload.mockResolvedValue(started(["a"]));
    await uploadToRemoteDesktop("rd-1", ["/l/a"]);
    settle("a", "cancelled");
    await flushMacrotask();
    expect(hoisted.toast.dismiss).toHaveBeenCalledWith("t1");
    expect(hoisted.toast.success).not.toHaveBeenCalled();
  });
});
