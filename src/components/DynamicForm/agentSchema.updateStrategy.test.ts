import { describe, it, expect } from "vitest";
import { AGENT_SCHEMA } from "./agentSchema";
import { buildDefaults } from "@/utils/schemaDefaults";

/**
 * Regression tests for the remote-agent update-strategy settings (#1354).
 *
 * The two fields live in the DynamicForm-driven AGENT_SCHEMA so they round-trip
 * through the connection editor and persist with the rest of the transport
 * config. Defaults must be `updateStrategy: "immediate"` and
 * `allowSelfUpdate: false` (opt-in).
 */
describe("AGENT_SCHEMA update settings", () => {
  const allFields = AGENT_SCHEMA.groups.flatMap((g) => g.fields);
  const updateStrategy = allFields.find((f) => f.key === "updateStrategy");
  const allowSelfUpdate = allFields.find((f) => f.key === "allowSelfUpdate");

  it("exposes an updateStrategy select with immediate/coordinated/deferred", () => {
    expect(updateStrategy).toBeDefined();
    expect(updateStrategy?.fieldType.type).toBe("select");
    if (updateStrategy?.fieldType.type === "select") {
      expect(updateStrategy.fieldType.options.map((o) => o.value)).toEqual([
        "immediate",
        "coordinated",
        "deferred",
      ]);
    }
  });

  it("exposes an allowSelfUpdate boolean toggle", () => {
    expect(allowSelfUpdate).toBeDefined();
    expect(allowSelfUpdate?.fieldType.type).toBe("boolean");
  });

  it("defaults updateStrategy to immediate and allowSelfUpdate to false", () => {
    const defaults = buildDefaults(AGENT_SCHEMA);
    expect(defaults.updateStrategy).toBe("immediate");
    expect(defaults.allowSelfUpdate).toBe(false);
  });
});
