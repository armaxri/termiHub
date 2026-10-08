import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RemoteDesktopFilesStatus } from "@/hooks/useRemoteDesktopFiles";
import { RemoteDesktopDropOverlay } from "./RemoteDesktopDropOverlay";

let container: HTMLDivElement;
let root: Root;

function render(
  files: RemoteDesktopFilesStatus,
  subject = "2 files",
  destDir: string | null = null
) {
  act(() => {
    root.render(<RemoteDesktopDropOverlay files={files} subject={subject} destDir={destDir} />);
  });
  const overlay = container.querySelector<HTMLElement>(
    '[data-testid="remote-desktop-drop-overlay"]'
  );
  if (!overlay) throw new Error("overlay not rendered");
  return overlay;
}

const sshReady: RemoteDesktopFilesStatus = {
  status: "ready",
  channel: { kind: "ssh", host: "tiger-box", user: "arne", sameHost: true },
  agentId: null,
  defaultDir: "/home/arne/Desktop",
};

describe("RemoteDesktopDropOverlay (#4192)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names folder, host and the SSH tunnel carrier", () => {
    const overlay = render(sshReady);
    expect(overlay.dataset.state).toBe("ready");
    expect(overlay.textContent).toContain("Drop to upload 2 files");
    expect(overlay.textContent).toContain("to /home/arne/Desktop on tiger-box");
    expect(overlay.textContent).toContain("via SFTP over the SSH tunnel (arne@tiger-box)");
    expect(overlay.classList.contains("rd-drop--off")).toBe(false);
  });

  it("names the agent host for the agent route and the session's chosen folder", () => {
    const overlay = render(
      {
        status: "ready",
        channel: { kind: "agent", host: "lab-pi", user: "pi", sameHost: true },
        agentId: "agent-1",
        defaultDir: "/home/pi/Desktop",
      },
      "report.pdf",
      "/home/pi/in"
    );
    expect(overlay.textContent).toContain("Drop to upload report.pdf");
    expect(overlay.textContent).toContain("to /home/pi/in on lab-pi");
    expect(overlay.textContent).toContain("via the termiHub agent on lab-pi");
  });

  it("warns when the file host is not the desktop host", () => {
    const overlay = render({
      ...sshReady,
      channel: { kind: "ssh", host: "bastion.corp", user: "arne", sameHost: false },
    });
    expect(overlay.textContent).toContain("on bastion.corp");
    expect(overlay.textContent).toContain("bastion.corp is not the desktop host");
  });

  it.each([
    ["noRoute", "Enable the SSH Tunnel"],
    ["disabled", "Turn on File Transfer"],
    ["viewOnly", "View-only session"],
  ] as const)("explains the %s state and how to enable it", (reason, hint) => {
    const overlay = render({ status: "unavailable", reason });
    expect(overlay.dataset.state).toBe(reason);
    expect(overlay.classList.contains("rd-drop--off")).toBe(true);
    expect(overlay.textContent).toContain("File transfer isn't available here");
    expect(overlay.textContent).toContain(hint);
  });

  it("shows the degraded route's message", () => {
    const overlay = render({
      status: "degraded",
      channel: sshReady.status === "ready" ? sshReady.channel : (null as never),
      agentId: null,
      message: "File transfer to tiger-box is unavailable: SFTP is not enabled",
    });
    expect(overlay.dataset.state).toBe("degraded");
    expect(overlay.textContent).toContain("SFTP is not enabled");
  });

  it("says it is still checking while the route resolves", () => {
    const overlay = render({ status: "resolving" });
    expect(overlay.dataset.state).toBe("resolving");
    expect(overlay.textContent).toContain("Checking the file route");
  });

  it("offers the drop on a linked route waiting for its password (#4265)", () => {
    const overlay = render({
      status: "degraded",
      channel: { kind: "ssh", host: "tiger-box", user: "arne", sameHost: false },
      agentId: null,
      message: "no password is saved",
      needsSecret: {
        connectionId: "Lab/Tiger",
        sourceFile: null,
        kind: "password",
        authMethod: "password",
        host: "tiger-box",
        username: "arne",
        storeLocked: false,
        canSave: true,
        rejected: false,
      },
    });
    expect(overlay.dataset.state).toBe("needsSecret");
    expect(overlay.textContent).toContain("Drop to upload 2 files");
    expect(overlay.textContent).toContain("asked for the password of arne@tiger-box");
    expect(overlay.classList.contains("rd-drop--off")).toBe(false);
  });
});
