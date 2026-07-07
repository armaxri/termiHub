import { describe, it, expect } from "vitest";
import {
  CONNECTING_TIMEOUT_MS,
  WAITING_FOR_AGENT_TIMEOUT_MS,
  connectTimeoutMessage,
} from "./connectTimeout";

describe("connectTimeout", () => {
  it("exposes positive timeout durations", () => {
    expect(CONNECTING_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WAITING_FOR_AGENT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("builds a contextual message for the waiting-for-agent timeout that names the agent wait and duration", () => {
    const msg = connectTimeoutMessage("waiting-for-agent");
    expect(msg).toContain("Agent did not come online");
    // The duration in whole seconds must appear in the message.
    expect(msg).toContain(String(Math.round(WAITING_FOR_AGENT_TIMEOUT_MS / 1000)));
    expect(msg).toContain("s");
  });

  it("builds a contextual message for the connecting timeout that mentions the connect wait and duration", () => {
    const msg = connectTimeoutMessage("connecting");
    expect(msg.toLowerCase()).toContain("connect");
    expect(msg).toContain(String(Math.round(CONNECTING_TIMEOUT_MS / 1000)));
  });
});
