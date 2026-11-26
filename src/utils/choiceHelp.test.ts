/** The plain words for bare-word choices (#6036). */
import { describe, expect, it } from "vitest";
import { CHOICE_VALUES, choiceHelp, schemaChoiceTopic, type ChoiceTopic } from "./choiceHelp";

const TOPICS = Object.keys(CHOICE_VALUES) as ChoiceTopic[];

describe("choiceHelp", () => {
  it.each(TOPICS.flatMap((topic) => CHOICE_VALUES[topic].map((value) => [topic, value])))(
    "explains %s %s: a summary and three sentences",
    (topic, value) => {
      const help = choiceHelp(topic as ChoiceTopic, value)!;
      expect(help.summary.length).toBeGreaterThan(5);
      expect(help.summary).not.toMatch(/\.$/);
      expect(help.lines).toHaveLength(3);
      for (const line of help.lines) expect(line).toMatch(/^(termiHub|[A-Z]).+\.$/);
    }
  );

  it("says something different for each value of a choice", () => {
    for (const topic of TOPICS) {
      const summaries = CHOICE_VALUES[topic].map((v) => choiceHelp(topic, v)!.summary);
      expect(new Set(summaries).size).toBe(summaries.length);
    }
  });

  it("knows nothing of a value a newer backend offers", () => {
    expect(choiceHelp("parity", "mark")).toBeUndefined();
  });

  it("explains a schema field by its key, and only the four it knows", () => {
    expect(schemaChoiceTopic("parity")).toBe("parity");
    expect(schemaChoiceTopic("flowControl")).toBe("flowControl");
    expect(schemaChoiceTopic("preferredEncoding")).toBe("preferredEncoding");
    expect(schemaChoiceTopic("securityMode")).toBe("securityMode");
    expect(schemaChoiceTopic("jumpHostSource")).toBeUndefined();
    expect(schemaChoiceTopic("authMethod")).toBeUndefined();
  });
});
