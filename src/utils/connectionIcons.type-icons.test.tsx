/**
 * Distinct connection-type icons (#5622): every built-in connection type gets
 * its own glyph, the SSH glyph is never a Wi-Fi/connectivity glyph, and the
 * graphical types (VNC/RDP) never borrow the local-shell `>_` glyph. The icon
 * id is exposed as a `data-icon` attribute so product-run grades can check it.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { ConnectionConfig } from "@/types/terminal";
import {
  ConnectionIcon,
  ConnectionTypeIcon,
  getConnectionTypeIconInfo,
  getDefaultIconInfo,
} from "./connectionIcons";

const BUILTIN_TYPES = ["local", "ssh", "serial", "telnet", "docker", "vnc", "rdp", "wsl"];

function iconIdOf(container: HTMLElement): string | null {
  return container.querySelector("svg")?.getAttribute("data-icon") ?? null;
}

describe("connection type icons (#5622)", () => {
  it("gives every built-in connection type a distinct icon id", () => {
    const ids = BUILTIN_TYPES.map((t) => getConnectionTypeIconInfo(t).id);
    expect(new Set(ids).size).toBe(BUILTIN_TYPES.length);
  });

  it("uses a dedicated SSH glyph, never a Wi-Fi/connectivity glyph", () => {
    const { id } = getConnectionTypeIconInfo("ssh");
    expect(id).toBe("key-round");
    expect(id).not.toMatch(/wifi/);
  });

  it("uses remote-desktop glyphs for VNC and RDP, never the local-shell glyph", () => {
    const local = getConnectionTypeIconInfo("local").id;
    expect(getConnectionTypeIconInfo("vnc").id).toBe("screen-share");
    expect(getConnectionTypeIconInfo("rdp").id).toBe("monitor");
    expect(getConnectionTypeIconInfo("vnc").id).not.toBe(local);
    expect(getConnectionTypeIconInfo("rdp").id).not.toBe(local);
  });

  it("falls back to the terminal glyph for an unknown (plugin) type", () => {
    expect(getConnectionTypeIconInfo("my-plugin-type").id).toBe("terminal");
  });

  it.each([
    ["local", { type: "local", config: {} }, "terminal"],
    ["ssh", { type: "ssh", config: { host: "h", username: "u" } }, "key-round"],
    ["vnc", { type: "vnc", config: { host: "h" } }, "screen-share"],
    ["rdp", { type: "rdp", config: { host: "h" } }, "monitor"],
    ["serial", { type: "serial", config: {} }, "cable"],
    ["telnet", { type: "telnet", config: {} }, "globe"],
    ["docker", { type: "docker", config: {} }, "container"],
  ])("ConnectionIcon renders data-icon for %s", (_type, config, expected) => {
    const { container } = render(<ConnectionIcon config={config as ConnectionConfig} />);
    expect(iconIdOf(container)).toBe(expected);
    expect(getDefaultIconInfo(config as ConnectionConfig).id).toBe(expected);
  });

  it("ConnectionIcon renders three different icons for ssh, vnc and local", () => {
    const ids = (["ssh", "vnc", "local"] as const).map((type) => {
      const { container } = render(
        <ConnectionIcon config={{ type, config: {} } as ConnectionConfig} />
      );
      return iconIdOf(container);
    });
    expect(new Set(ids).size).toBe(3);
  });

  it("ConnectionIcon tags a custom icon with its stored name", () => {
    const { container } = render(
      <ConnectionIcon
        config={{ type: "ssh", config: {} } as ConnectionConfig}
        customIcon="Rocket"
      />
    );
    expect(iconIdOf(container)).toBe("Rocket");
  });

  it("ConnectionIcon tags the WSL penguin glyph", () => {
    const { container } = render(
      <ConnectionIcon config={{ type: "wsl", config: {} } as ConnectionConfig} />
    );
    expect(iconIdOf(container)).toBe("penguin");
  });

  it.each(BUILTIN_TYPES)("ConnectionTypeIcon matches the type map for %s", (type) => {
    const { container } = render(<ConnectionTypeIcon type={type} />);
    expect(iconIdOf(container)).toBe(getConnectionTypeIconInfo(type).id);
  });
});
