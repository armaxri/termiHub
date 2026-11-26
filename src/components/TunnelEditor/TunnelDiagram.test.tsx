import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TunnelDiagram } from "./TunnelDiagram";
import type { TunnelType } from "@/types/tunnel";

let container: HTMLDivElement;
let root: Root;

function render(tunnelType: TunnelType) {
  act(() => {
    root.render(<TunnelDiagram tunnelType={tunnelType} />);
  });
}

function boxes(): string[] {
  return Array.from(container.querySelectorAll(".tunnel-diagram__box")).map(
    (b) => b.textContent ?? ""
  );
}

describe("TunnelDiagram", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a local forward with the local and remote endpoints and a forward arrow", () => {
    render({
      type: "local",
      config: {
        localHost: "127.0.0.1",
        localPort: 8080,
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    });
    expect(container.querySelector('[data-testid="tunnel-diagram"]')).not.toBeNull();
    const text = boxes().join(" | ");
    expect(text).toContain("This computer");
    expect(text).toContain("127.0.0.1:8080");
    expect(text).toContain("Target");
    expect(text).toContain("db.internal:5432");
    // Local forward flows outward: "→ SSH →".
    expect(container.textContent).toContain("→ SSH →");
  });

  it("renders a remote forward with reversed labels and an inbound arrow", () => {
    render({
      type: "remote",
      config: { localHost: "127.0.0.1", localPort: 3000, remoteHost: "0.0.0.0", remotePort: 9000 },
    });
    const text = boxes().join(" | ");
    expect(text).toContain("Local target");
    expect(text).toContain("127.0.0.1:3000");
    expect(text).toContain("Remote clients");
    expect(text).toContain("0.0.0.0:9000");
    // Remote forward flows inward: "← SSH ←".
    expect(container.textContent).toContain("← SSH ←");
  });

  it("renders a dynamic (SOCKS5) forward with a wildcard internet target", () => {
    render({
      type: "dynamic",
      config: { localHost: "127.0.0.1", localPort: 1080 },
    });
    const text = boxes().join(" | ");
    expect(text).toContain("SOCKS5 127.0.0.1:1080");
    expect(text).toContain("Internet");
    expect(text).toContain("*:*");
  });

  it("names the agent instead of this computer for an agent-hosted tunnel (#6027)", () => {
    const local: TunnelType = {
      type: "local",
      config: { localHost: "127.0.0.1", localPort: 1, remoteHost: "db", remotePort: 2 },
    };
    const remote: TunnelType = {
      type: "remote",
      config: { localHost: "127.0.0.1", localPort: 1, remoteHost: "0.0.0.0", remotePort: 2 },
    };
    const dynamic: TunnelType = {
      type: "dynamic",
      config: { localHost: "127.0.0.1", localPort: 1 },
    };
    const first = (tunnelType: TunnelType) => {
      act(() => root.render(<TunnelDiagram tunnelType={tunnelType} agentName="build-box" />));
      return boxes()[0];
    };
    expect(first(local)).toContain("Agent build-box");
    expect(first(dynamic)).toContain("Agent build-box");
    expect(first(remote)).toContain("Agent-side target");
    expect(container.textContent).not.toContain("This computer");
  });

  it("names the SSH server as the user knows it, not by a role (#6117, F-010)", () => {
    act(() => {
      root.render(
        <TunnelDiagram
          serverName="Build Box"
          tunnelType={{
            type: "local",
            config: {
              localHost: "127.0.0.1",
              localPort: 15432,
              remoteHost: "db",
              remotePort: 5432,
            },
          }}
        />
      );
    });
    const server = container.querySelector("[data-part='server']")!;
    expect(server.querySelector(".tunnel-diagram__box-title")?.textContent).toBe("Build Box");
    expect(server.textContent).toContain("SSH server");
    expect(container.textContent).not.toContain("relay");
  });

  it("keeps an address on one line with all of it in the tooltip (#6117, F-006)", () => {
    render({
      type: "local",
      config: {
        localHost: "192.168.100.200",
        localPort: 15432,
        remoteHost: "db",
        remotePort: 5432,
      },
    });
    const detail = container.querySelector<HTMLElement>(
      "[data-part='listener'] .tunnel-diagram__box-detail"
    )!;
    expect(detail.title).toBe("192.168.100.200:15432");
    expect(detail.querySelector(".middle-ellipsis")).not.toBeNull();
    expect(detail.querySelector("wbr")).toBeNull();
  });
});
