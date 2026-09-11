import { describe, it, expect } from "vitest";
import { AGENT_SCHEMA } from "./agentSchema";
import { buildDefaults } from "@/utils/schemaDefaults";
import type { RemoteAgentConfig } from "@/types/terminal";

/**
 * Tests for the remote-agent update settings exposed in AGENT_SCHEMA (#1354).
 *
 * WA-FE-002: the "Allow agent self-update" toggle (SI-8) and the "Deferred"
 * update strategy (SI-6) are not implemented, so they were removed from the
 * rendered form — a persisted-but-inert preference is a trust defect. Only the
 * active options remain. The type fields are kept for forward-compat + tolerant
 * loading of existing configs that already persisted the removed values.
 */
describe("AGENT_SCHEMA update settings", () => {
  const allFields = AGENT_SCHEMA.groups.flatMap((g) => g.fields);
  const updateStrategy = allFields.find((f) => f.key === "updateStrategy");
  const allowSelfUpdate = allFields.find((f) => f.key === "allowSelfUpdate");

  it("exposes an updateStrategy select with only the active options (no deferred)", () => {
    expect(updateStrategy).toBeDefined();
    expect(updateStrategy?.fieldType.type).toBe("select");
    if (updateStrategy?.fieldType.type === "select") {
      expect(updateStrategy.fieldType.options.map((o) => o.value)).toEqual([
        "immediate",
        "coordinated",
      ]);
    }
  });

  it("does NOT expose the non-functional allowSelfUpdate toggle (WA-FE-002)", () => {
    expect(allowSelfUpdate).toBeUndefined();
  });

  it("ships no 'not yet implemented' wording in any rendered description", () => {
    const descriptions = allFields.map((f) => f.description ?? "").join("\n");
    expect(descriptions).not.toMatch(/not yet implemented/i);
    expect(descriptions).not.toMatch(/takes effect once it lands/i);
  });

  it("defaults updateStrategy to immediate and seeds no allowSelfUpdate key", () => {
    const defaults = buildDefaults(AGENT_SCHEMA);
    expect(defaults.updateStrategy).toBe("immediate");
    // The toggle is gone from the schema, so new configs must not seed the key.
    expect("allowSelfUpdate" in defaults).toBe(false);
  });

  it("preserves an existing config that carries the removed values (data safety)", () => {
    // Mimics how the connection editor seeds the form: the stored config is
    // spread over the schema defaults. A config saved before the controls were
    // hidden still carries allowSelfUpdate/deferred; these must round-trip
    // untouched even though the form no longer renders them.
    const stored: RemoteAgentConfig = {
      host: "192.168.1.100",
      port: 22,
      username: "pi",
      authMethod: "password",
      allowSelfUpdate: true,
      updateStrategy: "deferred",
    };
    const seeded = { ...buildDefaults(AGENT_SCHEMA), ...stored };
    expect(seeded.allowSelfUpdate).toBe(true);
    expect(seeded.updateStrategy).toBe("deferred");
  });
});
