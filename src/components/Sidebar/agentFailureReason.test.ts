import { describe, it, expect } from "vitest";
import { classifyAgentError } from "@/utils/classifyAgentError";
import { agentFailureReason } from "./agentFailureReason";

const reason = (error: string) => agentFailureReason(classifyAgentError(error), "box.example");
const steps = (error: string) => reason(error).steps.map((s) => s.id);

describe("agentFailureReason (#6160)", () => {
  it("says why in a short sentence, with the next step, per kind of failure", () => {
    expect(reason("[thub-code:unreachable] connect timed out").text).toBe(
      "Could not reach box.example."
    );
    expect(steps("[thub-code:unreachable] x")).toEqual(["edit", "details"]);

    expect(reason("[thub-code:auth_failed] denied").text).toBe("box.example refused the sign-in.");
    expect(steps("[thub-code:auth_failed] denied")).toEqual(["edit", "details"]);

    expect(reason("[thub-code:agent_missing] not found").text).toBe(
      "The termiHub agent is not installed on box.example."
    );
    expect(steps("[thub-code:agent_missing] not found")).toEqual(["setup", "details"]);

    expect(steps("[thub-code:agent_outdated] v1")).toEqual(["update", "details"]);
    expect(steps("[thub-code:already_connected] x")).toEqual(["force-reconnect", "details"]);
  });

  it("shows an unclassified failure's own message, with its details", () => {
    expect(reason("Broken pipe (os error 32)")).toEqual({
      text: "Broken pipe (os error 32)",
      steps: [{ id: "details", label: "Details" }],
    });
  });

  it("names each step in words", () => {
    const labels = Object.fromEntries(
      [
        ...reason("[thub-code:unreachable] x").steps,
        ...reason("[thub-code:agent_missing] x").steps,
        ...reason("[thub-code:agent_outdated] x").steps,
        ...reason("[thub-code:already_connected] x").steps,
      ].map((s) => [s.id, s.label])
    );
    expect(labels).toEqual({
      edit: "Edit connection",
      details: "Details",
      setup: "Set up agent",
      update: "Update agent",
      "force-reconnect": "Force reconnect",
    });
  });
});
