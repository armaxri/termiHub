import { describe, it, expect } from "vitest";
import { settingsSchemaToZod } from "./settingsSchemaToZod";
import type { SettingsSchema } from "@/types/schema";

function makeSchema(fields: SettingsSchema["groups"][0]["fields"]): SettingsSchema {
  return { groups: [{ key: "g", label: "Group", fields }] };
}

describe("settingsSchemaToZod", () => {
  describe("port field", () => {
    it("accepts valid ports (1–65535)", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "port", label: "Port", fieldType: { type: "port" }, required: true }])
      );
      expect(zod.safeParse({ port: 1 }).success).toBe(true);
      expect(zod.safeParse({ port: 22 }).success).toBe(true);
      expect(zod.safeParse({ port: 65535 }).success).toBe(true);
    });

    it("rejects port 0 and 65536", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "port", label: "Port", fieldType: { type: "port" }, required: true }])
      );
      expect(zod.safeParse({ port: 0 }).success).toBe(false);
      expect(zod.safeParse({ port: 65536 }).success).toBe(false);
    });

    it("rejects non-integer port", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "port", label: "Port", fieldType: { type: "port" }, required: true }])
      );
      expect(zod.safeParse({ port: 22.5 }).success).toBe(false);
    });

    it("optional port accepts undefined", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "port", label: "Port", fieldType: { type: "port" }, required: false }])
      );
      expect(zod.safeParse({}).success).toBe(true);
      expect(zod.safeParse({ port: undefined }).success).toBe(true);
      expect(zod.safeParse({ port: 22 }).success).toBe(true);
      expect(zod.safeParse({ port: 0 }).success).toBe(false);
    });
  });

  describe("number field", () => {
    it("applies min and max bounds", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          {
            key: "timeout",
            label: "Timeout",
            fieldType: { type: "number", min: 0, max: 300 },
            required: true,
          },
        ])
      );
      expect(zod.safeParse({ timeout: 0 }).success).toBe(true);
      expect(zod.safeParse({ timeout: 300 }).success).toBe(true);
      expect(zod.safeParse({ timeout: -1 }).success).toBe(false);
      expect(zod.safeParse({ timeout: 301 }).success).toBe(false);
    });

    it("optional number accepts undefined", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          {
            key: "timeout",
            label: "Timeout",
            fieldType: { type: "number", min: 0 },
            required: false,
          },
        ])
      );
      expect(zod.safeParse({}).success).toBe(true);
      expect(zod.safeParse({ timeout: 30 }).success).toBe(true);
    });
  });

  describe("text field", () => {
    it("required text field rejects empty string", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }])
      );
      expect(zod.safeParse({ host: "" }).success).toBe(false);
      expect(zod.safeParse({ host: "example.com" }).success).toBe(true);
    });

    it("optional text field accepts undefined and empty string", () => {
      const zod = settingsSchemaToZod(
        makeSchema([{ key: "host", label: "Host", fieldType: { type: "text" }, required: false }])
      );
      expect(zod.safeParse({}).success).toBe(true);
      expect(zod.safeParse({ host: "" }).success).toBe(true);
    });
  });

  describe("password field", () => {
    it("required password rejects empty string", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          { key: "pass", label: "Password", fieldType: { type: "password" }, required: true },
        ])
      );
      expect(zod.safeParse({ pass: "" }).success).toBe(false);
      expect(zod.safeParse({ pass: "secret" }).success).toBe(true);
    });
  });

  describe("boolean field", () => {
    it("accepts true/false and undefined", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          { key: "flag", label: "Flag", fieldType: { type: "boolean" }, required: false },
        ])
      );
      expect(zod.safeParse({ flag: true }).success).toBe(true);
      expect(zod.safeParse({ flag: false }).success).toBe(true);
      expect(zod.safeParse({}).success).toBe(true);
    });
  });

  describe("select field", () => {
    it("accepts any string", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          {
            key: "auth",
            label: "Auth",
            fieldType: { type: "select", options: [{ value: "key", label: "Key" }] },
            required: true,
          },
        ])
      );
      expect(zod.safeParse({ auth: "key" }).success).toBe(true);
      expect(zod.safeParse({ auth: "password" }).success).toBe(true);
    });
  });

  describe("keyValueList field", () => {
    it("accepts array of key-value pairs and undefined", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          { key: "env", label: "Env", fieldType: { type: "keyValueList" }, required: false },
        ])
      );
      expect(zod.safeParse({ env: [{ key: "A", value: "1" }] }).success).toBe(true);
      expect(zod.safeParse({ env: [] }).success).toBe(true);
      expect(zod.safeParse({}).success).toBe(true);
    });
  });

  describe("objectList field", () => {
    it("accepts array of objects and undefined", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          {
            key: "volumes",
            label: "Volumes",
            fieldType: { type: "objectList", fields: [] },
            required: false,
          },
        ])
      );
      expect(zod.safeParse({ volumes: [{ host: "/a", container: "/b" }] }).success).toBe(true);
      expect(zod.safeParse({ volumes: [] }).success).toBe(true);
      expect(zod.safeParse({}).success).toBe(true);
    });
  });

  describe("multiple fields", () => {
    it("validates all fields in the schema", () => {
      const zod = settingsSchemaToZod(
        makeSchema([
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "port", label: "Port", fieldType: { type: "port" }, required: true },
        ])
      );
      expect(zod.safeParse({ host: "example.com", port: 22 }).success).toBe(true);
      expect(zod.safeParse({ host: "", port: 22 }).success).toBe(false);
      expect(zod.safeParse({ host: "example.com", port: 0 }).success).toBe(false);
    });

    it("collects fields from all groups", () => {
      const schema: SettingsSchema = {
        groups: [
          {
            key: "g1",
            label: "G1",
            fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: true }],
          },
          {
            key: "g2",
            label: "G2",
            fields: [{ key: "port", label: "Port", fieldType: { type: "port" }, required: true }],
          },
        ],
      };
      const zod = settingsSchemaToZod(schema);
      expect(zod.safeParse({ host: "example.com", port: 22 }).success).toBe(true);
      expect(zod.safeParse({ host: "example.com", port: 0 }).success).toBe(false);
    });
  });
});
