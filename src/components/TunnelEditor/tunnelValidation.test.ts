import { describe, it, expect } from "vitest";
import type { TunnelType, LocalForwardConfig } from "@/types/tunnel";
import { validateTunnelType } from "./tunnelValidation";

const local = (over: Partial<Record<string, unknown>> = {}): TunnelType => ({
  type: "local",
  config: {
    localHost: "127.0.0.1",
    localPort: 8080,
    remoteHost: "localhost",
    remotePort: 80,
    ...over,
  } as unknown as LocalForwardConfig,
});

describe("validateTunnelType", () => {
  it("accepts a fully-valid local forward", () => {
    const { valid, errors } = validateTunnelType(local());
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it("rejects port 0 (the parseInt||0 regression)", () => {
    const { valid, errors } = validateTunnelType(local({ localPort: 0 }));
    expect(valid).toBe(false);
    expect(errors.localPort).toBe("Local port must be between 1 and 65535");
  });

  it("rejects a blank ('') port as required (#1444)", () => {
    const { valid, errors } = validateTunnelType(local({ localPort: "" }));
    expect(valid).toBe(false);
    expect(errors.localPort).toBe("Local port is required");
  });

  it("rejects a port above 65535", () => {
    const { valid, errors } = validateTunnelType(local({ remotePort: 70000 }));
    expect(valid).toBe(false);
    expect(errors.remotePort).toBe("Remote port must be between 1 and 65535");
  });

  it("rejects a blank host", () => {
    const { valid, errors } = validateTunnelType(local({ remoteHost: "  " }));
    expect(valid).toBe(false);
    expect(errors.remoteHost).toBe("Remote host is required");
  });

  it("validates only the fields present on a dynamic forward", () => {
    const dynamic: TunnelType = {
      type: "dynamic",
      config: { localHost: "127.0.0.1", localPort: 1080 },
    };
    expect(validateTunnelType(dynamic).valid).toBe(true);
    const bad: TunnelType = {
      type: "dynamic",
      config: { localHost: "", localPort: 1080 },
    };
    const { valid, errors } = validateTunnelType(bad);
    expect(valid).toBe(false);
    expect(errors.localHost).toBe("Local host is required");
    expect(errors.remotePort).toBeUndefined();
  });
});
