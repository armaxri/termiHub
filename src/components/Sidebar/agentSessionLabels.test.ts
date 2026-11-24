import { describe, expect, it } from "vitest";
import { agentSessionLabels } from "./agentSessionLabels";

describe("agentSessionLabels (#5953)", () => {
  it("numbers the second and later sessions of the same title", () => {
    const labels = agentSessionLabels([
      { sessionId: "a", title: "box · bash" },
      { sessionId: "b", title: "box · bash" },
      { sessionId: "c", title: "box · zsh" },
      { sessionId: "d", title: "box · bash" },
    ]);
    expect([...labels.values()]).toEqual([
      "box · bash",
      "box · bash 2",
      "box · zsh",
      "box · bash 3",
    ]);
  });

  it("keeps distinct titles as they are", () => {
    const labels = agentSessionLabels([
      { sessionId: "a", title: "bash" },
      { sessionId: "b", title: "Logs" },
    ]);
    expect(labels.get("a")).toBe("bash");
    expect(labels.get("b")).toBe("Logs");
  });
});
