import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { onTransferProgress } from "@/services/events";
import { isBatchTransfer, resetBatchTransfersForTest } from "@/hooks/batchTransferToasts";
vi.mock("@/hooks/transferFeedback", () => ({ seedTransferQueueRow: hoisted.seed }));
vi.mock("@/components/ui", () => ({ toast: hoisted.toast }));

import {
  browseRoute,
  countLabel,
  dropSubject,
  routeCarrier,
  routeVia,
  SETTLEMENT_IDLE_MS,
  unavailableCopy,
  uploadToRemoteDesktop,
} from "./fileTransfer";

const SSH: FileSideChannel = { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true };
const AGENT: FileSideChannel = { kind: "agent", host: "lab-pi", user: "pi", sameHost: true };
const LINKED: FileSideChannel = {
  kind: "ssh",
  host: "tiger-box",
  user: "arne",
  sameHost: false,
  linkedConnection: "Tiger",
};

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

function settle(transferId: string, phase: "done" | "error" | "cancelled" | "transferring") {
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

  it("names the account and carrier on the File Browser's route line (#4193)", () => {
    expect(browseRoute(SSH)).toBe("arne@tiger-box · SFTP via SSH tunnel");
    expect(browseRoute(AGENT)).toBe("pi@lab-pi · termiHub agent");
  });

  it("names a linked SSH connection as the carrier, not a tunnel (#4194)", () => {
    expect(routeVia(LINKED)).toBe("via SFTP over the linked SSH connection Tiger (arne@tiger-box)");
    expect(routeCarrier(LINKED)).toBe(
      "SFTP via the linked SSH connection Tiger (arne@tiger-box, host key verified)"
    );
    expect(browseRoute(LINKED)).toBe("arne@tiger-box · SFTP via the linked SSH connection Tiger");
  });

  it("says why there is no transfer and how to enable it", () => {
    expect(unavailableCopy("noRoute").hint).toContain("link a saved SSH connection");
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

  it("offers Reveal on the summary, opening the destination (#4193)", async () => {
    const onReveal = vi.fn();
    hoisted.upload.mockResolvedValue(started(["a"]));
    await uploadToRemoteDesktop("rd-1", ["/l/a"], undefined, onReveal);
    settle("a", "done");
    await flushMacrotask();
    const opts = (
      hoisted.toast.success.mock.calls[0] as unknown as [string, { action?: unknown }]
    )[1];
    const action = opts.action as { label: string; onClick: () => void };
    expect(action.label).toBe("Reveal");
    action.onClick();
    expect(onReveal).toHaveBeenCalledWith("/home/arne/Desktop");
  });

  it("offers no Reveal when a file failed or without a browser", async () => {
    hoisted.upload.mockResolvedValue(started(["a", "b"]));
    await uploadToRemoteDesktop("rd-1", ["/l/a", "/l/b"], undefined, vi.fn());
    settle("a", "done");
    settle("b", "error");
    await flushMacrotask();
    expect(hoisted.toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ action: expect.anything() })
    );

    vi.clearAllMocks();
    hoisted.upload.mockResolvedValue(started(["c"]));
    await uploadToRemoteDesktop("rd-1", ["/l/c"]);
    settle("c", "done");
    await flushMacrotask();
    expect(hoisted.toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: undefined })
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

  describe("the summary always resolves (#4348, FEC2-004)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetBatchTransfersForTest();
    });
    afterEach(() => vi.useRealTimers());

    it("points to Transfers after a stall instead of spinning forever", async () => {
      hoisted.upload.mockResolvedValue(started(["a", "b"]));
      await uploadToRemoteDesktop("rd-1", ["/l/a", "/l/b"]);
      settle("a", "done");
      // Progress of a tracked upload restarts the inactivity bound.
      await vi.advanceTimersByTimeAsync(SETTLEMENT_IDLE_MS - 1);
      settle("b", "transferring");
      await vi.advanceTimersByTimeAsync(SETTLEMENT_IDLE_MS - 1);
      expect(hoisted.toast.info).not.toHaveBeenCalled();
      expect(hoisted.unlisten).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hoisted.unlisten).toHaveBeenCalledTimes(1);
      expect(hoisted.toast.info).toHaveBeenCalledWith(
        "Upload to /home/arne/Desktop on tiger-box — see Transfers",
        expect.objectContaining({ id: "t1", description: "1 of 2 files done so far" })
      );
      // A file that settles later gets its own per-file toast again.
      expect(isBatchTransfer({ transferId: "b", sessionId: "x", direction: "upload" })).toBe(false);
    });

    it("stops listening and resolves the toast when the session closes", async () => {
      const abort = new AbortController();
      hoisted.upload.mockResolvedValue(started(["a"]));
      await uploadToRemoteDesktop("rd-1", ["/l/a"], undefined, undefined, abort.signal);
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(hoisted.unlisten).toHaveBeenCalledTimes(1);
      expect(hoisted.toast.info).toHaveBeenCalledWith(
        expect.stringContaining("see Transfers"),
        expect.objectContaining({ id: "t1" })
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves the loading toast when the progress listener cannot register", async () => {
      vi.mocked(onTransferProgress).mockRejectedValueOnce(new Error("no event bridge"));
      expect(await uploadToRemoteDesktop("rd-1", ["/l/a"])).toBeNull();
      expect(hoisted.upload).not.toHaveBeenCalled();
      expect(hoisted.toast.error).toHaveBeenCalledWith(
        "Upload failed: no event bridge",
        expect.objectContaining({ id: "t1" })
      );
      // The batch window closed again: later uploads on the session toast normally.
      expect(isBatchTransfer({ transferId: "z", sessionId: "rd-1", direction: "upload" })).toBe(
        false
      );
    });

    it("claims its files so the per-file toasts stay quiet", async () => {
      hoisted.upload.mockImplementation(async () => {
        // Settling before the ids are known: covered by the batch window.
        expect(isBatchTransfer({ transferId: "q", sessionId: "rd-1", direction: "upload" })).toBe(
          true
        );
        return started(["a"]);
      });
      await uploadToRemoteDesktop("rd-1", ["/l/a"]);
      expect(isBatchTransfer({ transferId: "a", sessionId: "rd-1", direction: "upload" })).toBe(
        true
      );
      expect(isBatchTransfer({ transferId: "q", sessionId: "rd-1", direction: "upload" })).toBe(
        false
      );
    });
  });
});
