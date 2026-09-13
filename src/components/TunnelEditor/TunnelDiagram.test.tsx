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
    expect(text).toContain("Your PC");
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
    expect(text).toContain("Local Target");
    expect(text).toContain("127.0.0.1:3000");
    expect(text).toContain("Remote Clients");
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
});
